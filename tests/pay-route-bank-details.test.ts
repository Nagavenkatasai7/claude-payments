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
import { freshDb } from './helpers-db';
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

let db: Awaited<ReturnType<typeof freshDb>>;
let store: ReturnType<typeof createStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
// Stage 2c: the cleared branch runs beginSettlement(getDb(), …) — point the
// route's db handle at THIS test's PGlite instance.
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => db };
});
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
// whether OUR KYC gate applies (default ⇒ gate ON, unchanged). Plain-object stub
// — no partner row ⇒ ensureDefaultPartner's default (kycMode 'ours' ⇒ gate ON).
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      requireKycBeforeSend: true, // gate OPT-IN: this suite pins the 403 path
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
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  // Verified owner for the transfer's phone so the verify-before-send gate passes.
  const nowIso = new Date().toISOString();
  await customerStore.saveCustomer({
    senderPhone: '15551234567', firstSeenAt: nowIso, kycStatus: 'verified',
    senderCountry: 'US', partnerId: 'default', optInAt: nowIso,
    createdAt: nowIso, updatedAt: nowIso,
  });
});

// "Charged" is now observable in the LEDGER (Stage 2c beginSettlement): the
// status flips awaiting_payment → paid in the same transaction as the effects.
const status = async (id: string) => (await store.getTransfer(id))?.status;

describe('pay route — scheduled transfer with no bank details (Item 2)', () => {
  it('empty destination + NO body → 400, never charged', async () => {
    await store.saveTransfer(makeTransfer({ id: 's1', payoutDestination: '' }));
    const res = await post('s1'); // bodyless
    expect(res.status).toBe(400);
    expect(await status('s1')).toBe('awaiting_payment'); // never charged
    expect((await store.getTransfer('s1'))?.payoutDestination).toBe(''); // untouched
  });

  it('empty destination + VALID body → sets destination then charges', async () => {
    await store.saveTransfer(makeTransfer({ id: 's2', payoutDestination: '' }));
    const res = await post('s2', { country: 'IN', fields: { accountNumber: '123456789', ifsc: 'HDFC0001234' } });
    expect(res.status).toBe(200);
    // Charged: paid in the settlement transaction, mock providerRef set with it.
    expect(await status('s2')).toBe('paid');
    expect((await store.getTransfer('s2'))?.paymentProviderRef).toBe('mock-s2');
    // The stored row now has a destination (default reads are MASKED)…
    const t = await store.getTransfer('s2');
    expect(t?.payoutDestination).toMatch(/^\*\*\*\*\d{4}$/);
    // …while the FULL value survives at rest through the charge's RMW re-save
    // (the mask-aware upsert never lets a masked read clobber the ciphertext) —
    // the settlement.instruct worker leg reads THIS decrypted value for the rail.
    const full = await store.getTransferDecrypted('s2');
    expect(full?.payoutDestination).toContain('123456789');
    expect(full?.payoutDestination).toContain('HDFC0001234');
  });

  it('destination already set + NO body → processes (re-opened link regression)', async () => {
    await store.saveTransfer(makeTransfer({ id: 's3', payoutDestination: '123456789 HDFC0001234' }));
    const res = await post('s3'); // bodyless, like today's scheduled/re-open links
    expect(res.status).toBe(200);
    expect(await status('s3')).toBe('paid');
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
    expect(await status('s4')).toBe('awaiting_payment'); // never charged
  });
});
