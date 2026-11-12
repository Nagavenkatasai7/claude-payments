/**
 * Fix pack 7 T16b (P14 "Refund back doors", D7, M1, R3): on a real-money row
 * approveRefund, retryRefund and issueRefund (platform AND partner scope)
 * refuse when the row carries a sanctions hold class (REFUND_SANCTIONS_REFUSAL),
 * and refuse an in_review row of a certified owner (REFUND_HOLD_FIRST_REFUSAL).
 * The screens hide the buttons (refundHoldBlockedIds, refundControls
 * holdBlocked). Mock-rail rows refund exactly as today, with no flags read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb, seedPartner } from './helpers-db';
import { certifiedQueuePartner, heldRowFor } from './helpers-hold';
import { paidRealMoneyTransfer, seedRealMoneyRail } from './helpers-live';
import type { Db } from '@/db/client';
import {
  approveRefund, issueRefund, rejectTransfer, retryRefund, reverseB2bSettlement, REFUND_HOLD_FIRST_REFUSAL, REFUND_SANCTIONS_REFUSAL,
} from '@/lib/dashboard-ops';
import { b2bRowControl, showsReverse } from '@/lib/b2b-row-control';
import type { Transfer } from '@/lib/types';
import { refundHoldBlockedIds, refundHoldRefusals } from '@/lib/refund-row-flags';
import { refundControls } from '@/lib/partner-refunds';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { RECIPIENT_WATCHLIST_REASON } from '@/lib/compliance-config';
import { readSenderFlagsLocked } from '@/lib/hold-review-tx';

vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => {} };
});

// The sender flags read: a counter, a switch that makes it throw before any SQL, and (F4, early
// review EE2) one that runs a FAILING statement on the caller's handle first, then delegates.
const flagsRead = vi.hoisted(() => ({ calls: 0, throws: false, sqlFails: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  const { sql: q } = await import('drizzle-orm');
  return {
    ...real,
    readSenderScreeningFlags: async (...a: Parameters<typeof real.readSenderScreeningFlags>) => {
      flagsRead.calls += 1;
      if (flagsRead.throws) throw new Error('flags read failed');
      if (flagsRead.sqlFails) await a[0].execute(q`select 1/0`);
      return real.readSenderScreeningFlags(...a);
    },
  };
});

const REJ = { actor: 'plat', reason: 'The match could not be cleared with the documents on file.' };
const AUDIT = { actor: 'ops', reason: 'Refund decision.' };
const SCOPE = { partnerId: 'acme' };

let db: Db;
let store: ReturnType<typeof createStore>;

beforeEach(async () => {
  db = await freshDb();
  store = createStore(fakeRedis(), db);
  flagsRead.calls = 0;
  flagsRead.throws = false;
  flagsRead.sqlFails = false;
});

type Row = { kind: string; dedupe_key: string | null };
async function refunds(): Promise<Row[]> {
  const r = (await db.execute(sql`SELECT kind, dedupe_key FROM outbox WHERE kind = 'funding.refund' ORDER BY id`)) as unknown as { rows: Row[] };
  return r.rows;
}
const load = async (id: string) => (await createTransferRepo(db).getTransfer(id))!;
async function setRow(id: string, status: string, refund: string): Promise<void> {
  await db.execute(sql`UPDATE transfers SET status = ${status}, refund_status = ${refund} WHERE id = ${id}`);
}
async function stampWatchlist(phone: string): Promise<void> {
  // O3: a later watchlist stamp is a SQL step.
  await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now(), screening_watchlist_at = now()
    WHERE partner_id = 'acme' AND phone = ${phone}`);
}

async function httpOwner(): Promise<void> {
  await seedPartner(db, 'acme');
  await seedRealMoneyRail(db, 'acme');
}

/** Fixture 1: a funds-kept POSSIBLE_MATCH reject whose sender-cancel escalation left the refund 'requested'. */
async function keptRequested(id: string): Promise<string> {
  const t = await heldRowFor(db, 'acme', 'sanctions_review', { id, fundingRef: `ch_${id}` });
  await createTransferRepo(db).updateRefund(t.id, { refundStatus: 'requested' });
  await rejectTransfer(store, db, t.id, REJ);
  return t.id;
}
/** Fixture 2: a cancelled charged row whose refund failed, sender stamped on the watchlist. */
async function failedWatchlist(id: string): Promise<string> {
  const t = await heldRowFor(db, 'acme', 'kyc', { id, fundingRef: `ch_${id}` });
  await setRow(t.id, 'cancelled', 'failed');
  await stampWatchlist(t.phone);
  return t.id;
}
/** Fixture 3: a PAID charged row blocked by blockPaidOnMatch. */
async function paidBlocked(id: string): Promise<string> {
  const t = await paidRealMoneyTransfer(db, { id, partnerId: 'acme', fundingRef: `ch_${id}` });
  await db.execute(sql`UPDATE transfers SET compliance_status = 'blocked', compliance_reasons = ${JSON.stringify([RECIPIENT_WATCHLIST_REASON])}::jsonb
    WHERE id = ${t.id}`);
  return t.id;
}
/** Fixture 4: an in_review kyc row with a requested refund. */
async function heldRequested(id: string): Promise<string> {
  const t = await heldRowFor(db, 'acme', 'kyc', { id, fundingRef: `ch_${id}` });
  await setRow(t.id, 'in_review', 'requested');
  return t.id;
}
/** Fixture 5: a cancelled row of a PEP-only sender with a requested refund. */
async function pepRequested(id: string): Promise<string> {
  const t = await heldRowFor(db, 'acme', 'sender_pep', { id, fundingRef: `ch_${id}` });
  await setRow(t.id, 'cancelled', 'requested');
  return t.id;
}

