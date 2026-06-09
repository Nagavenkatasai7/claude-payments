/**
 * Phase 3 Part B — the pay route requires a per-transaction OTP before any
 * money moves, on the existing-transfer branch (scheduled/re-opened links).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { fakeRedis } from './helpers';
import type { Transfer, Customer } from '@/lib/types';

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

let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
// No draft for these ids → otpPhone resolves from the existing transfer.
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));
// WL1: existing-transfer branch resolves the owning partner for the gate toggle
// (default ⇒ gate ON). Back getPartnerStore with a fake store, not real Redis.
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  const ps = real.createPartnerStore(fakeRedis());
  return { ...real, getPartnerStore: () => ps };
});

// WL3: the route also resolves the partner's integrations (rail + WhatsApp creds).
// No row ⇒ EMPTY ⇒ mock rail + env number — the legacy behavior these tests pin.
vi.mock('@/lib/partner-integrations-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-integrations-store')>();
  const is = real.createPartnerIntegrationsStore(fakeRedis());
  return { ...real, getPartnerIntegrationsStore: () => is };
});

const initiateTransfer = vi.fn(async (_t: Transfer) => ({ providerRef: 'ref_1' }));
vi.mock('@/lib/providers/payment-provider', () => ({ getPaymentProvider: () => ({ initiateTransfer }) }));

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';
const TID = 'transfer_1';
const transfer: Transfer = {
  id: TID, phone: PHONE, amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85, amountInr: 17000,
  recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: 'ACCT-123',
  fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
  createdAt: '2026-05-30T00:00:00Z', sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
  destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 0, totalChargeSource: 200,
} as Transfer;
const customer: Customer = { senderPhone: PHONE, firstSeenAt: '', kycStatus: 'verified', senderCountry: 'US', partnerId: 'default', createdAt: '', updatedAt: '' } as Customer;

const req = (b: object) => new NextRequest('http://x/api/pay/' + TID, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const ctx = { params: Promise.resolve({ transferId: TID }) };

beforeEach(async () => {
  const r = fakeRedis();
  store = createStore(r);
  customerStore = createCustomerStore(r, store);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  await store.saveTransfer(transfer);
  await customerStore.saveCustomer(customer);
  initiateTransfer.mockClear();
  sendTransactionOtp.mockClear();
});

describe('POST /api/pay/[transferId] — per-transaction OTP', () => {
  it('request_otp issues + delivers a code, no charge', async () => {
    const res = await POST(req({ action: 'request_otp' }), ctx);
    expect((await res.json()).sent).toBe(true);
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', undefined);
    expect(initiateTransfer).not.toHaveBeenCalled();
  });

  it('a pay with the WRONG/MISSING code → 403, never charges', async () => {
    await txOtp.issue(TID, PHONE);
    const wrong = await POST(req({ otp: '000000' }), ctx);
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).reason).toBe('otp');
    const missing = await POST(req({}), ctx);
    expect(missing.status).toBe(403);
    expect(initiateTransfer).not.toHaveBeenCalled();
  });

  it('a pay with the CORRECT code → proceeds (charges)', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(res.status).toBe(200);
    expect(initiateTransfer).toHaveBeenCalledOnce();
  });
});
