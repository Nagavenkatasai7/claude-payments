/**
 * Program-Fix 15 PR B, moved by fix pack 4 T9 (C7, C8, C17): the pay POST's
 * OPTIONAL `disclosureVersion`. When a KNOWN version is present and the OTP
 * passed, the route's PaymentEvidence carries the acknowledgement, and
 * pay-process commits ONE `remittance.disclosure_ack` row (subject: the PAID
 * transfer id; meta: version, provider kind, shown hash, route id; no PII) on
 * the locked awaiting row BEFORE any charge. Absent or junk ⇒ no ack row and
 * the SAME response (an old page that never sends it still pays: the default
 * tenant is not mandatory). A failed evidence write now refuses the charge
 * (503 approval_not_recorded): a payment is never made without its record.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import type { Transfer, Customer } from '@/lib/types';
import { PAY_APPROVAL_NOT_RECORDED_COPY } from '@/lib/pay-outcome';
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
// default (kycMode 'ours' ⇒ gate ON). Fix pack 4: the ack's provider kind is
// resolved by pay-process from the OWNER row in PGlite (createPartnerRepo), not here.
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));
// The DRAFT case: the finalizer is replaced by one that mints a transfer in
// PGlite (this harness has no finalize stores); the route then pays it.
const finalize = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pay-finalize', async (orig) => ({ ...(await orig<typeof import('@/lib/pay-finalize')>()), finalizeDraftPayment: finalize }));

// WL3: the route also resolves the partner's integrations (rail + WhatsApp creds).
// EMPTY ⇒ mock rail + env number — the legacy behavior these tests pin.
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: {}, whatsapp: {} }),
  }),
}));

// Stage 3: the per-IP limiter would dial Upstash — always allow in unit tests.
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));

// Fix pack 4: the evidence write (ONE recordMany in pay-process's commit) can be
// made to throw when it carries the ack row.
const ackAudit = vi.hoisted(() => ({ throwOnAck: false }));
vi.mock('@/db/repos/aux-repos', async (orig) => {
  const real = await orig<typeof import('@/db/repos/aux-repos')>();
  return {
    ...real,
    createAuditRepo: (db: Parameters<typeof real.createAuditRepo>[0]) => {
      const repo = real.createAuditRepo(db);
      return {
        ...repo,
        recordMany: async (es: Parameters<typeof repo.recordMany>[0]) => {
          if (ackAudit.throwOnAck && es.some((e) => e.action === 'remittance.disclosure_ack')) throw new Error('audit store down');
          return repo.recordMany(es);
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
  createdAt: new Date(Date.now() - 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
  destinationCurrency: 'INR', partnerId: 'default', amountSource: 200, feeSource: 0, totalChargeSource: 200,
} as Transfer;
// Postgres customer rows need real timestamps (new Date('') is invalid); relative, never hardcoded.
const T0 = new Date(Date.now() - 30 * 86_400_000).toISOString();
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
  finalize.mockReset();
  ackAudit.throwOnAck = false;
});

const status = async () => (await store.getTransfer(TID))?.status;
async function ackRows() {
  const r = await db.execute(sql`SELECT partner_id, actor, actor_type, action, subject_id, meta FROM audit_events WHERE action = 'remittance.disclosure_ack' ORDER BY id`);
  return r.rows as Array<Record<string, unknown>>;
}

describe('POST /api/pay/[transferId] — optional disclosure acknowledgement', { retry: 0 }, () => {
  it('a well-formed version + a valid code ⇒ pays AND records one ack row (ids and hashes only)', async () => {
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
        meta: { version: 'disclosure-draft-2026-09-23b', providerKind: 'demo', shownHash: null, routeId: TID },
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

  it('the evidence write fails ⇒ 503 approval_not_recorded, still awaiting_payment, no ack row, nothing charged (fix pack 4)', async () => {
    await txOtp.issue(TID, PHONE);
    ackAudit.throwOnAck = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const res = await POST(req({ otp: '654321', disclosureVersion: 'disclosure-draft-2026-09-23b' }), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    const t = await store.getTransfer(TID);
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef ?? null).toBeNull();
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

  it('a DRAFT link: the ack and otp.verified rows name the MINTED transfer id, meta.routeId = the draft id, partner = the draft tenant', async () => {
    const DRAFT_ID = 'draft_ack_1';
    const MINTED = 'tx_minted_from_draft_1';
    await seedPartner(db, 'p_draft_tenant');
    await db.execute(sql`UPDATE partners SET support_config = ${JSON.stringify({ disclosure: { licensedEntity: 'Draft Tenant Money LLC' } })}::jsonb
      WHERE id = 'p_draft_tenant'`);
    drafts.set(DRAFT_ID, {
      senderPhone: PHONE,
      partnerId: 'p_draft_tenant',
      recipient: { name: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '' },
      amountUsd: 200, amountSource: 200, sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
      fundingMethod: 'bank_transfer',
      quote: { feeUsd: 0, fxRate: 85, amountInr: 17000 },
    });
    // The mint: a transfer of the draft's tenant, saved in PGlite, as finalizeDraftPayment would leave it.
    finalize.mockImplementation(async (_stores: unknown, draftId: string) => {
      expect(draftId).toBe(DRAFT_ID);
      await store.saveTransfer({ ...transfer, id: MINTED, partnerId: 'p_draft_tenant' });
      return { ok: true, transferId: MINTED };
    });
    await txOtp.issue(DRAFT_ID, PHONE);
    const draftReq = new NextRequest('http://x/api/pay/' + DRAFT_ID, {
      method: 'POST',
      body: JSON.stringify({ otp: '654321', disclosureVersion: 'disclosure-draft-2026-09-23b' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(draftReq, { params: Promise.resolve({ transferId: DRAFT_ID }) });
    expect(res.status).toBe(200);
    expect((await store.getTransfer(MINTED))?.status).toBe('paid');
    const rows = await ackRows();
    expect(rows).toEqual([
      {
        partner_id: 'p_draft_tenant',
        actor: 'pay-page',
        actor_type: 'system',
        action: 'remittance.disclosure_ack',
        subject_id: MINTED,
        meta: { version: 'disclosure-draft-2026-09-23b', providerKind: 'configured', shownHash: null, routeId: DRAFT_ID },
      },
    ]);
    const otp = (await db.execute(sql`SELECT partner_id, subject_id, meta FROM audit_events WHERE action = 'otp.verified'`)).rows as Array<{
      partner_id: string; subject_id: string; meta: Record<string, unknown>;
    }>;
    expect(otp).toHaveLength(1);
    expect(otp[0]).toMatchObject({ partner_id: 'p_draft_tenant', subject_id: MINTED, meta: { routeId: DRAFT_ID, surface: 'transfer' } });
  });
});
