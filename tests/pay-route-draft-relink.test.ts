/**
 * Step 0 Q16 (build-changes B.2): a draft pay link keeps working after its
 * draft was minted and consumed. Before: a capture failure after the mint left
 * /pay/<draftId> answering 404 expired_or_used (the OTP phone resolved from the
 * consumed draft or a transfer with the DRAFT's id, and neither exists). Now
 * the route follows the `draft:<draftId>` idempotency claim to the transfer the
 * draft became, and answers exactly as that transfer's own link would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createDraftStore } from '@/lib/draft-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
const sendTransactionOtp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/whatsapp', () => ({
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTransactionOtp,
  sendTemplate: vi.fn().mockResolvedValue(undefined),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let draftStore: ReturnType<typeof createDraftStore>;
let dailyVolumeStore: ReturnType<typeof createDailyVolumeStore>;
let monthlyVolumeStore: ReturnType<typeof createMonthlyVolumeStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;

vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/draft-store', async (orig) => ({ ...(await orig<typeof import('@/lib/draft-store')>()), getDraftStore: () => draftStore }));
vi.mock('@/lib/daily-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/daily-volume-store')>()), getDailyVolumeStore: () => dailyVolumeStore }));
vi.mock('@/lib/monthly-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/monthly-volume-store')>()), getMonthlyVolumeStore: () => monthlyVolumeStore }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  return { ...real, getPartnerStore: () => real.createPartnerStore(db) };
});
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return { ...real, getFundingProvider: () => ({ capture, refund: vi.fn(), handleWebhook: vi.fn() }) };
});

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';
const CODE = '654321';

function post(id: string, body: unknown): Promise<Response> {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
}

function makeDraft(): Promise<string> {
  return draftStore.createDraft({
    senderPhone: PHONE,
    partnerId: 'default',
    recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234' },
    amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', fundingMethod: 'bank_transfer',
    quote: { feeUsd: 0, fxRate: 85, amountInr: 17000, feeSource: 0, totalChargeSource: 200, totalChargeUsd: 200, fxFetchedAt: Date.now() },
  });
}
const mintedId = (draftId: string) => createIdempotencyRepo(db).find(DEFAULT_PARTNER_ID, `draft:${draftId}`);

/** The production failure: the first pay POST mints the transfer, then the capture throws (402). */
async function mintThenFailCapture(): Promise<{ draftId: string; transferId: string }> {
  const draftId = await makeDraft();
  expect((await (await post(draftId, { action: 'request_otp' })).json()).sent).toBe(true);
  capture.mockRejectedValueOnce(new Error('card declined'));
  const first = await post(draftId, { otp: CODE });
  expect(first.status).toBe(402);
  const transferId = await mintedId(draftId);
  expect(transferId).not.toBeNull();
  expect(await draftStore.getDraft(draftId)).toBeNull(); // consumed after the mint
  return { draftId, transferId: transferId! };
}

beforeEach(async () => {
  db = await freshDb();
  const redis = fakeRedis();
  store = createStore(redis, db);
  customerStore = createCustomerStore(db, store);
  draftStore = createDraftStore(redis);
  dailyVolumeStore = createDailyVolumeStore(store);
  monthlyVolumeStore = createMonthlyVolumeStore(store);
  txOtp = createTransactionOtpStore(redis, { randomInt: () => 654321 });
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso, fullName: 'Alex Rivera', createdAt: nowIso, updatedAt: nowIso,
  });
  sendTransactionOtp.mockClear();
  capture.mockReset().mockImplementation(async (t: { id: string }) => ({ fundingRef: `mockfund-${t.id}` }));
});

describe('POST /api/pay/<draftId> after the draft was minted and consumed', () => {
  it('request_otp sends a code to the TRANSFER\'s phone (was: 404 expired_or_used)', async () => {
    const { draftId } = await mintThenFailCapture();
    sendTransactionOtp.mockClear();
    const res = await post(draftId, { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(true);
    expect(sendTransactionOtp).toHaveBeenCalledTimes(1);
    expect(sendTransactionOtp.mock.calls[0][0]).toBe(PHONE);
  });

  it('a pay re-POST converges on the SAME transfer: no second mint, one successful charge, paid', async () => {
    const { draftId, transferId } = await mintThenFailCapture();
    await post(draftId, { action: 'request_otp' });
    const res = await post(draftId, { otp: CODE });
    expect(res.status).toBe(200);
    expect(await store.listTransfers()).toHaveLength(1);
    expect((await store.getTransfer(transferId))?.status).toBe('paid');
    // Both capture attempts (the failed one, then this one) named the same transfer.
    expect(capture.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([transferId, transferId]);
    expect((await store.getTransfer(transferId))?.fundingRef).toBe(`mockfund-${transferId}`);
  });

  it('a further POST after success answers the transfer\'s current truth, never a second charge', async () => {
    const { draftId } = await mintThenFailCapture();
    await post(draftId, { action: 'request_otp' });
    await post(draftId, { otp: CODE });
    // A fresh code store (no resend cooldown) so the next POST reaches the status gate.
    txOtp = createTransactionOtpStore(fakeRedis(), { randomInt: () => 654321 });
    await txOtp.issue((await mintedId(draftId))!, PHONE);
    const again = await post(draftId, { otp: CODE });
    expect(await again.json()).toEqual({ ok: true, status: 'paid' });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('a code issued for the draft link verifies against the transfer it became (the same link, both steps)', async () => {
    const { draftId, transferId } = await mintThenFailCapture();
    await post(draftId, { action: 'request_otp' });
    // The transfer's own link accepts the same code: both resolve to one id.
    const res = await post(transferId, { otp: CODE });
    expect(res.status).toBe(200);
    expect((await store.getTransfer(transferId))?.status).toBe('paid');
  });

  it('a minted transfer that was cancelled answers like its own link (200 cancelled), no code check needed for truth', async () => {
    const { draftId, transferId } = await mintThenFailCapture();
    await db.execute(sql`UPDATE transfers SET status = 'cancelled' WHERE id = ${transferId}`);
    await post(draftId, { action: 'request_otp' });
    const res = await post(draftId, { otp: CODE });
    expect(await res.json()).toEqual({ ok: true, status: 'cancelled' });
    expect(capture).toHaveBeenCalledTimes(1); // only the original failed attempt
  });

  it('keeps the sandbox refusal: a test-environment row behind the claim is still 404', async () => {
    const { draftId, transferId } = await mintThenFailCapture();
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${transferId}`);
    sendTransactionOtp.mockClear();
    const res = await post(draftId, { action: 'request_otp' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('expired_or_used');
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it('an unknown id with no claim is still 404 expired_or_used', async () => {
    const res = await post('nosuchdraft_123', { action: 'request_otp' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('expired_or_used');
  });

  it('a claim held by ANOTHER tenant is never followed (only draft:<id> under the default tenant)', async () => {
    const { seedPartner } = await import('./helpers-db');
    await seedPartner(db, 'acme');
    const { transferId } = await mintThenFailCapture();
    await createIdempotencyRepo(db).claim('acme', 'draft:foreign_1', transferId);
    const res = await post('foreign_1', { action: 'request_otp' });
    expect(res.status).toBe(404);
  });
});
