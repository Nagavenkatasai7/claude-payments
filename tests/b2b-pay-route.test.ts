/**
 * Program-Fix 44 (P3, b2b-04): the cross-border B2B pay route refuses an
 * UNPAID bill older than B2B_BILL_TTL_DAYS with the generic dead-bill answer —
 * before the confirmation-code step, so an expired link can neither trigger a
 * code send nor reach the claim-first mint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

const DAY = 24 * 60 * 60 * 1000;
let createdAt = new Date().toISOString();
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    getB2bInvoice: async (id: string) => ({
      id, partnerId: 'default', businessName: 'Seller Co', buyerPhone: '15550001111',
      lineItems: [], amountUsd: 500, currency: 'USD', sellerId: 's_1',
      invoicedAmount: 500, invoicedCurrency: 'USD', status: 'unpaid', createdAt,
    }),
    getSellerById: async () => ({ id: 's_1', partnerId: 'default', status: 'active', currency: 'USD' }),
    getTransfer: async () => null,
  }),
}));
vi.mock('@/lib/b2b-quote-store', () => ({
  getB2bQuoteStore: () => ({
    getLockedQuote: async () => ({
      sellerAmount: 500, sellerCurrency: 'USD', buyerCurrency: 'USD',
      buyerPrincipal: 500, feeBuyer: 1.99, buyerTotal: 501.99, fxRate: 1, lockedAt: new Date().toISOString(),
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
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({ issue, verify }),
}));
const sendTransactionOtp = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp', async (orig) => ({ ...(await orig<typeof import('@/lib/whatsapp')>()), sendTransactionOtp }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }) }),
}));
const finalizeCrossBorderBillPayment = vi.hoisted(() => vi.fn());
vi.mock('@/lib/b2b-pay-finalize', () => ({ finalizeCrossBorderBillPayment }));

import { POST } from '@/app/api/pay/b2b/[invoiceId]/route';

const call = (body: Record<string, unknown>) =>
  POST(
    new NextRequest('http://x/api/pay/b2b/inv_1', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ invoiceId: 'inv_1' }) },
  );
const pay = () => call({ otp: '123456', fields: { routingNumber: '021000021', accountNumber: '12345678' } });

beforeEach(() => {
  verify.mockReset().mockResolvedValue({ ok: true });
  issue.mockReset().mockResolvedValue({ ok: true, code: '123456' });
  sendTransactionOtp.mockReset().mockResolvedValue(undefined);
  finalizeCrossBorderBillPayment.mockReset().mockResolvedValue({ ok: false, error: 'seller_unavailable' });
});

describe('POST /api/pay/b2b/[invoiceId] — bill expiry (Program-Fix 44)', { retry: 0 }, () => {
  it('an unpaid bill 31 days old → 404 "no longer active"; no code is verified and nothing is minted', async () => {
    createdAt = new Date(Date.now() - 31 * DAY).toISOString();
    const res = await pay();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'This bill is no longer active.' });
    expect(verify).not.toHaveBeenCalled();
    expect(finalizeCrossBorderBillPayment).not.toHaveBeenCalled();
  });

  it('request_otp on an expired bill → the same 404, and no code is issued or sent', async () => {
    createdAt = new Date(Date.now() - 31 * DAY).toISOString();
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'This bill is no longer active.' });
    expect(issue).not.toHaveBeenCalled();
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it('control: a 29-day-old bill proceeds to the code check and the mint', async () => {
    createdAt = new Date(Date.now() - 29 * DAY).toISOString();
    const res = await pay();
    expect(verify).toHaveBeenCalledOnce();
    expect(finalizeCrossBorderBillPayment).toHaveBeenCalledOnce();
    expect(res.status).toBe(400); // the stubbed finalize refusal, not the expiry gate
  });
});
