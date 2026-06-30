/**
 * Hosted seller-onboarding server action — the web-finish of register_seller.
 * Self-gates on the route id (re-loads + re-checks PENDING), requires an OTP
 * step-up bound to the seller's number, re-validates the payout bank fields
 * authoritatively, and only then encrypts the payout + flips ACTIVE. Mirrors the
 * pay-route mock pattern: PGlite-backed store + a fakeRedis-backed OTP store are
 * injected by mocking the module singletons.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { sellers } from '@/db/schema';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

const sendTransactionOtp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/whatsapp', () => ({ sendTransactionOtp }));

let db: Awaited<ReturnType<typeof freshDb>>;
let redis: ReturnType<typeof fakeRedis>;
let store: ReturnType<typeof createStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;

vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));
vi.mock('@/lib/ip-rate-limit', () => ({
  checkIpRateLimit: async () => ({ allowed: true, remaining: 1, limit: 20 }),
  clientIpFrom: () => '1.2.3.4',
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));

import { activateSellerAction, requestSellerOtpAction } from '@/app/onboard/seller/[id]/actions';

const PHONE = '85291234567'; // HK
const HK_FIELDS = { bankCode: '024', branchCode: '388', accountNumber: '12345678' };

async function seedPendingSeller(id = 's_hk1') {
  await store.createSeller({
    id, partnerId: 'default', phone: PHONE,
    businessName: 'Kowloon Design Co', country: 'HK', currency: 'HKD',
  });
  return id;
}

beforeEach(async () => {
  db = await freshDb();
  // sellers is outside freshDb's TRUNCATE set — clear it per test.
  await db.execute(sql`TRUNCATE sellers`);
  redis = fakeRedis();
  store = createStore(redis, db);
  txOtp = createTransactionOtpStore(redis);
  sendTransactionOtp.mockClear();
});

describe('activateSellerAction', () => {
  it('activates a pending seller given a valid OTP + payout, storing it ENCRYPTED', async () => {
    const id = await seedPendingSeller();
    const issued = await txOtp.issue(id, PHONE);
    if (!issued.ok) throw new Error('issue failed');

    const res = await activateSellerAction({ id, fields: HK_FIELDS, otp: issued.code });
    expect(res.ok).toBe(true);

    // Masked read: active + last4 only (no plaintext payout).
    const masked = await store.getSeller(PHONE, 'default');
    expect(masked?.status).toBe('active');
    expect(masked?.payoutLast4).toBe('5678');
    expect((masked as unknown as Record<string, unknown>).payoutDestination).toBeUndefined();

    // Decrypted read round-trips the canonical composed payout.
    const decrypted = await store.getSellerDecrypted(PHONE, 'default');
    expect(decrypted?.payoutDestination).toBe('024 388 12345678');

    // Encrypted at rest: the stored ciphertext is NOT the plaintext.
    const raw = await db.select().from(sellers).where(eq(sellers.id, id)).limit(1);
    expect(raw[0].payoutDestinationEnc).not.toBe('024 388 12345678');
    expect(raw[0].payoutDestinationEnc ?? '').not.toContain('12345678');
  });

  it('refuses to activate an already-ACTIVE seller (self-gate, no re-write)', async () => {
    const id = await seedPendingSeller();
    await store.setSellerStatus(PHONE, 'default', 'active');
    const issued = await txOtp.issue(id, PHONE);
    if (!issued.ok) throw new Error('issue failed');

    const res = await activateSellerAction({ id, fields: HK_FIELDS, otp: issued.code });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.reason).toBe('state');
  });

  it('refuses an unknown seller id (404-never-403)', async () => {
    const res = await activateSellerAction({ id: 's_nope', fields: HK_FIELDS, otp: '123456' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.reason).toBe('state');
  });

  it('refuses without a valid OTP — and does NOT activate', async () => {
    const id = await seedPendingSeller();
    const res = await activateSellerAction({ id, fields: HK_FIELDS, otp: '000000' });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.reason).toBe('otp');

    const still = await store.getSeller(PHONE, 'default');
    expect(still?.status).toBe('pending');
    expect(still?.payoutLast4).toBeUndefined();
  });

  it('rejects invalid payout fields with field errors (no activation)', async () => {
    const id = await seedPendingSeller();
    const issued = await txOtp.issue(id, PHONE);
    if (!issued.ok) throw new Error('issue failed');

    const res = await activateSellerAction({
      id, fields: { bankCode: '24', branchCode: '388', accountNumber: '12345678' }, otp: issued.code,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected refusal');
    expect(res.fieldErrors?.bankCode).toBeDefined();
    expect((await store.getSeller(PHONE, 'default'))?.status).toBe('pending');
  });
});

describe('requestSellerOtpAction', () => {
  it('issues + delivers a code to the seller WhatsApp for a pending seller', async () => {
    const id = await seedPendingSeller();
    const res = await requestSellerOtpAction(id);
    expect(res.ok).toBe(true);
    expect(sendTransactionOtp).toHaveBeenCalledTimes(1);
    expect(sendTransactionOtp.mock.calls[0][0]).toBe(PHONE);
  });

  it('does not send for an unknown / ineligible seller', async () => {
    expect((await requestSellerOtpAction('s_nope')).ok).toBe(false);
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });
});
