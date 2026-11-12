/**
 * Fix pack 7 T16 (P14, D7): the funds rule on real money. A reject of a row
 * that carries a sanctions hold class (sanctions_review, sender_watchlist,
 * blocked) on a real-money rail keeps the funds: cancelled, the refund status
 * left as it is, no funding.refund, ONE rejectfunds:<id> ops alert and ONE
 * neutral rejectmsg:<id> customer message. A blocked paid row cancelled by the
 * rail or by the sender keeps its refund state the same way. The mock rail,
 * sandbox rows and non-sanctions holds refund exactly as before.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifiedQueuePartner, heldRowFor, platformReviewFor } from './helpers-hold';
import { seedRealMoneyRail } from './helpers-live';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { rejectTransfer } from '@/lib/dashboard-ops';
import { handleRailFailure } from '@/lib/rail-failure';
import { cancelWithinWindow } from '@/lib/sender-cancel';
import { beginSettlement } from '@/lib/settlement';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { buildRejectContactMessage, buildRailFailureMessage } from '@/lib/payment';
import { buildSenderCancelMessage } from '@/lib/legal/cancel-drafts';
import { classifyHold, hasSanctionsHold, type ClassifiedClass } from '@/lib/hold-queue';
import {
  LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON, RECIPIENT_IDENTITY_MISSING_REASON,
  RECIPIENT_WATCHLIST_REASON, SENDER_IDENTITY_MISSING_REASON, SENDER_SCREENING_REASON, SENDER_WATCHLIST_REASON,
} from '@/lib/compliance-config';
import { SANCTIONS_FUNDS_RULE } from '@/lib/sanctions/notices';
import type { PartnerIntegrations } from '@/lib/partner-integrations';

const poke = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => { poke.calls += 1; } };
});

// The rail read: a counter and a switch that makes it throw.
const railRead = vi.hoisted(() => ({ calls: 0, throws: false }));
vi.mock('@/db/repos/integrations-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/integrations-repo')>();
  return {
    ...real,
    createIntegrationsRepo: (...a: Parameters<typeof real.createIntegrationsRepo>) => {
      const repo = real.createIntegrationsRepo(...a);
      return {
        ...repo,
        paymentProviderType: async (...p: Parameters<typeof repo.paymentProviderType>) => {
          railRead.calls += 1;
          if (railRead.throws) throw new Error('rail read failed');
          return repo.paymentProviderType(...p);
        },
      };
    },
  };
});

// The sender flags read: a switch that makes it throw before any SQL, and (F4, early review EE2)
// one that runs a FAILING statement on the caller's handle first (a real SQL failure: Postgres
// aborts the transaction or savepoint it ran in), then delegates.
const flagsRead = vi.hoisted(() => ({ throws: false, sqlFails: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  const { sql: q } = await import('drizzle-orm');
  return {
    ...real,
    readSenderScreeningFlags: async (...a: Parameters<typeof real.readSenderScreeningFlags>) => {
      if (flagsRead.throws) throw new Error('flags read failed');
      if (flagsRead.sqlFails) await a[0].execute(q`select 1/0`);
      return real.readSenderScreeningFlags(...a);
    },
  };
});

const REJ = { actor: 'plat', reason: 'The match could not be cleared with the documents on file.' };
const BANNED = ['refund', 'review', 'report', 'compliance', 'aml', 'sanction', 'screening', 'watchlist', 'flag', 'investigat', 'fraud', 'suspicious'];

let db: Db;
let store: ReturnType<typeof createStore>;

type Row = { kind: string; dedupe_key: string | null; payload: Record<string, unknown> };
async function outbox(): Promise<Row[]> {
  return ((await db.execute(sql`SELECT kind, dedupe_key, payload FROM outbox ORDER BY id`)) as unknown as { rows: Row[] }).rows;
}
const byKey = async (k: string) => (await outbox()).filter((r) => r.dedupe_key === k);
const refunds = async () => (await outbox()).filter((r) => r.kind === 'funding.refund');
async function rejectMeta(id: string): Promise<Record<string, unknown>> {
  const r = (await db.execute(sql`SELECT meta FROM audit_events WHERE subject_id = ${id} AND action = 'transfer.reject' ORDER BY id`)) as unknown as {
    rows: Array<{ meta: Record<string, unknown> }>;
  };
  return r.rows[0]?.meta ?? {};
}
const load = async (id: string) => (await createTransferRepo(db).getTransfer(id))!;
async function setReasons(id: string, reasons: string[]): Promise<void> {
  await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify(reasons)}::jsonb WHERE id = ${id}`);
}
const rejectFundsText = (id: string, owner: string) =>
  `⚠️ SmartRemit ops: transfer ${id} (partner ${owner}) was rejected while a sanctions screening hold was on it. ` +
  `It is cancelled and NOT refunded: ${SANCTIONS_FUNDS_RULE}. The partner blocks or returns the funds on its own processor or rail; ` +
  `once the partner's compliance officer has approved a return and the money is back with the sender, record it with "Record refund made outside SmartRemit".`;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  poke.calls = 0;
  railRead.calls = 0;
  railRead.throws = false;
  flagsRead.throws = false;
  flagsRead.sqlFails = false;
});

/** An uncertified owner on an http (real-money) rail. */
async function httpOwner(id = 'acme'): Promise<string> {
  await seedPartner(db, id);
  await seedRealMoneyRail(db, id);
  return id;
}

