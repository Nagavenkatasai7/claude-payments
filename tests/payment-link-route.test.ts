/**
 * Batch B2: POST /api/pay/l/[token]. The switch off / not a demo phone ⇒ the
 * one 404 and no code sent; the code gates the payment; a paid link becomes
 * ONE paid transfer (same capture + settle path as the hosted pay page).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { createLinkQuoteStore } from '@/lib/payment-link-quote';
import { invalidateFlagCache } from '@/lib/flags';
import { DISCLOSURE_DRAFT_VERSION } from '@/lib/legal/disclosure-drafts';
import { linkExpiresAt, newLinkToken } from '@/lib/payment-links';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Customer } from '@/lib/types';

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
let partnerStore: ReturnType<typeof createPartnerStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
let quotes: ReturnType<typeof createLinkQuoteStore>;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => partnerStore }));
vi.mock('@/lib/monthly-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/monthly-volume-store')>()), getMonthlyVolumeStore: () => createMonthlyVolumeStore(store) }));
vi.mock('@/lib/daily-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/daily-volume-store')>()), getDailyVolumeStore: () => createDailyVolumeStore(store) }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
vi.mock('@/lib/payment-link-quote', async (orig) => ({ ...(await orig<typeof import('@/lib/payment-link-quote')>()), getLinkQuoteStore: () => quotes }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST } from '@/app/api/pay/l/[token]/route';

const PHONE = '14155550100';
const T0 = '2026-05-01T00:00:00.000Z';

let token: string;
let linkId: string;
let lockedAt: string; // the lock identity the page rendered (LinkPayForm posts it back)
let redis: ReturnType<typeof fakeRedis>;

const req = (b: object) =>
  new NextRequest(`http://x/api/pay/l/${token}`, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const call = (b: object, t = token) => POST(req(b), { params: Promise.resolve({ token: t }) });
const count = async (q: string) => Number(((await db.execute(sql.raw(q))) as unknown as { rows: Array<{ n: number }> }).rows[0].n);

async function flag(enabled: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'paylinks.enabled', scopeType: 'global', scopeId: '', enabled, reason: 't', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

beforeEach(async () => {
  vi.stubEnv('DEMO_PHONES', '*');
  const r = fakeRedis();
  redis = r;
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(r, db);
  customerStore = createCustomerStore(db, store);
  partnerStore = createPartnerStore(db);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  quotes = createLinkQuoteStore(r);
  await flag(true);
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Asha Patel', senderCountry: 'US',
    partnerId: 'default', createdAt: T0, updatedAt: T0,
  } as Customer);
  const payees = createPayeeRepo(db);
  await payees.insert({
    id: 'pye_1', partnerId: 'default', legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
    payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
  });
  await payees.decide('pye_1', ['pending'], 'approved', 'admin');
  token = newLinkToken();
  linkId = 'pl_route1';
  await createPaymentLinkRepo(db).insertLinks([{
    id: linkId, partnerId: 'default', payeeId: 'pye_1', token, reference: 'INV-77', customerName: 'Asha Patel',
    customerPhone: PHONE, amountInr: 25000, purpose: 'education', expiresAt: linkExpiresAt(), createdBy: 'pa',
  }]);
  lockedAt = (await quotes.lock(linkId, { toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' })).lockedAt;
  sendTransactionOtp.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/pay/l/[token]', () => {
  it('request_otp sends a code to the link phone (SmartRemit wording), nothing minted', async () => {
    const res = await call({ action: 'request_otp' });
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', undefined, undefined, undefined, expect.any(Object));
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });

  it('switch off ⇒ the one 404, no code sent, nothing saved', async () => {
    await flag(false);
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('This payment link is no longer active.');
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    const pay = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(pay.status).toBe(404);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });

  it('not a demo phone ⇒ the same 404, no code sent', async () => {
    vi.stubEnv('DEMO_PHONES', '19998887777');
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(404);
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it('an unknown or malformed token ⇒ the same 404', async () => {
    expect((await call({ action: 'request_otp' }, 'nope')).status).toBe(404);
    expect((await call({ action: 'request_otp' }, newLinkToken())).status).toBe(404);
  });

  it('a wrong or missing code ⇒ 403, nothing minted, the link stays open', async () => {
    await call({ action: 'request_otp' });
    expect((await call({ otp: '000000', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt })).status).toBe(403);
    expect((await call({ fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt })).status).toBe(403);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM payment_links WHERE status = 'open'`)).toBe(1);
  });

  it('no funding method ⇒ 400 before the code is checked', async () => {
    await call({ action: 'request_otp' });
    expect((await call({ otp: '654321', quoteLockedAt: lockedAt })).status).toBe(400);
    // The code was not burned: the real pay still works.
    expect((await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt })).status).toBe(200);
  });

  it('no locked rate ⇒ 409 quote_expired, the code not burned', async () => {
    quotes = createLinkQuoteStore(fakeRedis());
    await call({ action: 'request_otp' });
    const res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('quote_expired');
  });

  it('the right code ⇒ ONE paid transfer to the payee; a replay reports it, never a second', async () => {
    await call({ action: 'request_otp' });
    const res = await call({ otp: '654321', fundingMethod: 'debit_card', disclosureVersion: DISCLOSURE_DRAFT_VERSION, quoteLockedAt: lockedAt });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const t = await store.getTransfer(body.transferId);
    expect(t).toMatchObject({ status: 'paid', amountInr: 25000, feeUsd: 2.99, clientReference: 'INV-77', purpose: 'education' });
    expect(await count(`SELECT count(*)::int AS n FROM payment_links WHERE status = 'used' AND transfer_id = '${body.transferId}'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'remittance.disclosure_ack' AND subject_id = '${body.transferId}'`)).toBe(1);
    // The link is used and paid: the same 404 as any other unpayable link.
    expect((await call({ action: 'request_otp' })).status).toBe(404);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(1);
  });

  it('the lock the page showed: a missing or different lock ⇒ 409 quote_expired, nothing minted, the code not burned', async () => {
    await call({ action: 'request_otp' });
    for (const quoteLockedAt of [undefined, '', '2026-01-01T00:00:00.000Z', 42]) {
      const res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe('quote_expired');
    }
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
    // The matching lock pays (the code was never spent on a refusal).
    const ok = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(ok.status).toBe(200);
    expect((await store.getTransfer((await ok.json()).transferId))?.fxRate).toBe(85);
  });

  it('an old tab after the lock lapsed and a later visit locked a NEW rate ⇒ 409, never charged at the new rate', async () => {
    // 16 minutes later: the old lock has lapsed; a new page view locks 90.
    const later = createLinkQuoteStore(redis, { now: () => Date.now() + 16 * 60_000 });
    expect(await later.get(linkId)).toBeNull();
    const fresh = await later.lock(linkId, { toInr: 90, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' });
    quotes = later;
    expect(fresh.lockedAt).not.toBe(lockedAt);
    await call({ action: 'request_otp' });
    const stale = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(stale.status).toBe(409);
    expect((await stale.json()).reason).toBe('quote_expired');
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });
});
