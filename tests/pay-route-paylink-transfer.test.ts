/**
 * Batch B2 security review (MEDIUM): a payment link's transfer is paid ONLY
 * through /api/pay/l/[token]. After a link payment mints and the charge fails,
 * the transfer stays awaiting_payment; the old hosted route
 * /api/pay/[transferId] must refuse it (the one 404 expired_or_used, no code
 * sent, nothing charged), or it would skip the link checks (paylinks.enabled,
 * payee approved, link expiry and status).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { createLinkQuoteStore } from '@/lib/payment-link-quote';
import { finalizeLinkPayment } from '@/lib/payment-link-finalize';
import { invalidateFlagCache } from '@/lib/flags';
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
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

import { POST as hostedPost } from '@/app/api/pay/[transferId]/route';
import { POST as linkPost } from '@/app/api/pay/l/[token]/route';

const PHONE = '14155550100';
const T0 = '2026-05-01T00:00:00.000Z';
const LINK_ID = 'pl_hosted1';

let token: string;

const json = (url: string, b: object) =>
  new NextRequest(url, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const hosted = (id: string, b: object) => hostedPost(json(`http://x/api/pay/${id}`, b), { params: Promise.resolve({ transferId: id }) });
const viaLink = (b: object) => linkPost(json(`http://x/api/pay/l/${token}`, b), { params: Promise.resolve({ token }) });

async function flag(key: string, enabled: boolean) {
  await createFeatureFlagRepo(db).upsert({ key, scopeType: 'global', scopeId: '', enabled, reason: 't', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

/** The link payment minted its transfer, then the charge failed: awaiting_payment, uncharged. */
async function mintUnpaid(): Promise<string> {
  const rate = await quotes.get(LINK_ID);
  const r = await finalizeLinkPayment(
    {
      store, customerStore, partnerStore, db,
      monthlyVolumeStore: createMonthlyVolumeStore(store),
      dailyVolumeStore: createDailyVolumeStore(store),
    },
    { token, fundingMethod: 'bank_transfer', rate },
  );
  if (!r.ok) throw new Error(`mint failed: ${r.error}`);
  expect((await store.getTransfer(r.transferId))?.status).toBe('awaiting_payment');
  return r.transferId;
}

beforeEach(async () => {
  vi.stubEnv('DEMO_PHONES', '*');
  const r = fakeRedis();
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(r, db);
  customerStore = createCustomerStore(db, store);
  partnerStore = createPartnerStore(db);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  quotes = createLinkQuoteStore(r);
  await flag('paylinks.enabled', true);
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Asha Patel', senderCountry: 'US',
    partnerId: 'default', createdAt: T0, updatedAt: T0,
  } as Customer);
  const payees = createPayeeRepo(db);
  await payees.insert({
    id: 'pye_h1', partnerId: 'default', legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
    payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
  });
  await payees.decide('pye_h1', ['pending'], 'approved', 'admin');
  token = newLinkToken();
  await createPaymentLinkRepo(db).insertLinks([{
    id: LINK_ID, partnerId: 'default', payeeId: 'pye_h1', token, reference: 'INV-88', customerName: 'Asha Patel',
    customerPhone: PHONE, amountInr: 25000, purpose: 'education', expiresAt: linkExpiresAt(), createdBy: 'pa',
  }]);
  await quotes.lock(LINK_ID, { toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' });
  sendTransactionOtp.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a payment-link transfer on the hosted pay route', () => {
  it('payee suspended after the mint: request_otp and pay both answer the one 404, no code, no charge', async () => {
    const id = await mintUnpaid();
    await createPayeeRepo(db).decide('pye_h1', ['approved'], 'suspended', 'admin');

    const otp = await hosted(id, { action: 'request_otp' });
    expect(otp.status).toBe(404);
    expect(await otp.json()).toEqual({ ok: false, error: 'expired_or_used' });
    expect(sendTransactionOtp).not.toHaveBeenCalled();

    // Even holding a valid code for the transfer id, the payment is refused.
    const issued = await txOtp.issue(id, PHONE, { kind: 'pay', partnerId: 'default' });
    expect(issued.ok).toBe(true);
    const pay = await hosted(id, { otp: '654321' });
    expect(pay.status).toBe(404);
    expect(await pay.json()).toEqual({ ok: false, error: 'expired_or_used' });
    const t = await store.getTransfer(id);
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef ?? null).toBeNull();
  });

  it('switch off after the mint: refused the same way', async () => {
    const id = await mintUnpaid();
    await flag('paylinks.enabled', false);
    await txOtp.issue(id, PHONE, { kind: 'pay', partnerId: 'default' });
    const pay = await hosted(id, { otp: '654321' });
    expect(pay.status).toBe(404);
    expect((await store.getTransfer(id))?.status).toBe('awaiting_payment');
  });

  it('every check passing still refuses it there; the link route is the only way to pay it', async () => {
    const id = await mintUnpaid();
    expect((await hosted(id, { action: 'request_otp' })).status).toBe(404);
    await txOtp.issue(id, PHONE, { kind: 'pay', partnerId: 'default' });
    expect((await hosted(id, { otp: '654321' })).status).toBe(404);
    expect((await store.getTransfer(id))?.status).toBe('awaiting_payment');

    // The retry through the link pays the SAME transfer (a resume: its figures are fixed, no lock needed).
    expect((await viaLink({ action: 'request_otp' })).status).toBe(200);
    const res = await viaLink({ otp: '654321', fundingMethod: 'bank_transfer' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transferId).toBe(id);
    expect((await store.getTransfer(id))?.status).toBe('paid');
  });
});