const cls = (holdClass: ClassifiedClass['holdClass']): ClassifiedClass => ({ holdClass, reasons: [], decider: 'platform' });
const Q = { queue: false, partnerDecidesKyc: false };

describe('hasSanctionsHold (pure)', { retry: 0 }, () => {
  it('1: true for sanctions_review, sender_watchlist and blocked classes; false for sender_pep, kyc, list_wait, data_missing and []', () => {
    expect(hasSanctionsHold(classifyHold([POSSIBLE_MATCH_REASON], undefined, Q))).toBe(true);
    expect(hasSanctionsHold(classifyHold([SENDER_IDENTITY_MISSING_REASON], undefined, Q))).toBe(true);
    expect(hasSanctionsHold(classifyHold([SENDER_SCREENING_REASON], { pepHit: false, watchlistHit: true }, Q))).toBe(true);
    const stampOnly = { pepHit: null, watchlistHit: null, screeningFlaggedAt: new Date(Date.now() - 60_000), screeningClearedAt: null };
    expect(hasSanctionsHold(classifyHold([SENDER_SCREENING_REASON], stampOnly, Q))).toBe(true);
    expect(hasSanctionsHold(classifyHold([SENDER_SCREENING_REASON], null, Q))).toBe(true);
    // A watchlist stamp that landed after the hold (no SENDER_SCREENING reason): the synthetic class.
    const later = { pepHit: null, watchlistHit: true, screeningFlaggedAt: new Date(), screeningClearedAt: null, screeningWatchlistAt: new Date() };
    expect(hasSanctionsHold(classifyHold([LARGE_AMOUNT_REASON], later, Q))).toBe(true);
    expect(hasSanctionsHold(classifyHold([RECIPIENT_WATCHLIST_REASON], undefined, Q))).toBe(true);
    expect(hasSanctionsHold(classifyHold([SENDER_WATCHLIST_REASON], undefined, Q))).toBe(true);
    expect(hasSanctionsHold(classifyHold([LARGE_AMOUNT_REASON], undefined, Q, { blocked: true }))).toBe(true);

    const pepOnly = { pepHit: true, watchlistHit: false, screeningFlaggedAt: new Date(Date.now() - 60_000), screeningClearedAt: null, screeningWatchlistAt: null };
    expect(classifyHold([SENDER_SCREENING_REASON], pepOnly, Q).map((c) => c.holdClass)).toEqual(['sender_pep']);
    expect(hasSanctionsHold(classifyHold([SENDER_SCREENING_REASON], pepOnly, Q))).toBe(false);
    expect(hasSanctionsHold(classifyHold([LARGE_AMOUNT_REASON], undefined, Q))).toBe(false);
    expect(hasSanctionsHold(classifyHold([LIST_UNAVAILABLE_REASON], undefined, Q))).toBe(false);
    expect(hasSanctionsHold(classifyHold([RECIPIENT_IDENTITY_MISSING_REASON], undefined, Q))).toBe(false);
    expect(hasSanctionsHold([])).toBe(false);
    expect(hasSanctionsHold([cls('kyc'), cls('aml'), cls('sender_pep'), cls('list_wait'), cls('data_missing'), cls('unknown')])).toBe(false);
    for (const c of ['sanctions_review', 'sender_watchlist', 'blocked'] as const) expect(hasSanctionsHold([cls('kyc'), cls(c)])).toBe(true);
  });
});

