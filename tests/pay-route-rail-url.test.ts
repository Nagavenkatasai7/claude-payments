/**
 * Program-Fix 22 (Task 12), acceptance test 13 — pay time, never charged.
 * Gate #2 of the ruling-7 route contract: an `http` / `simulator` rail (owner
 * OR routed) whose settlement URL fails the sync rule answers 400 "Payment
 * failed" BEFORE captureFunding, and the transfer stays awaiting_payment. A
 * mock owner rail is unaffected. Fix pack 2 T10: the URL checked is the one
 * the worker POSTs to (settlementTargetUrl): a simulator rail's is always the
 * hosted rail, whatever is stored.
 */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifyPartnerForTest } from './helpers-live';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import type { Transfer } from '@/lib/types';
import { LIST_UNAVAILABLE_REASON } from '@/lib/compliance-config';
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
import { processTransferPayment } from '@/lib/pay-process';

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

const PUBLIC_RAIL = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } } as const;
/**
 * Pack 3: a non-default owner 'acme' on a public http rail (the rail type also stored, as
 * live-gate.ts reads it), with its own sender on file. Certified unless `certify: false`.
 */
async function acmeOnHttp(o: { certify?: boolean } = {}): Promise<void> {
  await seedPartner(db, 'acme');
  if (o.certify ?? true) await certifyPartnerForTest(db, 'acme');
  rails.byPartner.acme = { ...PUBLIC_RAIL, credentials: { ...PUBLIC_RAIL.credentials } };
  await setRailProviderType(db, 'acme', 'http');
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified', fullName: 'Test Sender',
    senderCountry: 'US', partnerId: 'acme', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  });
}

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

  it('OWNER rail simulator with an empty stored URL is charged: it settles on the hosted rail (fix pack 2 T10)', async () => {
    rails.byPartner.default = { providerType: 'simulator', credentials: { signingSecret: 's' } };
    await store.saveTransfer(makeTransfer({ id: 'u2' }));
    expect((await post('u2')).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await store.getTransfer('u2'))?.status).toBe('paid');
  });

  it('a routed simulator rail with an off-origin stored URL is not refused (the hosted URL is what is checked)', async () => {
    // Fix pack 2 T10: the worker POSTs a simulator instruct only to the hosted
    // rail, so the stored URL (refused by the sync rule) is never the target.
    rails.byPartner.railp = { providerType: 'simulator', credentials: { settlementUrl: 'http://10.0.0.5/settle', signingSecret: 's' } };
    await store.saveTransfer(makeTransfer({ id: 'r2', settlementPartnerId: 'railp' }));
    const res = await post('r2');
    expect(res.status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await store.getTransfer('r2'))?.status).toBe('paid');
    const kinds = ((await db.execute(sql`SELECT kind FROM outbox`)) as unknown as { rows: Array<{ kind: string }> }).rows.map((r) => r.kind);
    expect(kinds).toContain('settlement.instruct');
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
    // Pack 3: the owner is a certified non-default partner (the default tenant may never own a
    // real-money transfer, and an uncertified rail is refused at pay time).
    await acmeOnHttp();
    await store.saveTransfer(makeTransfer({ id: 'g1', partnerId: 'acme' }));
    // Fix pack 2 T9: an http rail settles only on a live, fresh screen; the
    // pay-time re-screen runs on a live OFAC list (checked an hour ago).
    const originalList = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    onTestFinished(() => restoreOfacSource(originalList));
    const res = await post('g1');
    expect(res.status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await store.getTransfer('g1'))?.status).toBe('paid');
  });

  it('a PUBLIC https owner rail with a STALE list → charged, held in_review, never instructed (fix pack 2 T3)', async () => {
    await acmeOnHttp();
    const originalList = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 37 * 3_600_000 });
    onTestFinished(() => restoreOfacSource(originalList));
    await store.saveTransfer(makeTransfer({ id: 's1', partnerId: 'acme' }));
    const res = await post('s1');
    expect(res.status).toBe(200);
    const t = await store.getTransfer('s1');
    expect(t?.status).toBe('in_review');
    expect(t?.complianceReasons).toContain(LIST_UNAVAILABLE_REASON);
    const kinds = ((await db.execute(sql`SELECT kind FROM outbox`)) as unknown as { rows: Array<{ kind: string }> }).rows.map((r) => r.kind);
    expect(kinds).not.toContain('settlement.instruct');
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

