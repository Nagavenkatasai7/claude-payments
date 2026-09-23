/**
 * Task 9 — the cross-border B2B checkout fetches FX BEFORE the OTP check: a
 * provider outage is a retryable 503 that never burns the single-use code and
 * never reaches the claim-first mint. A USD buyer needs no FX at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetRateCacheForTests } from '@/lib/rate';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

const NOW_ISO = new Date().toISOString();
let buyerPhone = '447700900123'; // GB ⇒ GBP (needs FX)
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    getB2bInvoice: async (id: string) => ({
      id, partnerId: 'default', businessName: 'Kowloon Design Co', buyerPhone,
      lineItems: [], amountUsd: 128, currency: 'HKD', sellerId: 's_hk1',
      invoicedAmount: 1000, invoicedCurrency: 'HKD', status: 'unpaid', createdAt: NOW_ISO,
    }),
    getSellerById: async () => ({ id: 's_hk1', partnerId: 'default', status: 'active', currency: 'HKD' }),
    getTransfer: async () => null,
  }),
}));
vi.mock('@/lib/b2b-quote-store', () => ({
  getB2bQuoteStore: () => ({
    getLockedQuote: async () => ({
      sellerAmount: 1000, sellerCurrency: 'HKD',
      buyerCurrency: buyerPhone.startsWith('44') ? 'GBP' : 'USD',
      buyerPrincipal: 95.5, feeBuyer: 1.49, buyerTotal: 96.99, fxRate: 10.47, lockedAt: NOW_ISO,
    }),
  }),
}));
vi.mock('@/lib/customer-store', () => ({
  getCustomerStore: () => ({ getCustomer: async () => ({ kycStatus: 'verified', fullName: 'Buyer Ltd' }) }),
}));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({ getPartner: async () => ({ id: 'default', kycMode: 'delegated', countries: ['US'] }) }),
}));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
const verify = vi.hoisted(() => vi.fn());
const issue = vi.hoisted(() => vi.fn());
const shortenCooldown = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({ issue, verify, shortenCooldown }),
}));
// Program-Fix 45: spy on delivery so the request_otp mapping can be pinned.
const sendTransactionOtp = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp', async (orig) => ({ ...(await orig<typeof import('@/lib/whatsapp')>()), sendTransactionOtp }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));
const finalizeCrossBorderBillPayment = vi.hoisted(() => vi.fn());
vi.mock('@/lib/b2b-pay-finalize', () => ({ finalizeCrossBorderBillPayment }));

import { POST } from '@/app/api/pay/b2b/[invoiceId]/route';

const post = (fields: Record<string, string>) =>
  POST(
    new NextRequest('http://x/api/pay/b2b/inv_1', {
      method: 'POST',
      body: JSON.stringify({ otp: '123456', fields }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ invoiceId: 'inv_1' }) },
  );

beforeEach(() => {
  resetRateCacheForTests();
  verify.mockReset().mockResolvedValue({ ok: true });
  issue.mockReset().mockResolvedValue({ ok: true, code: '123456' });
  sendTransactionOtp.mockReset().mockResolvedValue(undefined);
  finalizeCrossBorderBillPayment.mockReset().mockResolvedValue({ ok: false, error: 'seller_unavailable' });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net'))); // FX provider down
});

describe('POST /api/pay/b2b/[invoiceId] — FX before OTP (Task 9)', () => {
  it('a non-USD buyer while FX is down → 503 fx_unavailable; the OTP is NOT consumed and nothing is minted', async () => {
    buyerPhone = '447700900123';
    const res = await post({ sortCode: '112233', accountNumber: '12345678' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, reason: 'fx_unavailable' });
    expect(verify).not.toHaveBeenCalled();
    expect(finalizeCrossBorderBillPayment).not.toHaveBeenCalled();
  });

  it('a USD buyer needs no FX: the outage does not block the checkout (buyerToUsd = 1)', async () => {
    buyerPhone = '15551112222';
    const res = await post({ routingNumber: '021000021', accountNumber: '12345678' });
    expect(verify).toHaveBeenCalledOnce();
    expect(finalizeCrossBorderBillPayment).toHaveBeenCalledOnce();
    expect(finalizeCrossBorderBillPayment.mock.calls[0][1]).toMatchObject({ buyerToUsd: 1 });
    expect(res.status).toBe(400); // the stubbed finalize refusal — the FX gate did not fire
  });
});

// Program-Fix 45 (P2): an issue refused at a cap (`locked`) answers exactly like
// a sent code, so the buyer's page cannot tell a cap from a send; nothing is sent.
describe('POST /api/pay/b2b/[invoiceId] — request_otp at an issue cap (fix 45)', { retry: 0 }, () => {
  const requestOtp = () =>
    POST(
      new NextRequest('http://x/api/pay/b2b/inv_1', {
        method: 'POST',
        body: JSON.stringify({ action: 'request_otp' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ invoiceId: 'inv_1' }) },
    );

  it('a normal request sends the code and answers {ok:true,sent:true}', async () => {
    buyerPhone = '15551112222';
    const res = await requestOtp();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    // Its own per-phone budget: kind 'b2b', scoped to the invoice's partner.
    expect(issue).toHaveBeenCalledWith('inv_1', '15551112222', { kind: 'b2b', partnerId: 'default' });
  });

  // Program-Fix 25 PR B (amendment 6): locked answers 429; a cooldown stays 200.
  it('locked → 429 {ok:false, reason:"locked"}, and no code is sent', async () => {
    buyerPhone = '15551112222';
    issue.mockResolvedValue({ ok: false, reason: 'locked' });
    const res = await requestOtp();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, reason: 'locked' });
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it('cooldown → the same 200 {ok:true,sent:true}, and no code is sent', async () => {
    buyerPhone = '15551112222';
    issue.mockResolvedValue({ ok: false, reason: 'cooldown' });
    const res = await requestOtp();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it('a send that throws → 502 otp_send_failed and the cooldown is shortened', async () => {
    buyerPhone = '15551112222';
    shortenCooldown.mockReset().mockResolvedValue(undefined);
    sendTransactionOtp.mockRejectedValueOnce(new Error('WhatsApp send failed (400): x'));
    const res = await requestOtp();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: 'otp_send_failed' });
    expect(shortenCooldown).toHaveBeenCalledWith('inv_1');
  });
});