describe('rejectTransfer: the funds rule (D7)', { retry: 0 }, () => {
  it('2: platform reject, http rail, CHARGED POSSIBLE_MATCH row (uncertified owner): cancelled, refund none, rejectfunds + rejectmsg, fundsKept meta, one poke', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'fr_2', fundingRef: 'ch_fr_2' });
    await rejectTransfer(store, db, t.id, REJ);
    const after = await load(t.id);
    expect(after).toMatchObject({ status: 'cancelled' });
    expect(after.refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
    const alerts = await byKey(`rejectfunds:${t.id}`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('ops.alert');
    expect(alerts[0].payload).toEqual({ message: rejectFundsText(t.id, 'acme') });
    const msgs = await byKey(`rejectmsg:${t.id}`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].kind).toBe('whatsapp.text');
    expect(msgs[0].payload).toEqual({ to: t.phone, body: buildRejectContactMessage(after), partnerId: 'acme', category: 'essential' });
    const body = String(msgs[0].payload.body).toLowerCase();
    for (const w of BANNED) expect(body.includes(w), w).toBe(false);
    expect(await rejectMeta(t.id)).toMatchObject({ refundStatus: 'none', fundsKept: true });
    expect(poke.calls).toBe(1);
  });

  it('3: the same, UNCHARGED: one rejectfunds and one rejectmsg, fundsKept true', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'fr_3' });
    await rejectTransfer(store, db, t.id, REJ);
    expect((await load(t.id)).status).toBe('cancelled');
    expect(await byKey(`rejectfunds:${t.id}`)).toHaveLength(1);
    expect(await byKey(`rejectmsg:${t.id}`)).toHaveLength(1);
    expect(await refunds()).toEqual([]);
    expect(await rejectMeta(t.id)).toMatchObject({ refundStatus: 'none', fundsKept: true });
    expect(poke.calls).toBe(1);
  });

  it('4: the same row on the mock rail: refund pending + funding.refund as today; no rejectfunds, no rejectmsg, no fundsKept key', async () => {
    await seedPartner(db, 'acme');
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'fr_4', fundingRef: 'ch_fr_4' });
    await rejectTransfer(store, db, t.id, REJ);
    expect(await load(t.id)).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect((await outbox()).map((r) => [r.kind, r.dedupe_key])).toEqual([['funding.refund', `refund:${t.id}`]]);
    const meta = await rejectMeta(t.id);
    expect(meta).toEqual({ previousStatus: 'in_review', newStatus: 'cancelled', refundStatus: 'pending', reason: REJ.reason });
  });

  it('5: a sandbox (test) POSSIBLE_MATCH row of an http-rail owner: refunds as today, and no rail read', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'fr_5', fundingRef: 'ch_fr_5' });
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${t.id}`);
    railRead.calls = 0;
    await rejectTransfer(store, db, t.id, REJ);
    expect(await load(t.id)).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect((await outbox()).map((r) => r.dedupe_key)).toEqual([`refund:${t.id}`]);
    expect(railRead.calls).toBe(0);
  });

  it('6: http rail, charged row with only LARGE / LIST_UNAVAILABLE and a clean sender: refund as today', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'kyc', { id: 'fr_6', fundingRef: 'ch_fr_6' });
    await setReasons(t.id, [LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON]);
    await rejectTransfer(store, db, t.id, REJ);
    expect(await load(t.id)).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect((await outbox()).map((r) => r.dedupe_key)).toEqual([`refund:${t.id}`]);
    expect(await rejectMeta(t.id)).toEqual({ previousStatus: 'in_review', newStatus: 'cancelled', refundStatus: 'pending', reason: REJ.reason });
  });

  it('6b: http rail, SENDER_SCREENING with a PEP-only sender: refund pending as today, no rejectfunds', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'sender_pep', { id: 'fr_6b', fundingRef: 'ch_fr_6b' });
    await rejectTransfer(store, db, t.id, REJ);
    expect(await load(t.id)).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await byKey(`rejectfunds:${t.id}`)).toEqual([]);
    expect(await byKey(`refund:${t.id}`)).toHaveLength(1);
  });

  it('6c: http rail, [LARGE] whose sender got a WATCHLIST stamp after the hold: fundsKept, no funding.refund', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'kyc', { id: 'fr_6c', fundingRef: 'ch_fr_6c' });
    // O3: the later stamp is a SQL step (no SENDER_SCREENING reason on the row).
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now(), screening_watchlist_at = now()
      WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    await rejectTransfer(store, db, t.id, REJ);
    expect((await load(t.id)).refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
    expect(await byKey(`rejectfunds:${t.id}`)).toHaveLength(1);
    expect(await rejectMeta(t.id)).toMatchObject({ fundsKept: true });
  });

  it('6d: http rail, refund requested (sender-cancel escalation) + POSSIBLE_MATCH: refund stays requested, audit says requested, no funding.refund', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'fr_6d', fundingRef: 'ch_fr_6d' });
    await createTransferRepo(db).updateRefund(t.id, { refundStatus: 'requested' });
    await rejectTransfer(store, db, t.id, REJ);
    expect(await load(t.id)).toMatchObject({ status: 'cancelled', refundStatus: 'requested' });
    expect(await refunds()).toEqual([]);
    expect(await rejectMeta(t.id)).toMatchObject({ refundStatus: 'requested', fundsKept: true });
  });

  it('7: review path, certified queue owner, platform confirmed_match on a blocked row: cancelled, refund none, rejectfunds, rejectmsg, review row', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'blocked', { id: 'fr_7', fundingRef: 'ch_fr_7' });
    const review = await platformReviewFor(db, t.id, REJ, { holdClass: 'blocked', disposition: 'confirmed_match' });
    await rejectTransfer(store, db, t.id, REJ, undefined, review);
    const after = await load(t.id);
    expect(after.status).toBe('cancelled');
    expect(after.refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
    expect(await byKey(`rejectfunds:${t.id}`)).toHaveLength(1);
    expect(await byKey(`rejectmsg:${t.id}`)).toHaveLength(1);
    const reviews = (await db.execute(sql`SELECT hold_class, disposition FROM hold_reviews WHERE transfer_id = ${t.id}`)) as unknown as {
      rows: Array<{ hold_class: string; disposition: string }>;
    };
    expect(reviews.rows).toEqual([{ hold_class: 'blocked', disposition: 'confirmed_match' }]);
    expect(await rejectMeta(t.id)).toMatchObject({ refundStatus: 'none', fundsKept: true, holdClass: 'blocked', disposition: 'confirmed_match' });
    expect(poke.calls).toBe(1);
  });

  it('8: the rail read fails: never a refund (an unreadable rail is real money: the funds are kept)', async () => {
    await seedPartner(db, 'acme'); // mock rail on file, but the read throws
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'fr_8', fundingRef: 'ch_fr_8' });
    railRead.throws = true;
    await rejectTransfer(store, db, t.id, REJ);
    expect((await load(t.id)).refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
    expect(await byKey(`rejectfunds:${t.id}`)).toHaveLength(1);
  });

  it('8b: the sender flags read fails: fail closed, the funds are kept even on a kyc-only row', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'kyc', { id: 'fr_8b', fundingRef: 'ch_fr_8b' });
    flagsRead.throws = true;
    await rejectTransfer(store, db, t.id, REJ);
    expect((await load(t.id)).refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
    expect(await byKey(`rejectfunds:${t.id}`)).toHaveLength(1);
  });

  it('8b2 (F4, EE2): the flags SELECT really fails in the transaction: the reject still commits, the funds are kept, rejectfunds + rejectmsg', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'kyc', { id: 'fr_8b2', fundingRef: 'ch_fr_8b2' });
    flagsRead.sqlFails = true;
    await rejectTransfer(store, db, t.id, REJ);
    expect(await load(t.id)).toMatchObject({ status: 'cancelled' });
    expect((await load(t.id)).refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
    expect(await byKey(`rejectfunds:${t.id}`)).toHaveLength(1);
    const msg = await byKey(`rejectmsg:${t.id}`);
    expect(msg).toHaveLength(1);
    expect(msg[0].kind).toBe('whatsapp.text');
    expect(await rejectMeta(t.id)).toMatchObject({ fundsKept: true, refundStatus: 'none' });
  });

  it('8b3 (F4, EE2): the same real failure on the REVIEW path (certified owner): the reject commits with the funds kept and its review row', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'blocked', { id: 'fr_8b3', fundingRef: 'ch_fr_8b3' });
    const review = await platformReviewFor(db, t.id, REJ, { holdClass: 'blocked', disposition: 'confirmed_match' });
    flagsRead.sqlFails = true; // after platformReviewFor (it reads the flags itself)
    await rejectTransfer(store, db, t.id, REJ, undefined, review);
    expect((await load(t.id)).status).toBe('cancelled');
    expect(await refunds()).toEqual([]);
    expect(await byKey(`rejectfunds:${t.id}`)).toHaveLength(1);
    expect(await byKey(`rejectmsg:${t.id}`)).toHaveLength(1);
  });

  it('8c: no customer row for the sender (a partner-API sender), kyc-only row: refund as today (nothing to read is not a hit)', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'kyc', { id: 'fr_8c', fundingRef: 'ch_fr_8c' });
    await db.execute(sql`DELETE FROM customers WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    await rejectTransfer(store, db, t.id, REJ);
    expect(await load(t.id)).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await byKey(`rejectfunds:${t.id}`)).toEqual([]);
  });
});