// Pack 3 (contract 6): an EXISTING awaiting_payment transfer on an uncertified real-money rail (or
// a default-tenant transfer on one) is refused at pay time BEFORE any capture: 409 not_available,
// nothing charged, nothing written, the row still awaiting_payment. The gate uses the integrations
// the route already read (no second rail-type read). It sits after the URL check.
describe('pay time — live certification (pack 3)', { retry: 0 }, () => {
  const NOT_AVAILABLE = { ok: false, error: expect.any(String), reason: 'not_available' };
  const liveList = () => {
    const originalList = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    onTestFinished(() => restoreOfacSource(originalList));
  };

  it('uncertified non-default http owner, public URL -> 409 PAY_NOT_AVAILABLE body, never charged, still awaiting_payment, no outbox row', async () => {
    await acmeOnHttp({ certify: false });
    liveList();
    await store.saveTransfer(makeTransfer({ id: 'lc1', partnerId: 'acme' }));
    const res = await post('lc1');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_AVAILABLE);
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('lc1'))?.status).toBe('awaiting_payment');
    expect(await outboxCount()).toBe(0);
  });

  it('the same owner certified -> charged and settles', async () => {
    await acmeOnHttp();
    liveList();
    await store.saveTransfer(makeTransfer({ id: 'lc2', partnerId: 'acme' }));
    const res = await post('lc2');
    expect(res.status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await store.getTransfer('lc2'))?.status).toBe('paid');
  });

  it('a default-owner transfer on an http rail -> 409, never charged', async () => {
    rails.byPartner.default = { ...PUBLIC_RAIL, credentials: { ...PUBLIC_RAIL.credentials } };
    await setRailProviderType(db, 'default', 'http');
    liveList();
    await store.saveTransfer(makeTransfer({ id: 'lc3' }));
    const res = await post('lc3');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(NOT_AVAILABLE);
    expect(capture).not.toHaveBeenCalled();
    expect((await store.getTransfer('lc3'))?.status).toBe('awaiting_payment');
    expect(await outboxCount()).toBe(0);
  });

  it('a sandbox transfer is untouched by the gate', async () => {
    // The hosted page 404s a sandbox row before pay-process (pay-route-rescreen pins that), so
    // the shared pay steps are called directly: an uncertified http rail does not refuse it.
    await acmeOnHttp({ certify: false });
    const t = makeTransfer({ id: 'lc4', partnerId: 'acme', environment: 'test' });
    await store.saveTransfer(t);
    const res = await processTransferPayment(store, t);
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a mock/simulator owner rail is untouched', async () => {
    await seedPartner(db, 'acme');
    const nowIso = new Date().toISOString();
    await customerStore.saveCustomer({
      senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified', fullName: 'Test Sender',
      senderCountry: 'US', partnerId: 'acme', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
    });
    rails.byPartner.acme = { providerType: 'simulator', credentials: { signingSecret: 's' } };
    await setRailProviderType(db, 'acme', 'simulator');
    await store.saveTransfer(makeTransfer({ id: 'lc5', partnerId: 'acme' }));
    expect((await post('lc5')).status).toBe(200);
    rails.byPartner.default = { providerType: 'mock' };
    await store.saveTransfer(makeTransfer({ id: 'lc6' }));
    expect((await post('lc6')).status).toBe(200);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('a bad URL is still refused by the URL check first (400 Payment failed)', async () => {
    await acmeOnHttp({ certify: false });
    rails.byPartner.acme = { providerType: 'http', credentials: { settlementUrl: 'http://10.0.0.5/settle', signingSecret: 's' } };
    await store.saveTransfer(makeTransfer({ id: 'lc7', partnerId: 'acme' }));
    const res = await post('lc7');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'Payment failed' });
    expect(capture).not.toHaveBeenCalled();
  });
});
