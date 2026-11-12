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
  approveRefund, issueRefund, rejectTransfer, retryRefund, REFUND_HOLD_FIRST_REFUSAL, REFUND_SANCTIONS_REFUSAL,
} from '@/lib/dashboard-ops';
import { refundHoldBlockedIds, refundHoldRefusals } from '@/lib/refund-row-flags';
import { refundControls } from '@/lib/partner-refunds';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { RECIPIENT_WATCHLIST_REASON } from '@/lib/compliance-config';

vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => {} };
});

// The sender flags read: a counter and a switch that makes it throw.
const flagsRead = vi.hoisted(() => ({ calls: 0, throws: false }));
vi.mock('@/db/repos/customer-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/customer-repo')>();
  return {
    ...real,
    readSenderScreeningFlags: async (...a: Parameters<typeof real.readSenderScreeningFlags>) => {
      flagsRead.calls += 1;
      if (flagsRead.throws) throw new Error('flags read failed');
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