/** A paid consumer row for the rail and sender-cancel paths. */
function paidRow(over: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: 'fr_paid', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Test Recipient', recipientPhone: '919000000001',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'credit_card',
    status: 'paid', complianceStatus: 'blocked', complianceReasons: [RECIPIENT_WATCHLIST_REASON],
    createdAt: new Date(now - 3 * 60_000).toISOString(), paidAt: new Date(now - 2 * 60_000).toISOString(), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205, fundingRef: 'ch_paid',
    ...over,
  } as Transfer;
}
const FAILED = { code: 'failed' as const, reason: 'account_unreachable' };
const railText = async (id: string) => String((await byKey(`railfail:${id}`))[0]?.payload.message ?? '');

describe('handleRailFailure: a blocked paid row on real money keeps its refund state', { retry: 0 }, () => {
  it('9: http rail, PAID + blocked + charged: cancelled, refund none, no funding.refund, contact notice, the funds rule in railfail', async () => {
    await httpOwner();
    await store.saveTransfer(paidRow());
    expect(await handleRailFailure(db, 'fr_paid', FAILED)).toEqual({ kind: 'failed', refundStarted: false });
    const after = await load('fr_paid');
    expect(after).toMatchObject({ status: 'cancelled', refundStatus: 'none' });
    expect(await refunds()).toEqual([]);
    const msg = await byKey('railfailmsg:fr_paid');
    expect(msg[0].payload.body).toBe(buildRailFailureMessage(after, 'contact'));
    expect(String(msg[0].payload.body)).not.toMatch(/refund/i);
    const text = await railText('fr_paid');
    expect(text).toContain(`Refund none → none: the captured charge was NOT refunded: the transfer is blocked by sanctions screening, so ${SANCTIONS_FUNDS_RULE}. Rail reason:`);
  });

  it('10: http rail, PAID + blocked + bank_pull: the partner-pulled debit was NOT reversed', async () => {
    await httpOwner();
    await store.saveTransfer(paidRow({ fundingRef: undefined, fundingMethod: 'bank_pull' }));
    await handleRailFailure(db, 'fr_paid', FAILED);
    expect(await load('fr_paid')).toMatchObject({ status: 'cancelled', refundStatus: 'none' });
    expect(await refunds()).toEqual([]);
    expect(await railText('fr_paid')).toContain(
      `the partner-pulled debit was NOT reversed: the transfer is blocked by sanctions screening, so ${SANCTIONS_FUNDS_RULE}`,
    );
  });

  it('11: mock rail, PAID + blocked + charged: refund pending as today', async () => {
    await seedPartner(db, 'acme');
    await store.saveTransfer(paidRow());
    expect(await handleRailFailure(db, 'fr_paid', FAILED)).toEqual({ kind: 'failed', refundStarted: true });
    expect(await load('fr_paid')).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await byKey('refund:fr_paid')).toHaveLength(1);
  });

  it('12: http rail, PAID, NOT blocked, charged: refund pending as today', async () => {
    await httpOwner();
    await store.saveTransfer(paidRow({ complianceStatus: 'cleared', complianceReasons: [] }));
    expect(await handleRailFailure(db, 'fr_paid', FAILED)).toEqual({ kind: 'failed', refundStarted: true });
    expect(await load('fr_paid')).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
  });

  it('13: failPaidFromRail keepRefundWhenBlocked: blocked charged -> none; not blocked -> pending; no opts -> pending', async () => {
    await seedPartner(db, 'acme');
    const repo = createTransferRepo(db);
    await store.saveTransfer(paidRow({ id: 'k1' }));
    expect((await repo.failPaidFromRail('k1', 'n', { keepRefundWhenBlocked: true })).updated).toMatchObject({ status: 'cancelled', refundStatus: 'none' });
    await store.saveTransfer(paidRow({ id: 'k2', complianceStatus: 'cleared', complianceReasons: [] }));
    expect((await repo.failPaidFromRail('k2', 'n', { keepRefundWhenBlocked: true })).updated).toMatchObject({ refundStatus: 'pending' });
    await store.saveTransfer(paidRow({ id: 'k3' }));
    expect((await repo.failPaidFromRail('k3', 'n')).updated).toMatchObject({ refundStatus: 'pending' });
  });
});

