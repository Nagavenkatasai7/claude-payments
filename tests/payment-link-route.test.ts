/**
 * Batch B2: POST /api/pay/l/[token]. The switch off / not a demo phone ⇒ the
 * one 404 and no code sent; the code gates the payment; a paid link becomes
 * ONE paid transfer (same capture + settle path as the hosted pay page).
 */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { createTransactionOtpStore } from '@/lib/transaction-otp';
import { createLinkQuoteStore } from '@/lib/payment-link-quote';
import { invalidateFlagCache } from '@/lib/flags';
import { DISCLOSURE_DRAFT_VERSION } from '@/lib/legal/disclosure-drafts';
import { linkExpiresAt, newLinkToken } from '@/lib/payment-links';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { createPayeeRepo } from '@/db/repos/payee-repo';
import { createPaymentLinkRepo } from '@/db/repos/payment-link-repo';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import type { Customer } from '@/lib/types';
import { MintRefusedError } from '@/lib/transfer-create';
import { fixedReply } from '@/lib/hold-replies';
import { primeOfacSource, restoreOfacSource, setRailProviderType } from './helpers-sanctions';
import { seedPartner } from './helpers-db';
import { approveDisclosureForTest, certifyPartnerForTest } from './helpers-live';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { resolvePartnerDisclosure } from '@/lib/partner-config';
import { PAY_APPROVAL_NOT_RECORDED_COPY, PAY_RELOAD_REQUIRED_COPY } from '@/lib/pay-outcome';

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
let partnerStore: ReturnType<typeof createPartnerStore>;
let txOtp: ReturnType<typeof createTransactionOtpStore>;
let quotes: ReturnType<typeof createLinkQuoteStore>;
vi.mock('@/db/client', async (orig) => ({ ...(await orig<typeof import('@/db/client')>()), getDb: () => db }));
vi.mock('@/lib/store', async (orig) => ({ ...(await orig<typeof import('@/lib/store')>()), getStore: () => store }));
vi.mock('@/lib/customer-store', async (orig) => ({ ...(await orig<typeof import('@/lib/customer-store')>()), getCustomerStore: () => customerStore }));
vi.mock('@/lib/partner-store', async (orig) => ({ ...(await orig<typeof import('@/lib/partner-store')>()), getPartnerStore: () => partnerStore }));
vi.mock('@/lib/monthly-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/monthly-volume-store')>()), getMonthlyVolumeStore: () => createMonthlyVolumeStore(store) }));
vi.mock('@/lib/daily-volume-store', async (orig) => ({ ...(await orig<typeof import('@/lib/daily-volume-store')>()), getDailyVolumeStore: () => createDailyVolumeStore(store) }));
vi.mock('@/lib/transaction-otp', async (orig) => ({ ...(await orig<typeof import('@/lib/transaction-otp')>()), getTransactionOtpStore: () => txOtp }));
vi.mock('@/lib/payment-link-quote', async (orig) => ({ ...(await orig<typeof import('@/lib/payment-link-quote')>()), getLinkQuoteStore: () => quotes }));
// Pack 3: the rail config per partner (empty ⇒ the mock rail, as before); a test may switch it.
const linkRails = vi.hoisted(() => ({ byPartner: {} as Record<string, unknown> }));
vi.mock('@/lib/partner-integrations-store', () => ({
  getPartnerIntegrationsStore: () => ({
    getIntegrations: async (id: string) => ({ kyc: {}, payment: linkRails.byPartner[id] ?? {}, whatsapp: {} }),
  }),
}));
// Pack 3: the real mock funding provider, with a switch to decline the capture (a minted,
// unpaid transfer the customer resumes later) and a count of capture calls.
const funding = vi.hoisted(() => ({ decline: false, captures: 0 }));
vi.mock('@/lib/providers/funding-provider', async (orig) => {
  const real = await orig<typeof import('@/lib/providers/funding-provider')>();
  return {
    ...real,
    getFundingProvider: () => {
      const p = real.getFundingProvider();
      const capture = p.capture.bind(p);
      p.capture = async (t) => {
        funding.captures++;
        if (funding.decline) throw new Error('card declined');
        return capture(t);
      };
      return p;
    },
  };
});
vi.mock('@/lib/ip-rate-limit', () => ({ enforceIpRateLimit: async () => null }));
// Fix pack 4 T10: a partner certified for live money never sends codes on the
// shared number (direct-otp-channel.ts); the R18 cases' owner 'acme' is given
// the shared number here so the gate (not the channel rule) is what is tested.
const sharedChannelFor = vi.hoisted(() => new Set<string>());
vi.mock('@/lib/direct-otp-channel', async (orig) => {
  const real = await orig<typeof import('@/lib/direct-otp-channel')>();
  return {
    ...real,
    resolveDirectOtpChannel: (...a: Parameters<typeof real.resolveDirectOtpChannel>) =>
      a[0] && sharedChannelFor.has(a[0]) ? Promise.resolve({ ok: true as const, creds: undefined }) : real.resolveDirectOtpChannel(...a),
  };
});

