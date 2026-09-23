/**
 * Program-Fix 15 PR B — the pay POST's OPTIONAL `disclosureVersion`. When a
 * well-formed version is present and the OTP passed, the route records ONE
 * `remittance.disclosure_ack` audit row (subject: the route id; meta: the
 * version only, no PII). Absent or junk ⇒ no row and the SAME response (an old
 * page that never sends it still pays). The ack never changes the outcome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Transfer, Customer } from '@/lib/types';
import { sql } from 'drizzle-orm';

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
// Program-Fix 15 PR B: one case below serves a DRAFT id (bot pay links are drafts).
const drafts = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async (id: string) => drafts.get(id) ?? null }) }));
// WL1: existing-transfer branch resolves the owning partner for the gate toggle
// (default ⇒ gate ON). Plain-object stub — no partner row ⇒ ensureDefaultPartner's
// default (kycMode 'ours' ⇒ gate ON).
// Review r1: per-id partners so the ack meta's provider kind can be asserted.
const partners = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async (id: string) => partners.get(id) ?? null,
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

// Review r1: an audit write that throws must not change the pay response.
const ackAudit = vi.hoisted(() => ({ throwOnAck: false }));
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (db: Parameters<typeof real.createAuditRepo>[0]) => {
      const repo = real.createAuditRepo(db);
      return {
        ...repo,
        record: async (e: Parameters<typeof repo.record>[0]) => {
          if (ackAudit.throwOnAck && e.action === 'remittance.disclosure_ack') throw new Error('audit store down');
          return repo.record(e);
        },
      };
    },
  };
});

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
const customer: Customer = { senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Test Sender', senderCountry: 'US', partnerId: 'default', createdAt: T0, updatedAt: T0 } as Customer;

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
  drafts.clear();
  partners.clear();
  ackAudit.throwOnAck = false;
});

const status = async () => (await store.getTransfer(TID))?.status;
async function ackRows() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = 'remittance.disclosure_ack' ORDER BY id`);
  return r.rows as Array<Record<string, unknown>>;
}

describe('POST /api/pay/[transferId] — optional disclosure acknowledgement', { retry: 0 }, () => {
  it('a well-formed version + a valid code ⇒ pays AND records one ack row (version only)', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321', disclosureVersion: 'disclosure-draft-2026-09-23b' }), ctx);
    expect(res.status).toBe(200);
    expect(await status()).toBe('paid');
    expect(await ackRows()).toEqual([
      {
        partner_id: 'default',
        actor: 'pay-page',
        actor_type: 'system',
        action: 'remittance.disclosure_ack',
        subject_id: TID,
        meta: { version: 'disclosure-draft-2026-09-23b', providerKind: 'demo' },
      },
    ]);
  });

  it('no field (an old page) ⇒ pays exactly as before, no ack row', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    expect(await ackRows()).toEqual([]);
  });

  it('a well-formed but UNKNOWN version ⇒ pays, no ack row (review r1: known versions only)', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321', disclosureVersion: 'disclosure-draft-2099-01-01' }), ctx);
    expect(res.status).toBe(200);
    expect(await status()).toBe('paid');
    expect(await ackRows()).toEqual([]);
  });

  it('an audit write that throws does not change the pay response (review r1)', async () => {
    await txOtp.issue(TID, PHONE);
    ackAudit.throwOnAck = true;
    const res = await POST(req({ otp: '654321', disclosureVersion: 'disclosure-draft-2026-09-23b' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'paid' }); // byte-for-byte the no-field response
    expect(await status()).toBe('paid');
    expect(await ackRows()).toEqual([]);
  });

  it('a junk version ⇒ pays, no ack row', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '654321', disclosureVersion: '<script>alert(1)</script>' }), ctx);
    expect(res.status).toBe(200);
    expect(await status()).toBe('paid');
    expect(await ackRows()).toEqual([]);
  });

  it('a wrong code ⇒ 403 and no ack row (recorded only after the OTP passes)', async () => {
    await txOtp.issue(TID, PHONE);
    const res = await POST(req({ otp: '000000', disclosureVersion: 'disclosure-draft-2026-09-23b' }), ctx);
    expect(res.status).toBe(403);
    expect(await ackRows()).toEqual([]);
  });

  it('request_otp never records an ack', async () => {
    const res = await POST(req({ action: 'request_otp', disclosureVersion: 'disclosure-draft-2026-09-23b' }), ctx);
    expect(res.status).toBe(200);
    expect(await ackRows()).toEqual([]);
  });

  it('a DRAFT link: the ack is recorded under the draft id and the draft tenant, before finalize', async () => {
    const DRAFT_ID = 'draft_ack_1';
    partners.set('p_draft_tenant', {
      id: 'p_draft_tenant', name: 'Draft Tenant', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      supportConfig: { disclosure: { licensedEntity: 'Draft Tenant Money LLC' } },
    });
    drafts.set(DRAFT_ID, {
      senderPhone: PHONE,
      partnerId: 'p_draft_tenant',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 100, amountSource: 100, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 8500 },
    });
    await txOtp.issue(DRAFT_ID, PHONE);
    const draftReq = new NextRequest('http://x/api/pay/' + DRAFT_ID, {
      method: 'POST',
      body: JSON.stringify({ otp: '654321', disclosureVersion: 'disclosure-draft-2026-09-23b' }),
      headers: { 'content-type': 'application/json' },
    });
    // The payment outcome is not under test here (this harness has no finalize
    // stores); the ack row is written right after the OTP check, before finalize.
    await POST(draftReq, { params: Promise.resolve({ transferId: DRAFT_ID }) });
    const rows = await ackRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      partner_id: 'p_draft_tenant',
      subject_id: DRAFT_ID,
      meta: { version: 'disclosure-draft-2026-09-23b', providerKind: 'configured' },
    });
  });
});