describe('refund back doors on real money (P14, D7)', { retry: 0 }, () => {
  it('1: approveRefund, http rail, refund requested after a funds-kept POSSIBLE_MATCH reject: refused in both scopes; no funding.refund; stays requested', async () => {
    await httpOwner();
    const id = await keptRequested('rg_1');
    expect(await load(id)).toMatchObject({ status: 'cancelled', refundStatus: 'requested' });
    await expect(approveRefund(db, id, AUDIT)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    await expect(approveRefund(db, id, AUDIT, SCOPE)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    expect(await refunds()).toEqual([]);
    expect((await load(id)).refundStatus).toBe('requested');
  });

  it('2: retryRefund, http rail, refund failed on a row with a sender watchlist stamp: refused; stays failed', async () => {
    await httpOwner();
    const id = await failedWatchlist('rg_2');
    await expect(retryRefund(db, id, AUDIT)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    await expect(retryRefund(db, id, AUDIT, SCOPE)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    expect(await refunds()).toEqual([]);
    expect((await load(id)).refundStatus).toBe('failed');
  });

  it('3: issueRefund, http rail, PAID + blocked: refused; no funding.refund; refund none', async () => {
    await httpOwner();
    const id = await paidBlocked('rg_3');
    await expect(issueRefund(db, id, AUDIT)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    await expect(issueRefund(db, id, AUDIT, SCOPE)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    expect(await refunds()).toEqual([]);
    expect((await load(id)).refundStatus ?? 'none').toBe('none');
  });

  it('3b: an unreadable sender flags read fails closed (refused)', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'kyc', { id: 'rg_3b', fundingRef: 'ch_rg_3b' });
    await setRow(t.id, 'cancelled', 'requested');
    flagsRead.throws = true;
    await expect(approveRefund(db, t.id, AUDIT)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    expect(await refunds()).toEqual([]);
  });

  it('3c (F4, EE2): the flags SELECT really fails in the transaction: each refund core refuses with REFUND_SANCTIONS_REFUSAL (never a 25P02 error); nothing moves', async () => {
    await httpOwner();
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'rg_3c_a', fundingRef: 'ch_rg_3c_a' });
    await setRow(a.id, 'cancelled', 'requested');
    const r = await heldRowFor(db, 'acme', 'kyc', { id: 'rg_3c_r', fundingRef: 'ch_rg_3c_r' });
    await setRow(r.id, 'cancelled', 'failed');
    const i = await paidRealMoneyTransfer(db, { id: 'rg_3c_i', partnerId: 'acme', fundingRef: 'ch_rg_3c_i' });
    flagsRead.sqlFails = true;
    await expect(approveRefund(db, a.id, AUDIT)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    await expect(retryRefund(db, r.id, AUDIT)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    await expect(issueRefund(db, i.id, AUDIT)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    flagsRead.sqlFails = false;
    expect(await refunds()).toEqual([]);
    expect([(await load(a.id)).refundStatus, (await load(r.id)).refundStatus, (await load(i.id)).refundStatus ?? 'none'])
      .toEqual(['requested', 'failed', 'none']);
  });

  it('3d (F4, EE2): the locked flags read runs in a savepoint: a real SQL failure answers read:false and the transaction stays usable', async () => {
    await httpOwner();
    const t = await paidRealMoneyTransfer(db, { id: 'rg_3d', partnerId: 'acme' });
    flagsRead.sqlFails = true;
    const out = await db.transaction(async (tx) => {
      const r = await readSenderFlagsLocked(tx, t.partnerId, t.phone);
      // The next statement in the SAME transaction runs (no 25P02).
      const n = (await tx.execute(sql`SELECT count(*)::int AS n FROM transfers WHERE id = ${t.id}`)) as unknown as { rows: Array<{ n: number }> };
      return { r, n: n.rows[0].n };
    });
    expect(out).toEqual({ r: { read: false, errorName: expect.any(String) }, n: 1 });
    flagsRead.sqlFails = false;
    const ok = await db.transaction((tx) => readSenderFlagsLocked(tx, t.partnerId, t.phone));
    expect(ok.read).toBe(true);
    expect(ok.read && ok.flags).toHaveProperty('watchlistHit');
    const none = await db.transaction((tx) => readSenderFlagsLocked(tx, t.partnerId, '15550000000'));
    expect(none).toEqual({ read: true, flags: null });
  });

  it('4: approveRefund, http rail, in_review row of a certified owner, no sanctions class: REFUND_HOLD_FIRST_REFUSAL', async () => {
    await certifiedQueuePartner(db);
    const id = await heldRequested('rg_4');
    await expect(approveRefund(db, id, AUDIT)).rejects.toThrow(REFUND_HOLD_FIRST_REFUSAL);
    await expect(approveRefund(db, id, AUDIT, SCOPE)).rejects.toThrow(REFUND_HOLD_FIRST_REFUSAL);
    expect(await refunds()).toEqual([]);
    expect((await load(id)).refundStatus).toBe('requested');
  });

  it('4b: the same in_review row of an UNCERTIFIED owner on an http rail: proceeds as today', async () => {
    await httpOwner();
    const id = await heldRequested('rg_4b');
    await approveRefund(db, id, AUDIT);
    expect((await load(id)).refundStatus).toBe('pending');
    expect((await refunds()).map((r) => r.dedupe_key)).toEqual([`refund:${id}`]);
  });

  it('5: approveRefund, http rail, PEP-only sender on a cancelled row: proceeds as today', async () => {
    await httpOwner();
    const id = await pepRequested('rg_5');
    await approveRefund(db, id, AUDIT);
    expect((await load(id)).refundStatus).toBe('pending');
    expect((await refunds()).map((r) => r.dedupe_key)).toEqual([`refund:${id}`]);
  });

  it('6: mock rail: every case proceeds as today, and no sender flags are read', async () => {
    await seedPartner(db, 'acme');
    const a = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'rg_6a', fundingRef: 'ch_rg_6a' });
    await setRow(a.id, 'cancelled', 'requested');
    const b = await failedWatchlist('rg_6b');
    const c = await paidBlocked('rg_6c');
    const d = await heldRequested('rg_6d');
    flagsRead.calls = 0;
    await approveRefund(db, a.id, AUDIT, SCOPE);
    await retryRefund(db, b, AUDIT, SCOPE);
    await issueRefund(db, c, AUDIT);
    await approveRefund(db, d, AUDIT);
    for (const id of [a.id, b, c, d]) expect((await load(id)).refundStatus).toBe('pending');
    expect(await refunds()).toHaveLength(4);
    expect(flagsRead.calls).toBe(0);
  });
});

describe('refundHoldBlockedIds / refundHoldRefusals (the screens)', { retry: 0 }, () => {
  it('7: flags rows 1-4 (with their text) and not 5-6; a failed read flags the row', async () => {
    await certifiedQueuePartner(db);
    // A certified owner's row cannot be rejected without a review: the kept state by SQL. Rows of
    // this file share ONE fixture sender, so no watchlist stamp here (row 5 stays PEP-only).
    const t1 = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'rg_7_1', fundingRef: 'ch_rg_7_1' });
    await setRow(t1.id, 'cancelled', 'requested');
    const r1 = t1.id;
    const t2 = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'rg_7_2', fundingRef: 'ch_rg_7_2' });
    await setRow(t2.id, 'cancelled', 'failed');
    const r2 = t2.id;
    // Row 3's twin with a button: a paid blocked row whose refund failed.
    const r3 = await paidBlocked('rg_7_3');
    await setRow(r3, 'paid', 'failed');
    const r4 = await heldRequested('rg_7_4');
    const r5 = await pepRequested('rg_7_5');
    await seedPartner(db, 'demo');
    const m = await paidRealMoneyTransfer(db, { id: 'rg_7_6', partnerId: 'demo', fundingRef: 'ch_rg_7_6' });
    await db.execute(sql`UPDATE transfers SET compliance_status = 'blocked', compliance_reasons = ${JSON.stringify([RECIPIENT_WATCHLIST_REASON])}::jsonb,
      refund_status = 'requested' WHERE id = ${m.id}`);
    const rows = await Promise.all([r1, r2, r3, r4, r5, m.id].map(load));
    flagsRead.calls = 0;
    const ids = await refundHoldBlockedIds(db, rows);
    expect([...ids].sort()).toEqual([r1, r2, r3, r4].sort());
    const texts = await refundHoldRefusals(db, rows);
    expect(texts.get(r1)).toBe(REFUND_SANCTIONS_REFUSAL);
    expect(texts.get(r2)).toBe(REFUND_SANCTIONS_REFUSAL);
    expect(texts.get(r3)).toBe(REFUND_SANCTIONS_REFUSAL);
    expect(texts.get(r4)).toBe(REFUND_HOLD_FIRST_REFUSAL);
    expect(texts.has(r5)).toBe(false);
    expect(texts.has(m.id)).toBe(false);

    flagsRead.throws = true;
    const failed = await refundHoldBlockedIds(db, [await load(r5)]);
    expect([...failed]).toEqual([r5]);
  });

  it('7b: rows with no decision button cost no read', async () => {
    await httpOwner();
    const t = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'rg_7b', fundingRef: 'ch_rg_7b' });
    await setRow(t.id, 'cancelled', 'pending');
    flagsRead.calls = 0;
    expect([...(await refundHoldBlockedIds(db, [await load(t.id)]))]).toEqual([]);
    expect(flagsRead.calls).toBe(0);
  });
});

