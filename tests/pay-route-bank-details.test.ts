/**
 * Item 2 regression: a SCHEDULED/cron transfer is created with an EMPTY
 * destination (bank details are never collected in chat). The pay route must
 * collect + validate them on the secure page before charging — and must NEVER
 * deliver a transfer with no bank account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

// Keep the real NextRequest/NextResponse; only no-op after() so stage-2 never runs.
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

// Phase 3 Part B: the route now gates on a per-transaction OTP + peeks the draft
// store for phone resolution. These tests exercise the bank-detail + KYC logic,
// not the OTP (that's pay-route-otp.test) — so stub the OTP to always pass and
// the draft peek to "no draft" (phone resolves from the existing transfer).
vi.mock('@/lib/transaction-otp', () => ({
  getTransactionOtpStore: () => ({
    issue: async () => ({ ok: true, code: '000000' }),
    verify: async () => ({ ok: true }),
  }),
}));
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async () => null }) }));

let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return { ...real, getStore: () => store };
});

// Phase 3: the pay route's existing-transfer branch loads the owner via
// getCustomerStore and gates on verified. Back it with the SAME fake store so
// the seeded verified owner is visible to the route.
vi.mock('@/lib/customer-store', async (orig) => {
  const real = await orig<typeof import('@/lib/customer-store')>();
  return { ...real, getCustomerStore: () => customerStore };
});

// WL1: the existing-transfer branch now resolves the owning partner to decide
// whether OUR KYC gate applies (default ⇒ gate ON, unchanged). Back getPartnerStore
// with a fake store so it doesn't reach real Redis.
vi.mock('@/lib/partner-store', async (orig) => {
  const real = await orig<typeof import('@/lib/partner-store')>();
  const ps = real.createPartnerStore(fakeRedis());
  return { ...real, getPartnerStore: () => ps };
});

const initiateTransfer = vi.fn(async (_t: Transfer) => ({ providerRef: 'ref_1' }));
vi.mock('@/lib/providers/payment-provider', () => ({
  getPaymentProvider: () => ({ initiateTransfer }),
}));

import { POST } from '@/app/api/pay/[transferId]/route';

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: '15551234567', amountUsd: 200, feeUsd: 0, totalChargeUsd: 200, fxRate: 85,
    amountInr: 17000, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'bank', payoutDestination: '', fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: '2026-05-30T00:00:00Z', sourceCountry: 'US', sourceCurrency: 'USD',
    destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'default',
    amountSource: 200, feeSource: 0, totalChargeSource: 200, ...o,
  };
}

function post(id: string, body?: unknown) {
  const req = new NextRequest('http://localhost/api/pay/' + id, {
    method: 'POST',
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  });
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<{ status: number }>;
}

beforeEach(async () => {
  const redis = fakeRedis();
  store = createStore(redis);
  customerStore = createCustomerStore(redis, store);
  // Verified owner for the transfer's phone so the verify-before-send gate passes.
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
  initiateTransfer.mockClear();
});

describe('pay route — scheduled transfer with no bank details (Item 2)', () => {
  it('empty destination + NO body → 400, never charged', async () => {
    await store.saveTransfer(makeTransfer({ id: 's1', payoutDestination: '' }));
    const res = await post('s1'); // bodyless
    expect(res.status).toBe(400);
    expect(initiateTransfer).not.toHaveBeenCalled();
    expect((await store.getTransfer('s1'))?.payoutDestination).toBe(''); // untouched
  });

  it('empty destination + VALID body → sets destination then charges', async () => {
    await store.saveTransfer(makeTransfer({ id: 's2', payoutDestination: '' }));
    const res = await post('s2', { country: 'IN', fields: { accountNumber: '123456789', ifsc: 'HDFC0001234' } });
    expect(res.status).toBe(200);
    expect(initiateTransfer).toHaveBeenCalledTimes(1);
    const t = await store.getTransfer('s2');
    expect(t?.payoutDestination).toContain('123456789'); // account now set
    expect(t?.payoutDestination).toContain('HDFC0001234');
  });

  it('destination already set + NO body → processes (re-opened link regression)', async () => {
    await store.saveTransfer(makeTransfer({ id: 's3', payoutDestination: '123456789 HDFC0001234' }));
    const res = await post('s3'); // bodyless, like today's scheduled/re-open links
    expect(res.status).toBe(200);
    expect(initiateTransfer).toHaveBeenCalledTimes(1);
  });

  it('Phase 3: an UNVERIFIED owner is blocked with 403 (kyc_required) — never charged', async () => {
    // Overwrite the verified seed for this phone with an unverified status.
    const nowIso = new Date().toISOString();
    await customerStore.saveCustomer({
      senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'grandfathered',
      senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
      createdAt: nowIso, updatedAt: nowIso,
    });
    await store.saveTransfer(makeTransfer({ id: 's4', payoutDestination: '123456789 HDFC0001234' }));
    const res = await post('s4');
    expect(res.status).toBe(403);
    expect(initiateTransfer).not.toHaveBeenCalled();
  });
});
