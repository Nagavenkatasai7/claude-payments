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
import { freshDb } from './helpers-db';
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

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
// Stage 2c: the cleared branch runs beginSettlement(getDb(), …) — point the
// route's db handle at THIS test's PGlite instance.
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
// No draft for these ids → otpPhone resolves from the existing transfer.
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));
// WL1: existing-transfer branch resolves the owning partner for the gate toggle
// (default ⇒ gate ON). Plain-object stub — no partner row ⇒ ensureDefaultPartner's
// default (kycMode 'ours' ⇒ gate ON).
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));

// WL3: the route also resolves the partner's integrations (rail + WhatsApp creds).
// EMPTY ⇒ mock rail + env number — the legacy behavior these tests pin.
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }),
  }),
}));

// Stage 3: the per-IP limiter would dial Upstash — always allow in unit tests.
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

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
// Postgres customer rows need real timestamps (new Date('') is invalid).
const T0 = '2026-05-01T00:00:00.000Z';
const customer: Customer = { senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', senderCountry: 'US', partnerId: 'default', createdAt: T0, updatedAt: T0 } as Customer;

const req = (b: object) => new NextRequest('http://x/api/pay/' + TID, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const ctx = { params: Promise.resolve({ transferId: TID }) };

beforeEach(async () => {
  const r = fakeRedis();
  db = await freshDb();
  store = createStore(r, db);
  customerStore = createCustomerStore(db, store);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  await store.saveTransfer(transfer);
  await customerStore.saveCustomer(customer);
  sendTransactionOtp.mockClear();
});

// "Charged" is now observable in the LEDGER (Stage 2c beginSettlement): the
// status flips awaiting_payment → paid in the same transaction as the effects.
const status = async () => (await store.getTransfer(TID))?.status;

describe('POST /api/pay/[transferId] — per-transaction OTP', () => {
  it('request_otp issues + delivers a code, no charge', async () => {
    const res = await POST(req({ action: 'request_otp' }), ctx);
    expect((await res.json()).sent).toBe(true);
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', undefined);
    expect(await status()).toBe('awaiting_payment');
  });

  it('a pay with the WRONG/MISSING code → 403, never charges', async () => {
    await txOtp.issue(TID, PHONE);
    const wrong = await POST(req({ otp: '000000' }), ctx);
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).reason).toBe('otp');
    const missing = await POST(req({}), ctx);
    expect(missing.status).toBe(403);
    expect(await status()).toBe('awaiting_payment');
  });

  it('a pay with the CORRECT code → proceeds (charges)', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(res.status).toBe(200);
    expect(await status()).toBe('paid');
    // Mock rail: the deterministic providerRef is set in the same transaction.
    expect((await store.getTransfer(TID))?.paymentProviderRef).toBe(`mock-${TID}`);
  });
});