describe('refundControls holdBlocked', { retry: 0 }, () => {
  it('8: holdBlocked hides approve and retry (dismiss stays); absent options = today', () => {
    expect(refundControls('requested', 'admin', { holdBlocked: true })).toEqual({ approve: false, dismiss: true, retry: false });
    expect(refundControls('failed', 'admin', { holdBlocked: true })).toEqual({ approve: false, dismiss: false, retry: false });
    expect(refundControls('requested', 'admin', { holdBlocked: false })).toEqual({ approve: true, dismiss: true, retry: false });
    expect(refundControls('failed', 'admin', {})).toEqual({ approve: false, dismiss: false, retry: true });
    expect(refundControls('requested', 'admin')).toEqual({ approve: true, dismiss: true, retry: false });
  });
});

// Fix pack 7 F2 (early review EE1): the staff B2B Reverse is a fourth refund path (partner-pulled
// rows have no fundingRef, so issueRefund cannot reach them). On real money it honours the funds
// rule: the row is read FOR UPDATE and refundHoldGuard runs before the none -> pending flip.
/** A PAID B2B ach_pull row (no fundingRef: SmartRemit captured nothing). */
async function paidB2bPull(id: string, partnerId = 'acme'): Promise<Transfer> {
  const t = await paidRealMoneyTransfer(db, { id, partnerId, fundingMethod: 'ach_pull' });
  await db.execute(sql`UPDATE transfers SET transfer_type = 'b2b' WHERE id = ${t.id}`);
  return load(t.id);
}
async function blockRow(id: string): Promise<void> {
  await db.execute(sql`UPDATE transfers SET compliance_status = 'blocked', compliance_reasons = ${JSON.stringify([RECIPIENT_WATCHLIST_REASON])}::jsonb
    WHERE id = ${id}`);
}