const SIMULATOR: PartnerIntegrations = {
  kyc: {},
  payment: { providerType: 'simulator', credentials: { settlementUrl: 'https://rail.example/settle', signingSecret: 'sgn' }, webhookSecret: 'whk' },
  whatsapp: {},
};

/** A charged row settled (unrun rail rows), then blocked (blockPaidOnMatch's shape). */
async function paidThenBlocked(): Promise<void> {
  const t = paidRow({ id: 'fr_sc', status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [], fundingRef: undefined, paidAt: undefined });
  await store.saveTransfer(t);
  await createTransferRepo(db).setFundingRef('fr_sc', 'ch_sc');
  expect((await beginSettlement(db, t, SIMULATOR)).kind).toBe('started');
  await db.execute(sql`UPDATE transfers SET compliance_status = 'blocked', compliance_reasons = ${JSON.stringify([RECIPIENT_WATCHLIST_REASON])}::jsonb
    WHERE id = 'fr_sc'`);
}

describe('cancelWithinWindow: a blocked paid row on real money (C2)', { retry: 0 }, () => {
  it('14: http rail: cancelled, refund none, no funding.refund, the no-refund message, ONE sendercancelfunds with the funds rule', async () => {
    await httpOwner();
    await paidThenBlocked();
    expect(await cancelWithinWindow(db, 'acme', 'fr_sc', { via: 'receipt' })).toEqual({ kind: 'cancelled', refundQueued: false });
    const after = await load('fr_sc');
    expect(after).toMatchObject({ status: 'cancelled', refundStatus: 'none' });
    expect(await refunds()).toEqual([]);
    expect((await byKey('sendercancel:fr_sc'))[0].payload.body).toBe(buildSenderCancelMessage(after, false));
    const alerts = await byKey('sendercancelfunds:fr_sc');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].payload.message).toBe(
      `⚠️ SmartRemit ops: the sender cancelled transfer fr_sc (partner acme) within 30 minutes of payment (Reg E). ` +
        `It is blocked by sanctions screening, so it was cancelled and NOT refunded: ${SANCTIONS_FUNDS_RULE}.`,
    );
  });

  it('15: the same on the mock rail: refund queued as today', async () => {
    await seedPartner(db, 'acme');
    await paidThenBlocked();
    expect(await cancelWithinWindow(db, 'acme', 'fr_sc', { via: 'receipt' })).toEqual({ kind: 'cancelled', refundQueued: true });
    expect(await load('fr_sc')).toMatchObject({ status: 'cancelled', refundStatus: 'pending' });
    expect(await byKey('refund:fr_sc')).toHaveLength(1);
    expect(await byKey('sendercancelfunds:fr_sc')).toEqual([]);
  });
});
