/**
 * Fix pack 4 T9 (C12, C13, C7, C10): the pay route [transferId] reads its body
 * through parsePayBody, refuses a mandatory payment BEFORE a code is sent
 * (unapproved block) and BEFORE the code is checked (stale page, unapproved
 * block), notes which channel carried the code, and after a good code builds
 * ONE PaymentEvidence that pay-process commits before any charge.
 *
 * Owner 'acme': seeded in PGlite, certified for live money (so the R18
 * acknowledgement is mandatory), on a mock rail. The real transaction-OTP
 * store runs on a fake Redis, so "the code is not consumed" is observable.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import { PAY_APPROVAL_NOT_RECORDED_COPY, PAY_RELOAD_REQUIRED_COPY } from '@/lib/pay-outcome';
import { fixedReply } from '@/lib/hold-replies';
import { DISCLOSURE_DRAFT_VERSION } from '@/lib/legal/disclosure-drafts';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { seedEsignConsentForTest } from './helpers-esign';
import { approveDisclosureForTest, certifyPartnerForTest } from './helpers-live';
import { realMoneyPayBody } from './helpers-pay-evidence';
import { setRailProviderType } from './helpers-sanctions';
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
let redis: ReturnType<typeof fakeRedis>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
const drafts = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/draft-store', () => ({ getDraftStore: () => ({ getDraft: async (id: string) => drafts.get(id) ?? null }) }));
// The partner STORE (brand, KYC toggle, channel rule) knows no partner: the shared
// number, the default KYC gate. The R18 gate reads the owner from PGlite.
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => null,
    ensureDefaultPartner: async () => ({
      id: 'default', name: 'SmartRemit Default', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    }),
  }),
}));
// Fix pack 5 T13b: a current signing secret (no provider type: still the mock
// rail for pay-process), so a case whose stored rail type turns http passes the
// pre-verify money gate's rail half; its funding half passes on a Stripe-bound row.
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async () => ({ kyc: {}, payment: { credentials: { signingSecret: 's' } }, whatsapp: {} }),
  }),
}));
vi.mock('@/lib/ip-rate-limit', async (orig) => ({ ...(await orig<typeof import('@/lib/ip-rate-limit')>()), enforceIpRateLimit: async () => null }));
// The draft finalizer is observed (the pay path must reach it, never the outer catch).
const finalize = vi.hoisted(() => vi.fn());
vi.mock('@/lib/pay-finalize', async (orig) => ({ ...(await orig<typeof import('@/lib/pay-finalize')>()), finalizeDraftPayment: finalize }));

import { POST } from '@/app/api/pay/[transferId]/route';

const PHONE = '15551234567';
const TID = 'tx_r18_1';
const HEADERS = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', 'user-agent': 'R18TestBrowser/1.0' };

function makeTransfer(o: Partial<Transfer> & { id: string }): Transfer {
  return {
    phone: PHONE, amountUsd: 200, feeUsd: 5, totalChargeUsd: 205, fxRate: 85, amountInr: 17000,
    recipientName: 'Mom', recipientPhone: '919876543210', payoutMethod: 'bank', payoutDestination: '123456789012 HDFC0001234',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [], status: 'awaiting_payment',
    createdAt: new Date(Date.now() - 60_000).toISOString(), sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN',
    destinationCurrency: 'INR', partnerId: 'acme', amountSource: 200, feeSource: 5, totalChargeSource: 205, ...o,
  } as Transfer;
}
const customerFor = (partnerId: string): Customer => {
  const t0 = new Date(Date.now() - 86_400_000).toISOString();
  return { senderPhone: PHONE, firstSeenAt: t0, kycStatus: 'verified', fullName: 'Test Sender', senderCountry: 'US', partnerId, createdAt: t0, updatedAt: t0 } as Customer;
};

const post = (id: string, b: object) =>
  POST(new NextRequest('http://x/api/pay/' + id, { method: 'POST', body: JSON.stringify(b), headers: HEADERS }), {
    params: Promise.resolve({ transferId: id }),
  });

type Row = { action: string; partner_id: string | null; subject_id: string | null; meta: Record<string, unknown> };
const evidenceRows = async (): Promise<Row[]> =>
  ((await db.execute(sql`SELECT action, partner_id, subject_id, meta FROM audit_events
    WHERE action IN ('otp.verified', 'remittance.disclosure_ack') ORDER BY id`)) as unknown as { rows: Row[] }).rows;
const statusOf = async (id: string) => (await store.getTransfer(id))?.status;
const codeKeys = () => [...redis.dump.keys()].filter((k) => /^txotp:[0-9a-f]+$/.test(k));
const channelKeys = () => [...redis.dump.entries()].filter(([k]) => k.startsWith('txotp:ch:'));
const acmeHash = async () => resolvePartnerDisclosure(await createPartnerRepo(db).getPartner('acme')).hash!;

beforeEach(async () => {
  redis = fakeRedis();
  db = await freshDb();
  store = createStore(redis, db);
  customerStore = createCustomerStore(db, store);
  txOtp = createTransactionOtpStore(redis, { randomInt: () => 654321 });
  await seedPartner(db, 'acme');
  await certifyPartnerForTest(db, 'acme');
  await store.saveTransfer(makeTransfer({ id: TID }));
  await customerStore.saveCustomer(customerFor('acme'));
  // consent on file (pack 6 P5): the E-SIGN gate is not under test here
  await seedEsignConsentForTest(db, 'acme', PHONE);
  sendTransactionOtp.mockReset();
  sendTransactionOtp.mockResolvedValue(undefined);
  drafts.clear();
  finalize.mockReset();
});

describe('request_otp (C12 step 2)', { retry: 0 }, () => {
  it('block unapproved -> 409 not_available, no code issued, nothing sent', async () => {
    const res = await post(TID, { action: 'request_otp' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' });
    expect(codeKeys()).toEqual([]);
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it("approved -> 200 sent, and the channel key holds '<issuedAt>|wa'", async () => {
    await approveDisclosureForTest(db, 'acme');
    sendTransactionOtp.mockResolvedValue('wa');
    const before = Date.now();
    const res = await post(TID, { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(codeKeys()).toHaveLength(1);
    const ch = channelKeys();
    expect(ch).toHaveLength(1);
    const [issuedAt, channel] = ch[0][1].split('|');
    expect(channel).toBe('wa');
    expect(Number(issuedAt)).toBeGreaterThanOrEqual(before);
    expect(Number(issuedAt)).toBeLessThanOrEqual(Date.now());
  });

  it('a send mock returning undefined -> no channel key, still 200', async () => {
    await approveDisclosureForTest(db, 'acme');
    const res = await post(TID, { action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(codeKeys()).toHaveLength(1);
    expect(channelKeys()).toEqual([]);
  });

  it("passes hooks.purpose 'payment' to sendTransactionOtp (C5)", async () => {
    await approveDisclosureForTest(db, 'acme');
    await post(TID, { action: 'request_otp' });
    expect(sendTransactionOtp).toHaveBeenCalledOnce();
    expect(sendTransactionOtp.mock.calls[0][5]).toMatchObject({ purpose: 'payment' });
  });

  it('legacyTenantOf throws (a pre-fix-1 draft) -> 502 otp_send_failed, no code issued (critic P7)', async () => {
    drafts.set('d_legacy', { senderPhone: PHONE });
    vi.spyOn(store, 'legacyTenantOf').mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const res = await post('d_legacy', { action: 'request_otp' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, reason: 'otp_send_failed' });
    expect(codeKeys()).toEqual([]);
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });
});

describe('pay, before the code is checked (C12 step 3)', { retry: 0 }, () => {
  beforeEach(async () => {
    await approveDisclosureForTest(db, 'acme');
    await txOtp.issue(TID, PHONE);
  });

  it('no disclosureVersion -> 409 reload_required; the code is NOT consumed (a second POST with the version pays)', async () => {
    const res = await post(TID, { otp: '654321' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(await statusOf(TID)).toBe('awaiting_payment');
    expect(await evidenceRows()).toEqual([]);
    const again = await post(TID, realMoneyPayBody());
    expect(again.status).toBe(200);
    expect(await statusOf(TID)).toBe('paid');
  });

  it('a stale disclosureHash -> 409 reload_required, the code not consumed', async () => {
    const res = await post(TID, realMoneyPayBody({ disclosureHash: `dh1:${'0'.repeat(64)}` }));
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(codeKeys()).toHaveLength(1);
    expect(await evidenceRows()).toEqual([]);
    expect((await post(TID, realMoneyPayBody({ disclosureHash: await acmeHash() }))).status).toBe(200);
  });

  it('version only (no hash) -> paid', async () => {
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(200);
    expect(await statusOf(TID)).toBe('paid');
  });

  it('matching hash -> paid', async () => {
    const res = await post(TID, realMoneyPayBody({ disclosureHash: await acmeHash() }));
    expect(res.status).toBe(200);
    expect(await statusOf(TID)).toBe('paid');
  });

  it('R1-P4 B2: the code consume hits a network error -> 503 temporarily_unavailable (never the wrong-code 403); nothing charged; the retry pays', async () => {
    let fail = true;
    const consume = {
      ...redis,
      async getdel(k: string) {
        if (fail) {
          fail = false;
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        }
        return redis.getdel(k);
      },
    };
    txOtp = createTransactionOtpStore(redis, { randomInt: () => 654321, consume });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => err.mockRestore());
    const issuedBefore = [...redis.dump.entries()].filter(([k]) => k.startsWith('txotp:issued:'));
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable',
    });
    expect(await statusOf(TID)).toBe('awaiting_payment');
    expect(await evidenceRows()).toEqual([]);
    // The issue budget is untouched, and the error is logged by the scrubbing logger only.
    expect([...redis.dump.entries()].filter(([k]) => k.startsWith('txotp:issued:'))).toEqual(issuedBefore);
    for (const [line] of err.mock.calls) expect(() => JSON.parse(String(line))).not.toThrow();
    const again = await post(TID, realMoneyPayBody());
    expect(again.status).toBe(200);
    expect(await statusOf(TID)).toBe('paid');
  });

  it('R2-Q1 B4: a consume that throws a bare TypeError(fetch failed) (no cause code) -> 503 temporary, not the wrong code; nothing charged, no evidence', async () => {
    const consume = { ...redis, async getdel(): Promise<string | null> { throw new TypeError('fetch failed'); } };
    txOtp = createTransactionOtpStore(redis, { randomInt: () => 654321, consume });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    onTestFinished(() => err.mockRestore());
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable',
    });
    expect(await statusOf(TID)).toBe('awaiting_payment');
    expect(await evidenceRows()).toEqual([]);
  });

  it('a wrong code on a mandatory payment with a good body -> 403, no rows', async () => {
    const res = await post(TID, realMoneyPayBody({ otp: '000000' }));
    expect(res.status).toBe(403);
    expect(await evidenceRows()).toEqual([]);
    expect(await statusOf(TID)).toBe('awaiting_payment');
  });

  it('paid: one otp.verified row, one ack row with shownHash, a snapshot of the row; no raw IP or user-agent', async () => {
    const hash = await acmeHash();
    const res = await post(TID, realMoneyPayBody({ disclosureHash: hash }));
    expect(res.status).toBe(200);
    const rows = await evidenceRows();
    expect(rows.map((r) => r.action)).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    const [otp, ack] = rows;
    expect(otp).toMatchObject({ partner_id: 'acme', subject_id: TID });
    expect(otp.meta).toMatchObject({ surface: 'transfer', routeId: TID, disclosureVersion: DISCLOSURE_DRAFT_VERSION });
    expect(otp.meta.payloadHash).toMatch(/^ph1:[0-9a-f]{64}$/);
    expect(otp.meta.ipHash).toMatch(/^[0-9a-f]{32}$/);
    expect(otp.meta.uaHash).toMatch(/^[0-9a-f]{32}$/);
    expect(otp.meta.attempt).toBe(1);
    expect(typeof otp.meta.issuedAt).toBe('string');
    expect(ack).toMatchObject({ partner_id: 'acme', subject_id: TID });
    expect(ack.meta).toEqual({ version: DISCLOSURE_DRAFT_VERSION, providerKind: 'configured', shownHash: hash, routeId: TID });
    const all = JSON.stringify(rows);
    expect(all).not.toContain('203.0.113.7');
    expect(all).not.toContain('R18TestBrowser');
    expect(all).not.toContain('654321');
    expect(all).not.toContain(PHONE);
    const snap = await createTransferRepo(db).getDisclosureSnapshot(TID, 'acme');
    expect(snap).not.toBeNull();
    expect(snap!.shownHash).toBe(hash);
    expect(snap!.surface).toBe('transfer');
    expect(snap!.figures).toMatchObject({ amountSource: 200, feeSource: 5, totalChargeSource: 205, sourceCurrency: 'USD', amountDest: 17000, destinationCurrency: 'INR', fxRate: 85 });
  });

  it('the commit fails (trigger on audit_events) -> 503 approval_not_recorded, nothing charged, row awaiting_payment', async () => {
    await db.execute(sql.raw(`CREATE FUNCTION fail_r18_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'evidence-leak %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_r18_audit BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'otp.verified') EXECUTE FUNCTION fail_r18_audit()`));
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_r18_audit ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_r18_audit()'));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    const t = await store.getTransfer(TID);
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef ?? null).toBeNull();
    expect(await evidenceRows()).toEqual([]);
  });
});

describe('not mandatory: default tenant, b2b, an unresolvable draft owner', { retry: 0 }, () => {
  it('default tenant, no version -> paid as before; one otp.verified row; no ack row; no snapshot', async () => {
    await store.saveTransfer(makeTransfer({ id: 'tx_def', partnerId: 'default' }));
    await customerStore.saveCustomer(customerFor('default'));
    // consent on file (pack 6 P5): the E-SIGN gate is not under test here
    await seedEsignConsentForTest(db, 'default', PHONE);
    await txOtp.issue('tx_def', PHONE);
    const res = await post('tx_def', { otp: '654321' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'paid' });
    const rows = await evidenceRows();
    expect(rows.map((r) => [r.action, r.partner_id, r.subject_id])).toEqual([['otp.verified', 'default', 'tx_def']]);
    expect(rows[0].meta).toMatchObject({ disclosureVersion: null, routeId: 'tx_def' });
    expect(await createTransferRepo(db).getDisclosureSnapshot('tx_def', 'default')).toBeNull();
  });

  it('a b2b ACH transfer paid with a posted disclosureVersion -> one otp.verified row only, no ack, no snapshot (critic C9/P11)', async () => {
    await store.saveTransfer(makeTransfer({
      id: 'tx_b2b', fundingMethod: 'ach_pull', transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
      senderBusinessName: 'Buyer LLC', recipientBusinessName: 'Acme Supplies Pvt Ltd', recipientName: 'Acme Supplies',
    }));
    await txOtp.issue('tx_b2b', PHONE);
    const res = await post('tx_b2b', {
      otp: '654321', disclosureVersion: DISCLOSURE_DRAFT_VERSION,
      ach: { routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' },
    });
    expect(res.status).toBe(200);
    const rows = await evidenceRows();
    expect(rows.map((r) => r.action)).toEqual(['otp.verified']);
    expect(rows[0].meta).toMatchObject({ disclosureVersion: null, routeId: 'tx_b2b' });
    expect(await createTransferRepo(db).getDisclosureSnapshot('tx_b2b', 'acme')).toBeNull();
  });

  it("legacyTenantOf throws on the pay path -> the safe context; verify runs and the flow reaches finalizeDraftPayment, never the outer 400 'Payment failed' (critic M8)", async () => {
    drafts.set('d_legacy_pay', { senderPhone: PHONE });
    await txOtp.issue('d_legacy_pay', PHONE);
    vi.spyOn(store, 'legacyTenantOf').mockRejectedValue(new Error('db down postgres://user:pw@host/db'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    finalize.mockResolvedValue({ ok: false, error: 'bank_details_required' });
    const res = await post('d_legacy_pay', { otp: '654321' });
    expect(finalize).toHaveBeenCalledOnce();
    expect(finalize.mock.calls[0][1]).toBe('d_legacy_pay');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'bank_details_required' });
    expect(codeKeys()).toEqual([]); // the code was checked (and consumed)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('postgres://');
  });
});

// Review R1-P1 A1: a re-POST on an awaiting row whose bank debit is already
// bound (fundingIntentRef, fundingState 'pending') keeps the reason and status
// of each answer, but never tells the customer that nothing was charged.
describe('a funded awaiting row (review R1-P1 A1)', { retry: 0 }, () => {
  beforeEach(async () => {
    await approveDisclosureForTest(db, 'acme');
    expect(await createTransferRepo(db).bindFundingIntent(TID, 'acme', 'stripe', 'pi_r18_funded')).toBeTruthy();
    expect(await store.getTransfer(TID)).toMatchObject({ fundingIntentRef: 'pi_r18_funded', fundingState: 'pending', status: 'awaiting_payment' });
    await txOtp.issue(TID, PHONE);
  });

  it('a stale shown hash -> 409 reload_required with funded: true, and the text has no "charged"', async () => {
    const res = await post(TID, realMoneyPayBody({ disclosureHash: `dh1:${'0'.repeat(64)}` }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'reload_required', funded: true });
    expect(body.error).not.toMatch(/charged/i);
    expect(codeKeys()).toHaveLength(1);
  });

  it('no acknowledgement -> 409 reload_required with no "charged" claim', async () => {
    const res = await post(TID, { otp: '654321' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).not.toMatch(/charged/i);
  });

  it('review R3-X1 Q3: a valid ack and hash but NO accountHolder key (no name on file) -> 409 reload_required with funded: true, no "charged"', async () => {
    await setRailProviderType(db, 'acme', 'http'); // a real-money rail: the name field is required
    const { accountHolder: _drop, ...noHolder } = realMoneyPayBody();
    expect(await createTransferRepo(db).recipientIdentityMissing(TID, 'acme')).toBe(true);
    const res = await post(TID, noHolder);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'reload_required', funded: true });
    expect(body.error).not.toMatch(/charged/i);
    expect(codeKeys()).toHaveLength(1); // answered before the code is checked
  });

  it('the evidence commit fails -> 503 approval_not_recorded with funded: true, and the text has no "charged"', async () => {
    await db.execute(sql.raw(`CREATE FUNCTION fail_r18_audit_f() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'evidence-leak %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_r18_audit_f BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'otp.verified') EXECUTE FUNCTION fail_r18_audit_f()`));
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_r18_audit_f ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_r18_audit_f()'));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const res = await post(TID, realMoneyPayBody());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'approval_not_recorded', funded: true });
    expect(body.error).not.toMatch(/charged/i);
    expect((await store.getTransfer(TID))?.status).toBe('awaiting_payment');
  });
});