describe('reverseB2bSettlement honours the funds rule on real money (F2, EE1)', { retry: 0 }, () => {
  it('F2.1: http rail, B2B ach_pull row, paid, complianceStatus blocked: REFUND_SANCTIONS_REFUSAL; refund stays none; no funding.refund', async () => {
    await httpOwner();
    const t = await paidB2bPull('rv_f2_1');
    await blockRow(t.id);
    await expect(reverseB2bSettlement(db, t.id)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    expect((await load(t.id)).refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
  });

  it('F2.2: http rail, paid row of a sender with a watchlist stamp: REFUND_SANCTIONS_REFUSAL', async () => {
    await httpOwner();
    const t = await paidB2bPull('rv_f2_2');
    await stampWatchlist(t.phone);
    await expect(reverseB2bSettlement(db, t.id)).rejects.toThrow(REFUND_SANCTIONS_REFUSAL);
    expect((await load(t.id)).refundStatus ?? 'none').toBe('none');
    expect(await refunds()).toEqual([]);
  });

  it('F2.3: http rail, clean paid row: reverses as today (refund pending, one funding.refund row)', async () => {
    await httpOwner();
    const t = await paidB2bPull('rv_f2_3');
    await reverseB2bSettlement(db, t.id);
    expect((await load(t.id)).refundStatus).toBe('pending');
    expect((await refunds()).map((r) => r.dedupe_key)).toEqual([`refund:${t.id}`]);
  });

  it('F2.4: mock rail, the fixtures of F2.1 and F2.2: reverse as today, and no sender flags are read', async () => {
    await seedPartner(db, 'acme');
    const a = await paidB2bPull('rv_f2_4a');
    await blockRow(a.id);
    const b = await paidB2bPull('rv_f2_4b');
    await stampWatchlist(b.phone);
    flagsRead.calls = 0;
    await reverseB2bSettlement(db, a.id);
    await reverseB2bSettlement(db, b.id);
    for (const id of [a.id, b.id]) expect((await load(id)).refundStatus).toBe('pending');
    expect((await refunds()).map((r) => r.dedupe_key)).toEqual([`refund:${a.id}`, `refund:${b.id}`]);
    expect(flagsRead.calls).toBe(0);
  });

  it('F2.5: the B2B page flags the row of F2.1 and renders its fixed line in place of the Reverse form', async () => {
    await httpOwner();
    const blocked = await paidB2bPull('rv_f2_5a');
    await blockRow(blocked.id);
    const clean = await paidB2bPull('rv_f2_5b');
    const rows = [await load(blocked.id), await load(clean.id)];
    // The reverse buttons (refund none) are the B2B page's decision buttons; the default (Approve /
    // Retry rows) does not list them.
    expect([...(await refundHoldBlockedIds(db, rows))]).toEqual([]);
    expect([...(await refundHoldBlockedIds(db, rows, { reverse: true }))]).toEqual([blocked.id]);
    const refusals = await refundHoldRefusals(db, rows.filter(showsReverse), { reverse: true });
    expect(b2bRowControl(rows[0], refusals)).toEqual({ kind: 'reverse_refused', text: REFUND_SANCTIONS_REFUSAL });
    expect(b2bRowControl(rows[1], refusals)).toEqual({ kind: 'reverse' });
  });

  it('F2.5b: a mock-rail blocked row keeps its Reverse form, and a row with no Reverse costs no read', async () => {
    await seedPartner(db, 'acme');
    const t = await paidB2bPull('rv_f2_5c');
    await blockRow(t.id);
    flagsRead.calls = 0;
    const row = await load(t.id);
    const refusals = await refundHoldRefusals(db, [row], { reverse: true });
    expect(b2bRowControl(row, refusals)).toEqual({ kind: 'reverse' });
    await db.execute(sql`UPDATE transfers SET refund_status = 'pending' WHERE id = ${t.id}`);
    expect([...(await refundHoldBlockedIds(db, [await load(t.id)], { reverse: true }))]).toEqual([]);
    expect(flagsRead.calls).toBe(0);
  });
});

describe('b2bRowControl (the B2B page actions column, unchanged rows)', { retry: 0 }, () => {
  const base = { id: 'x', fundingMethod: 'ach_pull', fundingRef: undefined, fundingIntentRef: undefined } as unknown as Transfer;
  it('maps every status as the page did before F2', () => {
    const none = new Map<string, string>();
    expect(b2bRowControl({ ...base, status: 'awaiting_payment' }, none)).toEqual({ kind: 'cancel' });
    expect(b2bRowControl({ ...base, status: 'awaiting_payment', fundingRef: 'ch_1' }, none)).toEqual({ kind: 'charged' });
    expect(b2bRowControl({ ...base, status: 'paid' }, none)).toEqual({ kind: 'reverse' });
    expect(b2bRowControl({ ...base, status: 'paid', fundingMethod: 'credit_card' }, none)).toEqual({ kind: 'none' });
    expect(b2bRowControl({ ...base, status: 'in_review' }, none)).toEqual({ kind: 'in_review' });
    expect(b2bRowControl({ ...base, status: 'delivered' }, none)).toEqual({ kind: 'recall' });
    expect(b2bRowControl({ ...base, status: 'cancelled' }, none)).toEqual({ kind: 'none' });
    expect(showsReverse({ ...base, status: 'paid' })).toBe(true);
    expect(showsReverse({ ...base, status: 'delivered' })).toBe(false);
  });
});
