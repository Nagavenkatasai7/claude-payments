/**
 * Item 2 regression: a SCHEDULED/cron transfer is created with an EMPTY
 * destination (bank details are never collected in chat). The pay route must
 * collect + validate them on the secure page before charging — and must NEVER
 * deliver a transfer with no bank account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
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
  return POST(req, { params: Promise.resolve({ transferId: id }) }) as Promise<Response>;
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

describe('pay route — existing-transfer payout writes (fix 6 / ctx-01)', () => {
  const EDIT = { country: 'IN', fields: { accountNumber: '987654321098', ifsc: 'SBIN0001234' } };

  it('a masked stored destination is treated as NO destination: bodyless → 400, never charged, row untouched', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm1', payoutDestination: '****9012' }));
    expect((await store.getTransfer('m1'))?.payoutDestination).toBe('****9012');
    expect((await post('m1')).status).toBe(400);
    expect(await status('m1')).toBe('awaiting_payment');
    expect((await store.getTransferDecrypted('m1'))?.payoutDestination).toBe('****9012');
  });

  it('the same row + a VALID body → the real destination replaces the mask, then it charges', async () => {
    await store.saveTransfer(makeTransfer({ id: 'm2', payoutDestination: '****9012' }));
    const res = await post('m2', { country: 'IN', fields: { accountNumber: '123456789012', ifsc: 'HDFC0001234' } });
    expect(res.status).toBe(200);
    expect(await status('m2')).toBe('paid');
    expect((await store.getTransferDecrypted('m2'))?.payoutDestination).toContain('123456789012');
  });

  it("a row poisoned with '****' (default read '********') also needs bank details", async () => {
    await store.saveTransfer(makeTransfer({ id: 'm3', payoutDestination: '****' }));
    expect((await post('m3')).status).toBe(400);
  });

  it('Edit bank details REPLACES a real stored destination on a consumer row — and the encrypted legal name survives (no whole-row re-save)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e1', payoutDestination: '123456789 HDFC0001234', recipientLegalName: 'Mother Legal Name' }));
    const res = await post('e1', EDIT);
    expect(res.status).toBe(200);
    expect(await status('e1')).toBe('paid');
    const full = await store.getTransferDecrypted('e1');
    expect(full?.payoutDestination).toContain('987654321098');
    expect(full?.recipientLegalName).toBe('Mother Legal Name');
    const audit = (await db.execute(sql`SELECT action, subject_id, meta FROM audit_events WHERE subject_id = 'e1'`)) as unknown as { rows: Array<{ action: string; meta: { last4: string } }> };
    expect(audit.rows.map((r) => r.action)).toContain('transfer.payout_edit');
    expect(JSON.stringify(audit.rows)).not.toContain('987654321098');
  });

  it('a CHARGED awaiting row (fundingRef set) is never edited: 409, destination unchanged', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e2', payoutDestination: '123456789 HDFC0001234', fundingRef: 'mockfund-e2' }));
    const res = await post('e2', EDIT);
    expect(res.status).toBe(409);
    expect((await store.getTransferDecrypted('e2'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it('RACE: a concurrent no-body POST settles the row between our read and the Edit write → current truth, never reverted', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e3', payoutDestination: '123456789 HDFC0001234' }));
    const realDecrypt = store.getTransferDecrypted.bind(store);
    vi.spyOn(store, 'getTransferDecrypted').mockImplementationOnce(async (id: string) => {
      const before = await realDecrypt(id);
      await store.updateTransferFromWebhook(id, 'paid'); // the other POST won
      return before;
    });
    const res = await post('e3', EDIT);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'paid' });
    expect(await status('e3')).toBe('paid');
    expect((await store.getTransferDecrypted('e3'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it('RACE: a concurrent hold (in_review) is never reverted to awaiting_payment by an Edit', async () => {
    await store.saveTransfer(makeTransfer({ id: 'e4', payoutDestination: '123456789 HDFC0001234' }));
    const realDecrypt = store.getTransferDecrypted.bind(store);
    vi.spyOn(store, 'getTransferDecrypted').mockImplementationOnce(async (id: string) => {
      const before = await realDecrypt(id);
      await store.updateTransferIfStatus(id, 'awaiting_payment', { status: 'in_review' });
      return before;
    });
    const res = await post('e4', EDIT);
    expect(await res.json()).toMatchObject({ ok: true, status: 'in_review' });
    expect(await status('e4')).toBe('in_review');
    expect((await store.getTransferDecrypted('e4'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it("a PARTNER-API-minted row's beneficiary is never payer-editable: 409, unchanged", async () => {
    await store.saveTransfer(makeTransfer({ id: 'e5', payoutDestination: '123456789 HDFC0001234' }));
    await createIdempotencyRepo(db).claim('default', 'order-8841', 'e5');
    const res = await post('e5', EDIT);
    expect(res.status).toBe(409);
    expect((await store.getTransferDecrypted('e5'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it("a body NEVER touches a B2B transfer's payee: its stored destination is kept and it settles as before", async () => {
    await store.saveTransfer(makeTransfer({
      id: 'e6', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      fundingMethod: 'bank_pull', payoutDestination: '123456789 HDFC0001234',
    }));
    expect((await post('e6', EDIT)).status).toBe(200);
    expect((await store.getTransferDecrypted('e6'))?.payoutDestination).toBe('123456789 HDFC0001234');
  });

  it("the body's country must be the payment's own destination country; a CONSUMER row carrying a partner-pulled method is refused outright", async () => {
    await store.saveTransfer(makeTransfer({ id: 'c1', payoutDestination: '' }));
    const res = await post('c1', { country: 'GB', fields: { accountNumber: '12345678', sortCode: '123456' } });
    expect(res.status).toBe(400);
    expect((await store.getTransferDecrypted('c1'))?.payoutDestination).toBe('');
    await store.saveTransfer(makeTransfer({ id: 'c2', payoutDestination: '123456789 HDFC0001234', fundingMethod: 'bank_pull' }));
    expect((await post('c2')).status).toBe(400);
    expect(await status('c2')).toBe('awaiting_payment'); // never charged, never instructed
  });

  it('an HK or MX consumer row accepts its own country\'s bank form (the route knows every CountryCode)', async () => {
    await store.saveTransfer(makeTransfer({ id: 'hk1', destinationCountry: 'HK', destinationCurrency: 'HKD' }));
    expect((await post('hk1', { country: 'HK', fields: { bankCode: '004', branchCode: '123', accountNumber: '123456789' } })).status).toBe(200);
    expect(await status('hk1')).toBe('paid');
    expect((await store.getTransferDecrypted('hk1'))?.payoutDestination).toBe('004 123 123456789');
    await store.saveTransfer(makeTransfer({ id: 'mx1', destinationCountry: 'MX', destinationCurrency: 'MXN' }));
    expect((await post('mx1', { country: 'MX', fields: { clabe: '012345678901234567' } })).status).toBe(200);
    expect(await status('mx1')).toBe('paid');
    expect((await store.getTransferDecrypted('mx1'))?.payoutDestination).toBe('012345678901234567');
  });
});
