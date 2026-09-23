/**
 * Program-Fix 22 (Task 12), acceptance test 13 — pay time, never charged.
 * Gate #2 of the ruling-7 route contract: an `http` / `simulator` rail (owner
 * OR routed) whose settlement URL fails the sync rule answers 400 "Payment
 * failed" BEFORE captureFunding, and the transfer stays awaiting_payment. A
 * mock owner rail is unaffected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer } from '@/lib/types';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: () => {} };
});
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp: vi.fn().mockResolvedValue(undefined),
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: async () => ({ ok: true }),
  }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return { ...real, getCustomerStore: () => customerStore };
});
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      requireKycBeforeSend: true,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));

// Per-partner rail config, mutable per test.
const rails = vi.hoisted(() => ({ byPartner: {} as Record<string, PartnerIntegrations['payment']> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, whatsapp: {}, payment: rails.byPartner[id] ?? {} }),
  }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return {
    ...real,
    getFundingProvider: () => ({ capture: (...a: unknown[]) => capture(...a), refund: vi.fn(), handleWebhook: vi.fn() }),
  };
});

import { POST } from '@/app/api/pay/[transferId]/route';

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '123456789 HDFC0001234',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date().toISOString(), sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}
function post(id: string) {
  const req = new NextRequest('http://localhost/api/pay/' + id, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ transferId: id }) });
}
const outboxCount = async () =>
  ((await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as { rows: Array<{ n: number }> }).rows[0].n;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified', fullName: 'Test Sender', // Program-Fix 14: a legal name on file
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  });
  await db.execute(sql`INSERT INTO partners (id, name, status, countries, kyc_mode)
    VALUES ('railp', 'railp', 'active', '["US"]'::jsonb, 'ours') ON CONFLICT (id) DO NOTHING`);
  rails.byPartner = {};
  capture.mockReset();
  capture.mockResolvedValue({ fundingRef: 'fund-abc' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => vi.unstubAllGlobals());

const BAD_URLS = ['http://10.0.0.5/settle', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://rail.acme.com:8443/x', '   '];

describe('pay route — settlement URL gate before capture (fix 22)', () => {
  it.each(BAD_URLS)('OWNER rail http with %j → 400 Payment failed, capture never called, status unchanged', async (url) => {
    rails.byPartner.default = { providerType: 'http', credentials: { settlementUrl: url, signingSecret: 's' } };
    await store.saveTransfer(makeTransfer({ id: 'u1' }));
    const res = await post('u1');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'Payment failed' });
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('u1'))?.status).toBe('awaiting_payment');
    expect(await outboxCount()).toBe(0);
  });

  it('OWNER rail simulator with an empty URL → 400 before capture (today it charges, then dead-letters)', async () => {
    rails.byPartner.default = { providerType: 'simulator', credentials: { signingSecret: 's' } };
    await store.saveTransfer(makeTransfer({ id: 'u2' }));
    expect((await post('u2')).status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('u2'))?.status).toBe('awaiting_payment');
  });

  it.each(BAD_URLS)('ROUTED rail http with %j → 400 before capture', async (url) => {
    rails.byPartner.railp = { providerType: 'http', credentials: { settlementUrl: url, signingSecret: 's' } };
    await store.saveTransfer(makeTransfer({ id: 'r1', settlementPartnerId: 'railp' }));
    const res = await post('r1');
    expect(res.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('r1'))?.status).toBe('awaiting_payment');
  });

  it('a PUBLIC https owner rail is charged and settles (the gate lets good config through)', async () => {
    rails.byPartner.default = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } };
    await store.saveTransfer(makeTransfer({ id: 'g1' }));
    const res = await post('g1');
    expect(res.status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await store.getTransfer('g1'))?.status).toBe('paid');
  });

  it('a MOCK owner rail is unaffected (no URL required)', async () => {
    rails.byPartner.default = { providerType: 'mock' };
    await store.saveTransfer(makeTransfer({ id: 'm1' }));
    expect((await post('m1')).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    // No provider configured at all (the default partner today) is the mock branch too.
    rails.byPartner = {};
    await store.saveTransfer(makeTransfer({ id: 'm2' }));
    expect((await post('m2')).status).toBe(200);
  });
});
