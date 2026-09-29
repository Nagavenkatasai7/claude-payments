/**
 * The B2B bill-pay code (POST /api/pay/b2b/[invoiceId] action request_otp) never falls back to
 * SmartRemit's shared number for a partner whose own channel fails: a half-configured channel, a
 * creds read that throws → 502 otp_send_failed, NOTHING minted (no issue budget spent), nothing sent.
 * The default tenant and a partner with no WhatsApp config (deliberately shared) are unchanged; a
 * partner's own channel sends from its own number. Portal pay-page twin: PR #438.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (_cb: () => unknown) => {} };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

const NOW_ISO = new Date().toISOString();
const tenant = vi.hoisted(() => ({ id: 'pa' }));
vi.mock('@/lib/store', () => ({
  getStore: () => ({
    getB2bInvoice: async (id: string) => ({
      id, partnerId: tenant.id, businessName: 'Kowloon Design Co', buyerPhone: '15551112222',
      lineItems: [], amountUsd: 128, currency: 'HKD', sellerId: 's_hk1',
      invoicedAmount: 1000, invoicedCurrency: 'HKD', status: 'unpaid', createdAt: NOW_ISO,
    }),
  }),
}));
vi.mock('@/lib/b2b-quote-store', () => ({ getB2bQuoteStore: () => ({}) }));
vi.mock('@/lib/customer-store', () => ({ getCustomerStore: () => ({}) }));
vi.mock('@/lib/partner-store', () => ({ getPartnerStore: () => ({}) }));
vi.mock('@/lib/monthly-volume-store', () => ({ getMonthlyVolumeStore: () => ({}) }));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));
const issue = vi.hoisted(() => vi.fn());
const shortenCooldown = vi.hoisted(() => vi.fn());
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({ issue, verify: vi.fn(), shortenCooldown }),
}));
const sendTransactionOtp = vi.hoisted(() => vi.fn());
vi.mock('@/lib/whatsapp', async (orig) => ({ ...(await orig<typeof import('@/lib/whatsapp')>()), sendTransactionOtp }));
const getIntegrations = vi.hoisted(() => vi.fn());
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({ getIntegrations }),
}));
const recordChannelHealth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/channel-health', async (orig) => ({ ...(await orig<typeof import('@/lib/channel-health')>()), recordChannelHealth }));
vi.mock('@/lib/b2b-pay-finalize', () => ({ finalizeCrossBorderBillPayment: vi.fn() }));

import { POST } from '@/app/api/pay/b2b/[invoiceId]/route';

const requestOtp = () =>
  POST(
    new NextRequest('http://x/api/pay/b2b/inv_1', {
      method: 'POST',
      body: JSON.stringify({ action: 'request_otp' }),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ invoiceId: 'inv_1' }) },
  );
const cfg = (whatsapp: PartnerIntegrations['whatsapp']): PartnerIntegrations => ({ kyc: {}, payment: {}, whatsapp });

beforeEach(() => {
  tenant.id = 'pa';
  issue.mockReset().mockResolvedValue({ ok: true, code: '123456' });
  shortenCooldown.mockReset().mockResolvedValue(undefined);
  sendTransactionOtp.mockReset().mockResolvedValue(undefined);
  getIntegrations.mockReset();
  recordChannelHealth.mockReset().mockResolvedValue(false);
});

describe('B2B bill code: fail closed on a partner channel that cannot be used', { retry: 0 }, () => {
  it('a half-configured partner channel → 502 otp_send_failed; nothing minted or sent; incomplete_config recorded', async () => {
    getIntegrations.mockResolvedValue(cfg({ phoneNumberId: '1234567', appSecret: 'app' }));
    const res = await requestOtp();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: 'otp_send_failed' });
    expect(issue).not.toHaveBeenCalled();
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect(recordChannelHealth).toHaveBeenCalledWith('pa', 'incomplete_config');
  });

  it("a partner whose creds read throws → 502 otp_send_failed; nothing minted or sent", async () => {
    getIntegrations.mockRejectedValue(new Error('decrypt failed'));
    const res = await requestOtp();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: 'otp_send_failed' });
    expect(issue).not.toHaveBeenCalled();
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it("a partner's own channel → the code goes out on the partner's number", async () => {
    getIntegrations.mockResolvedValue(cfg({ phoneNumberId: '1234567', token: 'tok', appSecret: 'app' }));
    const res = await requestOtp();
    expect(res.status).toBe(200);
    expect(issue).toHaveBeenCalledWith('inv_1', '15551112222', { kind: 'b2b', partnerId: 'pa' });
    expect(sendTransactionOtp).toHaveBeenCalledWith('15551112222', '123456', { phoneNumberId: '1234567', token: 'tok' });
  });

  it('a partner with no WhatsApp config (deliberately shared) → the shared number, as before', async () => {
    getIntegrations.mockResolvedValue(cfg({}));
    const res = await requestOtp();
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledWith('15551112222', '123456', undefined);
  });

  it('the default tenant whose read throws → the shared number, as before', async () => {
    tenant.id = 'default';
    getIntegrations.mockRejectedValue(new Error('db down'));
    const res = await requestOtp();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).toHaveBeenCalledWith('15551112222', '123456', undefined);
  });
});
