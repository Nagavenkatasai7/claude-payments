/**
 * fix 6 (ctx-01) at the HTTP boundary, DRAFT branch. Every other pay-route suite
 * mocks getDraft → null; this one drives the real finalizeDraftPayment through
 * the route.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Draft } from '@/lib/types';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
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

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let draftStore: ReturnType<typeof createDraftStore>;
let dailyVolumeStore: ReturnType<typeof createDailyVolumeStore>;
let monthlyVolumeStore: ReturnType<typeof createMonthlyVolumeStore>;

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
vi.mock('@/lib/draft-store', async (orig) => {
  const real = await orig<typeof import('@/lib/draft-store')>();
  return { ...real, getDraftStore: () => draftStore };
});
vi.mock('@/lib/daily-volume-store', async (orig) => {
  const real = await orig<typeof import('@/lib/daily-volume-store')>();
  return { ...real, getDailyVolumeStore: () => dailyVolumeStore };
});
vi.mock('@/lib/monthly-volume-store', async (orig) => {
  const real = await orig<typeof import('@/lib/monthly-volume-store')>();
  return { ...real, getMonthlyVolumeStore: () => monthlyVolumeStore };
});
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  return { ...real, getPartnerStore: () => real.createPartnerStore(db) };
});
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }),
  }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';

function post(id: string, body?: unknown): Promise<Response> {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
}

function makeDraftWith(dest: string, over: Partial<Draft> = {}): Promise<string> {
  return draftStore.createDraft({
    senderPhone: PHONE,
    partnerId: 'default',
    recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: dest },
    amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 17000, feeSource: 0, totalChargeSource: 200, totalChargeUsd: 200 },
    ...over,
  });
}
const minted = (draftId: string) => createIdempotencyRepo(db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`);

beforeEach(async () => {
  db = await freshDb();
  const redis = fakeRedis();
  store = createStore(redis, db);
  customerStore = createCustomerStore(db, store);
  draftStore = createDraftStore(redis);
  dailyVolumeStore = createDailyVolumeStore(store);
  monthlyVolumeStore = createMonthlyVolumeStore(store);
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
  });
});

describe('POST /api/pay/<draftId> — fix 6 (ctx-01)', () => {
  it('a bodyless POST on a masked draft answers 400 bank_details_required and mutates nothing', async () => {
    const draftId = await makeDraftWith('****9012');
    const res = await post(draftId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; reason?: string; error?: string };
    expect(body.reason).toBe('bank_details_required');
    expect(body.error ?? '').not.toContain('9012');
    expect(await store.listTransfers()).toHaveLength(0);
    expect(await minted(draftId)).toBeNull();
    expect(await draftStore.getDraft(draftId)).not.toBeNull();
  });

  it('the same link then finalizes and charges once real fields are posted', async () => {
    const draftId = await makeDraftWith('****9012');
    expect((await post(draftId)).status).toBe(400);
    const res = await post(draftId, { country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' } });
    expect(res.status).toBe(200);
    const full = await store.getTransferDecrypted((await minted(draftId))!);
    expect(full?.payoutDestination).toContain('123456789012');
    expect(full?.status).toBe('paid');
  });

  it('Edit bank details on a PREFILLED consumer draft: posted fields replace the rehydrated destination', async () => {
    const draftId = await makeDraftWith('HDFC0001234 123456789012');
    expect((await post(draftId, { country: 'IN', fields: { accountNumber: '987654321098', ifsc: 'SBIN0001234' } })).status).toBe(200);
    expect((await store.getTransferDecrypted((await minted(draftId))!))?.payoutDestination).toContain('987654321098');
  });

  it('a crafted {ach, country, fields} POST on a B2B ach_pull draft NEVER sets the payee: minted with no destination, mandate bound', async () => {
    const draftId = await makeDraftWith('', {
      recipient: { name: 'Globex Trading LLC', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 400, amountSource: 400, fundingMethod: 'ach_pull',
      quote: { feeUsd: 1.99, fxRate: 85, amountInr: 34000 },
      transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Acme Imports Ltd', recipientBusinessName: 'Globex Trading LLC', invoiceId: 'inv_u1',
    });
    const res = await post(draftId, {
      ach: { routingNumber: '021000021', accountNumber: '1234567890', accountType: 'checking' },
      country: 'IN', fields: { accountNumber: '999999999999', ifsc: 'SBIN0009999' },
    });
    expect(res.status).toBe(200);
    const full = await store.getTransferDecrypted((await minted(draftId))!);
    expect(full?.payoutDestination).toBe('');
    expect(full?.achTokenRef).toMatch(/^ach_[0-9a-f]+$/);
  });
});