import { POST } from '@/app/api/pay/l/[token]/route';

const PHONE = '14155550100';
const T0 = '2026-05-01T00:00:00.000Z';

let token: string;
let linkId: string;
let lockedAt: string; // the lock identity the page rendered (LinkPayForm posts it back)
let redis: ReturnType<typeof fakeRedis>;

const req = (b: object) =>
  new NextRequest(`http://x/api/pay/l/${token}`, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
const call = (b: object, t = token) => POST(req(b), { params: Promise.resolve({ token: t }) });
type EvRow = { action: string; actor: string; partner_id: string | null; subject_id: string | null; meta: Record<string, unknown> };
const evidenceRows = async (): Promise<EvRow[]> =>
  ((await db.execute(sql`SELECT action, actor, partner_id, subject_id, meta FROM audit_events
    WHERE action IN ('otp.verified', 'remittance.disclosure_ack') ORDER BY id`)) as unknown as { rows: EvRow[] }).rows;
const count = async (q: string) => Number(((await db.execute(sql.raw(q))) as unknown as { rows: Array<{ n: number }> }).rows[0].n);

async function flag(enabled: boolean) {
  await createFeatureFlagRepo(db).upsert({ key: 'paylinks.enabled', scopeType: 'global', scopeId: '', enabled, reason: 't', updatedBy: 'admin' });
  invalidateFlagCache(db);
}

beforeEach(async () => {
  vi.stubEnv('DEMO_PHONES', '*');
  const r = fakeRedis();
  redis = r;
  db = await freshDb();
  invalidateFlagCache(db);
  store = createStore(r, db);
  customerStore = createCustomerStore(db, store);
  partnerStore = createPartnerStore(db);
  txOtp = createTransactionOtpStore(r, { randomInt: () => 654321 });
  quotes = createLinkQuoteStore(r);
  await flag(true);
  await customerStore.saveCustomer({
    senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Asha Patel', senderCountry: 'US',
    partnerId: 'default', createdAt: T0, updatedAt: T0,
  } as Customer);
  const payees = createPayeeRepo(db);
  await payees.insert({
    id: 'pye_1', partnerId: 'default', legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
    payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
  });
  await payees.decide('pye_1', ['pending'], 'approved', 'admin');
  token = newLinkToken();
  linkId = 'pl_route1';
  await createPaymentLinkRepo(db).insertLinks([{
    id: linkId, partnerId: 'default', payeeId: 'pye_1', token, reference: 'INV-77', customerName: 'Asha Patel',
    customerPhone: PHONE, amountInr: 25000, purpose: 'education', expiresAt: linkExpiresAt(), createdBy: 'pa',
  }]);
  lockedAt = (await quotes.lock(linkId, { toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' })).lockedAt;
  sendTransactionOtp.mockClear();
  linkRails.byPartner = {};
  sharedChannelFor.clear();
  funding.decline = false;
  funding.captures = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/pay/l/[token]', () => {
  it('request_otp sends a code to the link phone (SmartRemit wording), nothing minted', async () => {
    const res = await call({ action: 'request_otp' });
    expect(await res.json()).toEqual({ ok: true, sent: true });
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', undefined, undefined, undefined, expect.any(Object));
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });

  it('switch off ⇒ the one 404, no code sent, nothing saved', async () => {
    await flag(false);
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('This payment link is no longer active.');
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    const pay = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(pay.status).toBe(404);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });

  it('not a demo phone ⇒ the same 404, no code sent', async () => {
    vi.stubEnv('DEMO_PHONES', '19998887777');
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(404);
    expect(sendTransactionOtp).not.toHaveBeenCalled();
  });

  it('an unknown or malformed token ⇒ the same 404', async () => {
    expect((await call({ action: 'request_otp' }, 'nope')).status).toBe(404);
    expect((await call({ action: 'request_otp' }, newLinkToken())).status).toBe(404);
  });

  it('a wrong or missing code ⇒ 403, nothing minted, the link stays open', async () => {
    await call({ action: 'request_otp' });
    expect((await call({ otp: '000000', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt })).status).toBe(403);
    expect((await call({ fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt })).status).toBe(403);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM payment_links WHERE status = 'open'`)).toBe(1);
  });

  it('no funding method ⇒ 400 before the code is checked', async () => {
    await call({ action: 'request_otp' });
    expect((await call({ otp: '654321', quoteLockedAt: lockedAt })).status).toBe(400);
    // The code was not burned: the real pay still works.
    expect((await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt })).status).toBe(200);
  });

  it('no locked rate ⇒ 409 quote_expired, the code not burned', async () => {
    quotes = createLinkQuoteStore(fakeRedis());
    await call({ action: 'request_otp' });
    const res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('quote_expired');
  });

  it('the right code ⇒ ONE paid transfer to the payee; a replay reports it, never a second', async () => {
    await call({ action: 'request_otp' });
    const res = await call({ otp: '654321', fundingMethod: 'debit_card', disclosureVersion: DISCLOSURE_DRAFT_VERSION, quoteLockedAt: lockedAt });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const t = await store.getTransfer(body.transferId);
    expect(t).toMatchObject({ status: 'paid', amountInr: 25000, feeUsd: 2.99, clientReference: 'INV-77', purpose: 'education' });
    expect(await count(`SELECT count(*)::int AS n FROM payment_links WHERE status = 'used' AND transfer_id = '${body.transferId}'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'remittance.disclosure_ack' AND subject_id = '${body.transferId}'`)).toBe(1);
    // Fix pack 4 (C17): the evidence rows, written by pay-process before the capture.
    const rows = await evidenceRows();
    expect(rows.filter((r) => r.action === 'otp.verified')).toHaveLength(1);
    const otpRow = rows.find((r) => r.action === 'otp.verified')!;
    expect(otpRow).toMatchObject({ actor: 'pay-page', subject_id: body.transferId, partner_id: 'default' });
    expect(otpRow.meta).toMatchObject({ surface: 'link', routeId: linkId, disclosureVersion: DISCLOSURE_DRAFT_VERSION });
    const ackRow = rows.find((r) => r.action === 'remittance.disclosure_ack')!;
    expect(ackRow.actor).toBe('pay-page');
    expect(ackRow.meta).toEqual({ version: DISCLOSURE_DRAFT_VERSION, providerKind: 'demo', shownHash: null, routeId: linkId });
    const snap = await createTransferRepo(db).getDisclosureSnapshot(body.transferId, 'default');
    expect(snap).not.toBeNull();
    expect(snap?.surface).toBe('link');
    // The link is used and paid: the same 404 as any other unpayable link.
    expect((await call({ action: 'request_otp' })).status).toBe(404);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(1);
  });

  it('the lock the page showed: a missing or different lock ⇒ 409 quote_expired, nothing minted, the code not burned', async () => {
    await call({ action: 'request_otp' });
    for (const quoteLockedAt of [undefined, '', '2026-01-01T00:00:00.000Z', 42]) {
      const res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt });
      expect(res.status).toBe(409);
      expect((await res.json()).reason).toBe('quote_expired');
    }
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
    // The matching lock pays (the code was never spent on a refusal).
    const ok = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(ok.status).toBe(200);
    expect((await store.getTransfer((await ok.json()).transferId))?.fxRate).toBe(85);
  });

  it('an old tab after the lock lapsed and a later visit locked a NEW rate ⇒ 409, never charged at the new rate', async () => {
    // 16 minutes later: the old lock has lapsed; a new page view locks 90.
    const later = createLinkQuoteStore(redis, { now: () => Date.now() + 16 * 60_000 });
    expect(await later.get(linkId)).toBeNull();
    const fresh = await later.lock(linkId, { toInr: 90, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' });
    quotes = later;
    expect(fresh.lockedAt).not.toBe(lockedAt);
    await call({ action: 'request_otp' });
    const stale = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(stale.status).toBe(409);
    expect((await stale.json()).reason).toBe('quote_expired');
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });

  it('the evidence write fails (the same trigger) -> 503 approval_not_recorded; the minted transfer stays awaiting_payment, nothing captured; one warn naming the error only', async () => {
    // The evidence INSERT fails the way a real query error does (message + params).
    await db.execute(sql.raw(`CREATE FUNCTION fail_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ack-leak %', NEW.subject_id; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER fail_ack BEFORE INSERT ON audit_events FOR EACH ROW
      WHEN (NEW.action = 'remittance.disclosure_ack') EXECUTE FUNCTION fail_ack()`));
    // freshDb keeps triggers on the shared PGlite: drop them (one statement per call).
    onTestFinished(async () => {
      await db.execute(sql.raw('DROP TRIGGER IF EXISTS fail_ack ON audit_events'));
      await db.execute(sql.raw('DROP FUNCTION IF EXISTS fail_ack()'));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    await call({ action: 'request_otp' });
    const res = await call({ otp: '654321', fundingMethod: 'bank_transfer', disclosureVersion: DISCLOSURE_DRAFT_VERSION, quoteLockedAt: lockedAt });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'approval_not_recorded', error: PAY_APPROVAL_NOT_RECORDED_COPY });
    expect(typeof body.transferId).toBe('string'); // the page reads it on every status
    expect((await store.getTransfer(body.transferId))?.status).toBe('awaiting_payment');
    expect(funding.captures).toBe(0);
    expect(await evidenceRows()).toEqual([]);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('pay.evidence-unavailable'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]) as { msg: string };
    expect(line.msg).toMatch(/^[A-Za-z]*Error$/);
    expect(lines[0]).not.toContain('ack-leak');
    expect(lines[0]).not.toContain('insert into');
  });

  it('an unexpected failure logs the error NAME only (never a token or a name riding in the message)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'getTransfer').mockRejectedValue(
      new Error(`Failed query: select * from payment_links where token = $1 params: ${token},Asha Patel`),
    );
    // A claimed link reads its transfer while resolving: that read throws.
    await db.execute(sql.raw(`UPDATE payment_links SET status = 'used', transfer_id = 'tx_x' WHERE id = '${linkId}'`));
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(400);
    const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('paylink.route'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('Error');
    expect(lines[0]).not.toContain(token);
    expect(lines[0]).not.toContain('Asha');
    err.mockRestore();
    vi.restoreAllMocks();
  });
});

// Pack 3 T3 (contract 5): a live control refused the mint AFTER the claim.
// The common live refusal never reaches this arm (T4 adds a pre-claim check
// that keeps the link OPEN); this arm stays for capability_off (T12) and races.
describe('POST /api/pay/l/[token] — MintRefusedError at the mint (pack 3)', () => {
  it('a MintRefusedError at the mint (stubbed AFTER the claim) ⇒ 409 not_available with the cannot_complete text; no transfer row; the link is left claimed and a retry re-mints that same id', async () => {
    const spy = vi.spyOn(store, 'mintUnderSenderLock').mockRejectedValueOnce(new MintRefusedError('live_not_certified'));
    await call({ action: 'request_otp' });
    const res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
    // Left claimed exactly like a sends.paused refusal under the claim: 'used',
    // bound to the unminted id, one paylink.claim audit row.
    const row = ((await db.execute(sql.raw(`SELECT status, transfer_id FROM payment_links WHERE id = '${linkId}'`))) as unknown as {
      rows: Array<{ status: string; transfer_id: string | null }>;
    }).rows[0];
    expect(row.status).toBe('used');
    expect(row.transfer_id).toMatch(/\S/);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'paylink.claim'`)).toBe(1);
    spy.mockRestore();

    // The retry (the refusal is gone) re-mints that same id: one transfer.
    // (A fresh OTP store: the first code was spent and the issue cooldown
    // would refuse a second code this soon.)
    txOtp = createTransactionOtpStore(fakeRedis(), { randomInt: () => 654321 });
    await call({ action: 'request_otp' });
    const retry = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(retry.status).toBe(200);
    expect((await retry.json()).transferId).toBe(row.transfer_id);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'paylink.claim'`)).toBe(1);
  });
});

// Pack 3 (contract 6): a link transfer minted while its rail was demo, resumed after the owner's
// rail turned http (real money) without certification — here the default tenant, which may never
// own real money — is refused at pay time BEFORE the capture: 409 not_available, never charged.
describe('POST /api/pay/l/[token] — pay-time live gate on resume (pack 3)', { retry: 0 }, () => {
  // Review R2-Q3 (H1): since fix pack 4 the link route's early R18 gate answers this one (the
  // default tenant's demo block is never approved): no code is issued, and pay-process's live gate
  // is never reached. The 'acme' resume below proves the live gate on this route.
  it('a minted link transfer whose owner rail turned http and is uncertified -> 409 not_available on resume from the early R18 gate (no code issued, no live-gate warn), never charged', async () => {
    // 1. Minted on the mock rail, but the capture is declined: a minted, unpaid transfer.
    funding.decline = true;
    await call({ action: 'request_otp' });
    const first = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(first.status).toBe(402);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(1);
    const tid = ((await db.execute(sql.raw('SELECT id FROM transfers'))) as unknown as { rows: Array<{ id: string }> }).rows[0].id;
    expect((await store.getTransfer(tid))?.status).toBe('awaiting_payment');

    // 2. The owner's rail turns http (stored type too: live-gate.ts reads it there).
    linkRails.byPartner.default = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } };
    await setRailProviderType(db, 'default', 'http');
    // Real money screens (payee, sender, recipient) only on a live list (fix pack 2).
    const originalList = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    onTestFinished(() => restoreOfacSource(originalList));
    funding.decline = false;
    funding.captures = 0;

    // 3. The resume is refused before any capture. (A fresh OTP store: the issue cooldown.)
    const resumeRedis = fakeRedis();
    txOtp = createTransactionOtpStore(resumeRedis, { randomInt: () => 654321 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    // Fix pack 4 (C10 c): the default owner on a real-money rail is mandatory and its
    // demo block is never approved, so no code is sent at all.
    const otp = await call({ action: 'request_otp' });
    expect(otp.status).toBe(409);
    expect(await otp.json()).toMatchObject({ ok: false, reason: 'not_available' });
    expect([...resumeRedis.dump.keys()].filter((k) => k.startsWith('txotp:'))).toEqual([]); // no code issued
    const res = await call({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: lockedAt });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('pay.live-refused'))).toEqual([]);
    expect(funding.captures).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(1);
    const t = await store.getTransfer(tid);
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef).toBeFalsy();
  });
  // Review R2-Q3 (H1 b): the early R18 gate passes (an approved block, a complete request), so on
  // resume the refusal must come from pay-process's live gate (liveRefusalForRail).
  it('a minted link transfer of a NON-default uncertified owner whose rail turned http, APPROVED block, complete request -> 409 not_available from the pay-time LIVE gate: one pay.live-refused warn, no capture, no evidence rows', async () => {
    const ACME_LINK = 'pl_acme_live';
    await seedPartner(db, 'acme');
    await approveDisclosureForTest(db, 'acme');
    sharedChannelFor.add('acme');
    await customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Asha Patel', senderCountry: 'US',
      partnerId: 'acme', createdAt: T0, updatedAt: T0,
    } as Customer);
    const payees = createPayeeRepo(db);
    await payees.insert({
      id: 'pye_acme_live', partnerId: 'acme', legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
      payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
    });
    await payees.decide('pye_acme_live', ['pending'], 'approved', 'admin');
    const acmeToken = newLinkToken();
    await createPaymentLinkRepo(db).insertLinks([{
      id: ACME_LINK, partnerId: 'acme', payeeId: 'pye_acme_live', token: acmeToken, reference: 'INV-99', customerName: 'Asha Patel',
      customerPhone: PHONE, amountInr: 25000, purpose: 'education', expiresAt: linkExpiresAt(), createdBy: 'pa',
    }]);
    const acmeLock = (await quotes.lock(ACME_LINK, { toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' })).lockedAt;
    const acmeHash = resolvePartnerDisclosure(await createPartnerRepo(db).getPartner('acme')).hash!;
    const payBody = {
      otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock,
      disclosureVersion: DISCLOSURE_DRAFT_VERSION, disclosureHash: acmeHash, accountHolder: 'Sunrise School Trust',
    };

    // 1. Minted on the mock rail, the capture declined: a minted, unpaid transfer.
    funding.decline = true;
    expect((await call({ action: 'request_otp' }, acmeToken)).status).toBe(200);
    expect((await call(payBody, acmeToken)).status).toBe(402);
    const tid = ((await db.execute(sql.raw(`SELECT id FROM transfers WHERE partner_id = 'acme'`))) as unknown as { rows: Array<{ id: string }> }).rows[0].id;
    expect((await store.getTransfer(tid))?.status).toBe('awaiting_payment');
    // The declined first attempt wrote its own evidence (audit_events is append-only): the resume adds none.
    const evidenceBefore = await evidenceRows();

    // 2. The owner's rail turns http (stored type too); acme stays uncertified. A live list.
    linkRails.byPartner.acme = { providerType: 'http', credentials: { settlementUrl: 'https://rail.acme-test.com/settle', signingSecret: 's' } };
    await setRailProviderType(db, 'acme', 'http');
    const originalList = process.env.SANCTIONS_LIST;
    primeOfacSource({ checkedAgoMs: 3_600_000 });
    onTestFinished(() => restoreOfacSource(originalList));
    funding.decline = false;
    funding.captures = 0;

    // 3. The resume passes the early gate (a code is issued) and is refused by the live gate.
    const resumeRedis = fakeRedis();
    txOtp = createTransactionOtpStore(resumeRedis, { randomInt: () => 654321 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    expect((await call({ action: 'request_otp' }, acmeToken)).status).toBe(200);
    const res = await call(payBody, acmeToken);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('pay.live-refused'))).toHaveLength(1);
    expect(funding.captures).toBe(0);
    expect(await evidenceRows()).toEqual(evidenceBefore);
    const t = await store.getTransfer(tid);
    expect(t?.status).toBe('awaiting_payment');
    expect(t?.fundingRef).toBeFalsy();
  });
});

// Fix pack 4 T10 (C10, C12 link route, C5): the link route's R18 gate. The link
// owner 'acme' is certified for live money (so the acknowledgement is mandatory)
// and on the mock rail; the payee, the customer and the link are all acme's.
describe('link route R18 gate (pack 4)', { retry: 0 }, () => {
  const ACME_LINK = 'pl_acme1';
  let acmeToken: string;
  let acmeLock: string;
  const acmeCall = (b: object) => call(b, acmeToken);
  const acmeHash = async () => resolvePartnerDisclosure(await createPartnerRepo(db).getPartner('acme')).hash!;
  const codeKeys = () => [...redis.dump.keys()].filter((k) => /^txotp:[0-9a-f]+$/.test(k));
  const channelKeys = () => [...redis.dump.entries()].filter(([k]) => k.startsWith('txotp:ch:'));

  beforeEach(async () => {
    await seedPartner(db, 'acme');
    await certifyPartnerForTest(db, 'acme');
    sharedChannelFor.add('acme');
    await customerStore.saveCustomer({
      senderPhone: PHONE, firstSeenAt: T0, kycStatus: 'verified', fullName: 'Asha Patel', senderCountry: 'US',
      partnerId: 'acme', createdAt: T0, updatedAt: T0,
    } as Customer);
    const payees = createPayeeRepo(db);
    await payees.insert({
      id: 'pye_acme', partnerId: 'acme', legalName: 'Sunrise Public School', accountHolder: 'Sunrise School Trust',
      payoutDestination: 'HDFC0001234 50100123456789', last4: '6789', screening: 'clear', createdBy: 'pa',
    });
    await payees.decide('pye_acme', ['pending'], 'approved', 'admin');
    acmeToken = newLinkToken();
    await createPaymentLinkRepo(db).insertLinks([{
      id: ACME_LINK, partnerId: 'acme', payeeId: 'pye_acme', token: acmeToken, reference: 'INV-88', customerName: 'Asha Patel',
      customerPhone: PHONE, amountInr: 25000, purpose: 'education', expiresAt: linkExpiresAt(), createdBy: 'pa',
    }]);
    acmeLock = (await quotes.lock(ACME_LINK, { toInr: 85, fetchedAt: Date.now(), asOf: '2026-10-07', provider: 'ecb' })).lockedAt;
  });

  it('request_otp on an unapproved block -> 409 not_available, no code sent', async () => {
    const res = await acmeCall({ action: 'request_otp' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: fixedReply('cannot_complete'), reason: 'not_available' });
    expect(sendTransactionOtp).not.toHaveBeenCalled();
    expect(codeKeys()).toEqual([]);
  });

  it('approved block: request_otp -> 200 and the channel key is written', async () => {
    await approveDisclosureForTest(db, 'acme');
    sendTransactionOtp.mockResolvedValueOnce('wa');
    const res = await acmeCall({ action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sent: true });
    const ch = channelKeys();
    expect(ch).toHaveLength(1);
    expect(String(ch[0][1])).toMatch(/^\d+\|wa$/);
  });

  it('request_otp passes hooks.purpose payment (C5)', async () => {
    await approveDisclosureForTest(db, 'acme');
    await acmeCall({ action: 'request_otp' });
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', undefined, undefined, undefined, expect.objectContaining({ purpose: 'payment' }));
    // The default tenant's link sends the same purpose.
    sendTransactionOtp.mockClear();
    await call({ action: 'request_otp' });
    expect(sendTransactionOtp.mock.calls[0][5]).toMatchObject({ purpose: 'payment' });
  });

  it('pay without disclosureVersion -> 409 reload_required before the code is checked (the same code then pays with the version)', async () => {
    await approveDisclosureForTest(db, 'acme');
    await acmeCall({ action: 'request_otp' });
    const res = await acmeCall({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, reason: 'reload_required', error: PAY_RELOAD_REQUIRED_COPY });
    expect(codeKeys()).toHaveLength(1); // the code was not consumed
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
    const ok = await acmeCall({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock, disclosureVersion: DISCLOSURE_DRAFT_VERSION });
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe('paid');
  });

  it('a stale disclosureHash -> 409 reload_required', async () => {
    await approveDisclosureForTest(db, 'acme');
    await acmeCall({ action: 'request_otp' });
    const res = await acmeCall({
      otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock,
      disclosureVersion: DISCLOSURE_DRAFT_VERSION, disclosureHash: `dh1:${'0'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('reload_required');
    expect(codeKeys()).toHaveLength(1);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });

  // Review round 2 Q3: the early reload on a minted link row with a bound debit says funded,
  // never "nothing was charged" (the route passes transferFunded(payable.transfer)).
  it('a minted link row with a bound debit, then a stale disclosureHash -> 409 reload_required, funded: true, no "charged"', async () => {
    await approveDisclosureForTest(db, 'acme');
    const hash = await acmeHash();
    // 1. A declined first attempt leaves a minted, unpaid link transfer.
    funding.decline = true;
    await acmeCall({ action: 'request_otp' });
    const first = await acmeCall({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock, disclosureVersion: DISCLOSURE_DRAFT_VERSION, disclosureHash: hash });
    expect(first.status).toBe(402);
    const tid = ((await db.execute(sql.raw('SELECT id FROM transfers'))) as unknown as { rows: Array<{ id: string }> }).rows[0].id;
    // 2. A bank debit is bound to that row (still awaiting payment).
    expect(await createTransferRepo(db).bindFundingIntent(tid, 'acme', 'stripe', `pi_${tid}`)).toBeTruthy();
    expect(await store.getTransfer(tid)).toMatchObject({ status: 'awaiting_payment', fundingIntentRef: `pi_${tid}` });
    funding.decline = false;
    funding.captures = 0;
    // 3. An old tab posts a stale hash: refused before the code is checked, and funded.
    const res = await acmeCall({
      otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock,
      disclosureVersion: DISCLOSURE_DRAFT_VERSION, disclosureHash: `dh1:${'0'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, reason: 'reload_required', funded: true });
    expect(body.error).not.toMatch(/charged/i);
    expect(funding.captures).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(1);
  });

  it('R1-P4 B2: the code consume hits a network error -> 503 temporarily_unavailable (never the wrong-code 403); no transfer; the retry pays', async () => {
    await approveDisclosureForTest(db, 'acme');
    await acmeCall({ action: 'request_otp' });
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
    const body = { otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock, disclosureVersion: DISCLOSURE_DRAFT_VERSION };
    const res = await acmeCall(body);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false, error: 'Temporary problem. Please try again in a moment.', reason: 'temporarily_unavailable',
    });
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
    // The route logs the error NAME only.
    expect(err.mock.calls.map(([l]) => JSON.parse(String(l)).msg)).toEqual(['TypeError']);
    const ok = await acmeCall(body);
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe('paid');
  });

  it('pay on an unapproved block -> 409 not_available before the code is checked', async () => {
    // A code issued while the block was approved; the approval is then cleared.
    await approveDisclosureForTest(db, 'acme');
    await acmeCall({ action: 'request_otp' });
    await db.execute(sql`UPDATE partners SET support_config = support_config #- '{disclosure,approval}' WHERE id = 'acme'`);
    const res = await acmeCall({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock, disclosureVersion: DISCLOSURE_DRAFT_VERSION });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('not_available');
    expect(codeKeys()).toHaveLength(1);
    expect(await count('SELECT count(*)::int AS n FROM transfers')).toBe(0);
  });

  it('the matching hash -> 200 paid with the rows and snapshot', async () => {
    await approveDisclosureForTest(db, 'acme');
    sendTransactionOtp.mockResolvedValueOnce('wa');
    await acmeCall({ action: 'request_otp' });
    const hash = await acmeHash();
    const res = await acmeCall({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: acmeLock, disclosureVersion: DISCLOSURE_DRAFT_VERSION, disclosureHash: hash });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('paid');
    const rows = await evidenceRows();
    expect(rows.map((r) => r.action).sort()).toEqual(['otp.verified', 'remittance.disclosure_ack']);
    const otpRow = rows.find((r) => r.action === 'otp.verified')!;
    expect(otpRow).toMatchObject({ partner_id: 'acme', subject_id: body.transferId, actor: 'pay-page' });
    expect(otpRow.meta).toMatchObject({ surface: 'link', routeId: ACME_LINK, channel: 'wa', attempt: 1, disclosureVersion: DISCLOSURE_DRAFT_VERSION });
    const ackRow = rows.find((r) => r.action === 'remittance.disclosure_ack')!;
    expect(ackRow.meta).toEqual({ version: DISCLOSURE_DRAFT_VERSION, providerKind: 'configured', shownHash: hash, routeId: ACME_LINK });
    const snap = await createTransferRepo(db).getDisclosureSnapshot(body.transferId, 'acme');
    expect(snap).toMatchObject({ surface: 'link', shownHash: hash, configHash: hash });
    expect(snap?.provider).toMatchObject({ kind: 'configured', approved: true });
  });

  it('quote_expired keeps its place: a lapsed lock answers 409 quote_expired before the R18 check', async () => {
    await approveDisclosureForTest(db, 'acme');
    await acmeCall({ action: 'request_otp' });
    // No disclosureVersion (the R18 refusal would be reload_required) and a wrong lock.
    const res = await acmeCall({ otp: '654321', fundingMethod: 'bank_transfer', quoteLockedAt: '2026-01-01T00:00:00.000Z' });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('quote_expired');
    expect(codeKeys()).toHaveLength(1);
  });

  // Fix pack 4 T18 (C22 c): the link owner's approved provider line rides on the code text.
  it('request_otp for an approved link owner -> hooks.providerLine is the line', async () => {
    await approveDisclosureForTest(db, 'acme');
    const res = await acmeCall({ action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(sendTransactionOtp).toHaveBeenCalledWith(PHONE, '654321', undefined, undefined, undefined, expect.any(Object));
    expect(sendTransactionOtp.mock.calls[0][5]).toMatchObject({
      purpose: 'payment',
      providerLine: 'Payments by Acme Money Services LLC, licensed by State Department of Financial Services',
    });
  });

  it('the default-tenant link (owner read gives no partner) -> no providerLine key', async () => {
    const res = await call({ action: 'request_otp' });
    expect(res.status).toBe(200);
    expect(sendTransactionOtp.mock.calls[0][5]).not.toHaveProperty('providerLine');
    expect(sendTransactionOtp.mock.calls[0][5]).toMatchObject({ purpose: 'payment' });
  });
});
