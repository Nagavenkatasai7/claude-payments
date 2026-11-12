/**
 * Fix pack 7 T8b (P9 reject half, P5 rules 2, 3, 5, 7, P28): the reject seam
 * with a review record. rejectTransfer takes an optional trailing `review`;
 * with it, ONE transaction: the tenant-pinned locked read, the owner re-read,
 * the row fingerprint, the locked sender flags, the classes, decisionRoute and
 * nextStep (expectFinal), the partner-scope sender stance, the guarded cancel
 * claim, THEN the hold_reviews row, THEN the transfer.reject audit, THEN
 * today's refund branch. Every refusal writes nothing. Without a review, a
 * certified owner's live row is refused (D6); uncertified owners are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createStore, type Store } from '@/lib/store';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { certifiedQueuePartner, heldRowFor, platformReviewFor } from './helpers-hold';
import type { Db } from '@/db/client';
import type { Transfer } from '@/lib/types';
import { HOLD_REVIEW_RELOAD_REFUSAL, PARTNER_DECIDES_HOLD_REFUSAL, rejectTransfer } from '@/lib/dashboard-ops';
import { HoldReviewChangedError, type HoldReviewInput } from '@/lib/hold-review-tx';
import { rowReasonsFp, type HoldClass, type HoldDisposition } from '@/lib/hold-queue';
import { LARGE_AMOUNT_REASON, LIST_UNAVAILABLE_REASON, POSSIBLE_MATCH_REASON } from '@/lib/compliance-config';

vi.mock('@/lib/outbox', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox')>();
  return { ...real, pokeWorker: () => {} };
});

// The owner read: a switch on getPartner (tests/hold-release-seam.test.ts pattern).
const ownerRead = vi.hoisted(() => ({ mode: 'real' as 'real' | 'throw' | 'null' }));
vi.mock('@/db/repos/partner-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/partner-repo')>();
  return {
    ...real,
    createPartnerRepo: (...a: Parameters<typeof real.createPartnerRepo>) => {
      const repo = real.createPartnerRepo(...a);
      return {
        ...repo,
        getPartner: async (...g: Parameters<typeof repo.getPartner>) => {
          if (ownerRead.mode === 'throw') throw new Error('owner read failed');
          if (ownerRead.mode === 'null') return null;
          return repo.getPartner(...g);
        },
      };
    },
  };
});

// The review insert: a switch that answers null (a unique index refused it).
const reviewInsert = vi.hoisted(() => ({ refuse: false }));
vi.mock('@/db/repos/hold-review-repo', async (orig) => {
  const real = await orig<typeof import('@/db/repos/hold-review-repo')>();
  return {
    ...real,
    createHoldReviewRepo: (...a: Parameters<typeof real.createHoldReviewRepo>) => {
      const repo = real.createHoldReviewRepo(...a);
      return { ...repo, insert: async (...w: Parameters<typeof repo.insert>) => (reviewInsert.refuse ? null : repo.insert(...w)) };
    },
  };
});

const REASON = 'The customer could not verify the documents on file.';
const REJ = { actor: 'plat', reason: REASON };
const PARTNER_REJECT_CHANGED = 'Cannot reject: transfer is not in_review or its sender is not rejectable (it changed concurrently)';
const PLATFORM_CONCURRENT = 'Cannot reject: transfer is not in_review (it moved concurrently)';

let db: Db;
let store: ReturnType<typeof createStore>;

beforeEach(async () => {
  ownerRead.mode = 'real';
  reviewInsert.refuse = false;
  db = await freshDb();
  store = createStore(fakeRedis(), db);
});
afterEach(() => {
  ownerRead.mode = 'real';
  reviewInsert.refuse = false;
});

type Rows<T> = { rows: T[] };
async function count(table: 'hold_reviews' | 'audit_events' | 'outbox', id?: string): Promise<number> {
  const where =
    table === 'hold_reviews' ? sql`WHERE transfer_id = ${id ?? ''}` : table === 'audit_events' ? sql`WHERE subject_id = ${id ?? ''}` : sql``;
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} ${where}`)) as unknown as Rows<{ n: number }>;
  return r.rows[0].n;
}
async function snapshot(id: string) {
  const t = await store.getTransfer(id);
  return {
    status: t?.status,
    refundStatus: t?.refundStatus ?? null,
    reviews: await count('hold_reviews', id),
    audit: await count('audit_events', id),
    outbox: await count('outbox'),
  };
}
async function outboxRows(): Promise<Array<{ kind: string; dedupe_key: string | null }>> {
  const r = (await db.execute(sql`SELECT kind, dedupe_key FROM outbox ORDER BY id`)) as unknown as Rows<{ kind: string; dedupe_key: string | null }>;
  return r.rows;
}
type ReviewRow = { hold_class: string; step: number; final: boolean; disposition: string; actor_scope: string; partner_id: string; actor: string; reason: string };
async function reviewRows(id: string): Promise<ReviewRow[]> {
  const r = (await db.execute(sql`SELECT * FROM hold_reviews WHERE transfer_id = ${id} ORDER BY created_at, step`)) as unknown as Rows<ReviewRow>;
  return r.rows;
}
type AuditRow = { actor: string; action: string; meta: Record<string, unknown> };
async function audits(id: string, action: string): Promise<AuditRow[]> {
  const r = (await db.execute(sql`SELECT actor, action, meta FROM audit_events WHERE subject_id = ${id} AND action = ${action} ORDER BY id`)) as unknown as Rows<AuditRow>;
  return r.rows;
}
async function setReasons(id: string, reasons: string[]): Promise<Transfer> {
  await db.execute(sql`UPDATE transfers SET compliance_reasons = ${JSON.stringify(reasons)}::jsonb WHERE id = ${id}`);
  return (await store.getTransfer(id))!;
}
const delegated = () => certifiedQueuePartner(db, { holdDecider: 'smartremit_delegated' });

function review(t: Transfer, holdClass: HoldClass, disposition: HoldDisposition, o: Partial<HoldReviewInput> = {}): HoldReviewInput {
  return {
    ownerId: t.partnerId, holdClass, rowFp: rowReasonsFp(t.complianceReasons), disposition, reason: REASON,
    actor: 'plat', actorScope: 'platform', evidence: {}, expectFinal: true, ...o,
  };
}
const partnerReview = (t: Transfer, holdClass: HoldClass, disposition: HoldDisposition, actor = 'co-a') =>
  review(t, holdClass, disposition, { actor, actorScope: 'partner' });
const partnerAudit = (actor = 'co-a') => ({ actor, reason: REASON });
async function why(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HoldReviewChangedError);
  return (err as HoldReviewChangedError).why;
}

describe('rejectTransfer without a review on a certified owner (D6)', { retry: 0 }, () => {
  it('1: certified delegated owner, platform: HOLD_REVIEW_RELOAD_REFUSAL; in_review, nothing written', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    await expect(rejectTransfer(store, db, t.id, REJ)).rejects.toThrow(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await snapshot(t.id)).toEqual(before);
    expect(before.status).toBe('in_review');
  });

  it('2: queue owner, a kyc-class row: PARTNER_DECIDES_HOLD_REFUSAL; a sanctions_review-only row: HOLD_REVIEW_RELOAD_REFUSAL', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc', { id: 'nr_kyc' });
    const before = await snapshot(t.id);
    await expect(rejectTransfer(store, db, t.id, REJ)).rejects.toThrow(PARTNER_DECIDES_HOLD_REFUSAL);
    expect(await snapshot(t.id)).toEqual(before);
    const s = await heldRowFor(db, 'acme', 'sanctions_review', { id: 'nr_sanc' });
    const sBefore = await snapshot(s.id);
    await expect(rejectTransfer(store, db, s.id, REJ)).rejects.toThrow(HOLD_REVIEW_RELOAD_REFUSAL);
    expect(await snapshot(s.id)).toEqual(sBefore);
  });

  it('3: partnerReject on a certified owner: the existing partner concurrent text; nothing written', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    await expect(rejectTransfer(store, db, t.id, partnerAudit(), { partnerId: 'acme' })).rejects.toThrow(PARTNER_REJECT_CHANGED);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it("4: a sandbox ('test') row of a certified owner: cancelled as today, no hold_reviews row", async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    await db.execute(sql`UPDATE transfers SET environment = 'test' WHERE id = ${t.id}`);
    ownerRead.mode = 'throw'; // its owner is not read at all
    await rejectTransfer(store, db, t.id, REJ);
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect(await count('hold_reviews', t.id)).toBe(0);
    expect(await audits(t.id, 'transfer.reject')).toHaveLength(1);
  });

  it('5: the owner read throws: the error propagates; it returns null: the permission text; nothing written', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    ownerRead.mode = 'throw';
    await expect(rejectTransfer(store, db, t.id, REJ)).rejects.toThrow('owner read failed');
    ownerRead.mode = 'null';
    await expect(rejectTransfer(store, db, t.id, REJ)).rejects.toThrow('You do not have permission to perform this action.');
    expect(await snapshot(t.id)).toEqual(before);
  });
});

describe('the reject seam with a review (P9)', { retry: 0 }, () => {
  it("6: platform, an UNCHARGED kyc row ('customer_not_verified'): cancelled, ONE review row, ONE audit row, only the hold.disposition event (T23)", async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const outboxBefore = await count('outbox');
    await rejectTransfer(store, db, t.id, REJ, undefined, review(t, 'kyc', 'customer_not_verified'));
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('cancelled');
    const rows = await reviewRows(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hold_class: 'kyc', step: 1, final: true, disposition: 'customer_not_verified', actor_scope: 'platform', partner_id: 'acme', actor: 'plat', reason: REASON,
    });
    const rej = await audits(t.id, 'transfer.reject');
    expect(rej).toHaveLength(1);
    expect(rej[0].actor).toBe('plat');
    expect(rej[0].meta).toMatchObject({
      previousStatus: 'in_review', newStatus: 'cancelled', refundStatus: 'none', reviewId: expect.any(String), step: 1,
      disposition: 'customer_not_verified', holdClass: 'kyc', actorScope: 'platform', reason: REASON,
    });
    expect((await outboxRows()).slice(outboxBefore)).toEqual([
      { kind: 'partner.event', dedupe_key: `hold.disposition:${rej[0].meta.reviewId as string}` },
    ]);
  });

  it('7: platform, a CHARGED row (fundingRef set, mock rail): cancelled, refund pending, exactly one funding.refund, one review row', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc', { fundingProvider: 'mock', fundingRef: 'mock_pi_reject' });
    const before = (await outboxRows()).length;
    await rejectTransfer(store, db, t.id, REJ, undefined, review(t, 'kyc', 'activity_unexplained'));
    const after = await store.getTransfer(t.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.refundStatus).toBe('pending');
    const rej = await audits(t.id, 'transfer.reject');
    expect((await outboxRows()).slice(before)).toEqual([
      { kind: 'partner.event', dedupe_key: `hold.disposition:${rej[0].meta.reviewId as string}` },
      { kind: 'funding.refund', dedupe_key: `refund:${t.id}` },
    ]);
    expect(await reviewRows(t.id)).toHaveLength(1);
    expect(rej[0].meta).toMatchObject({ refundStatus: 'pending', holdClass: 'kyc' });
  });

  it('8: queue owner, four-eyes on, partner kyc reject: final at step 1, cancelled', async () => {
    await certifiedQueuePartner(db, { fourEyes: true });
    const t = await heldRowFor(db, 'acme', 'kyc');
    await rejectTransfer(store, db, t.id, partnerAudit(), undefined, partnerReview(t, 'kyc', 'customer_not_verified'));
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect((await reviewRows(t.id)).map((r) => [r.actor, r.step, r.final, r.actor_scope])).toEqual([['co-a', 1, true, 'partner']]);
    expect((await audits(t.id, 'transfer.reject'))[0].meta).toMatchObject({ actorScope: 'partner', holdClass: 'kyc', step: 1 });
  });

  it('9: a partner reject while a platform class is present (LARGE + POSSIBLE_MATCH): waits_platform; nothing written', async () => {
    await certifiedQueuePartner(db);
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const before = await snapshot(t.id);
    expect(await why(rejectTransfer(store, db, t.id, partnerAudit(), undefined, partnerReview(t, 'kyc', 'customer_not_verified')))).toBe('waits_platform');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('10: a blocked row: a partner reject is refused (blocked); a platform confirmed_match reject cancels it', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'blocked');
    const before = await snapshot(t.id);
    expect(await why(rejectTransfer(store, db, t.id, partnerAudit(), undefined, partnerReview(t, 'blocked', 'confirmed_match')))).toBe('blocked');
    expect(await snapshot(t.id)).toEqual(before);
    await rejectTransfer(store, db, t.id, REJ, undefined, review(t, 'blocked', 'confirmed_match'));
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.disposition])).toEqual([['blocked', 'confirmed_match']]);
  });

  it('11: list_wait: a partner reject waits_list, a PLATFORM unable_to_clear reject cancels (DP12); data_missing: a platform data_not_provided reject cancels (DP4)', async () => {
    await certifiedQueuePartner(db);
    const l = await setReasons((await heldRowFor(db, 'acme', 'kyc', { id: 'rj_list' })).id, [LIST_UNAVAILABLE_REASON]);
    const before = await snapshot(l.id);
    expect(await why(rejectTransfer(store, db, l.id, partnerAudit(), undefined, partnerReview(l, 'list_wait', 'unable_to_clear')))).toBe('waits_list');
    expect(await snapshot(l.id)).toEqual(before);
    await rejectTransfer(store, db, l.id, REJ, undefined, review(l, 'list_wait', 'unable_to_clear'));
    expect((await store.getTransfer(l.id))?.status).toBe('cancelled');
    expect(await reviewRows(l.id)).toHaveLength(1);

    const d = await heldRowFor(db, 'acme', 'data_missing', { id: 'rj_data' });
    // The rows above share the one fixture sender, whose data they put on file: take it off again.
    await db.execute(sql`UPDATE customers SET residential_address_enc = NULL, date_of_birth_enc = NULL WHERE partner_id = 'acme' AND phone = ${d.phone}`);
    await rejectTransfer(store, db, d.id, REJ, undefined, review(d, 'data_missing', 'data_not_provided'));
    expect((await store.getTransfer(d.id))?.status).toBe('cancelled');
    expect((await reviewRows(d.id)).map((r) => [r.hold_class, r.disposition])).toEqual([['data_missing', 'data_not_provided']]);
  });

  it('12: a lost claim (status flipped by SQL after the read): the platform concurrent text; no review row', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const rv = review(t, 'kyc', 'customer_not_verified');
    const stale = { getTransfer: async () => t } as unknown as Store; // the caller's read, before the flip
    await db.execute(sql`UPDATE transfers SET status = 'paid' WHERE id = ${t.id}`);
    const before = await snapshot(t.id);
    await expect(rejectTransfer(stale, db, t.id, REJ, undefined, rv)).rejects.toThrow(PLATFORM_CONCURRENT);
    expect(await snapshot(t.id)).toEqual(before);
    expect(before.reviews).toBe(0);
  });

  it("13: a stale rowFp: HoldReviewChangedError('changed'), nothing written", async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const before = await snapshot(t.id);
    const err = await rejectTransfer(store, db, t.id, REJ, undefined, review(t, 'kyc', 'customer_not_verified', { rowFp: 'v1|stale' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HoldReviewChangedError);
    expect((err as HoldReviewChangedError).why).toBe('changed');
    expect((err as Error).message.startsWith('Cannot')).toBe(false);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('14: the review insert returns null: HoldReviewChangedError; the cancel rolled back, no audit, no funding.refund', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc', { fundingProvider: 'mock', fundingRef: 'mock_pi_insert' });
    const before = await snapshot(t.id);
    reviewInsert.refuse = true;
    await expect(rejectTransfer(store, db, t.id, REJ, undefined, review(t, 'kyc', 'customer_not_verified'))).rejects.toBeInstanceOf(HoldReviewChangedError);
    expect(await snapshot(t.id)).toEqual({ ...before, status: 'in_review' });
    expect((await outboxRows()).some((r) => r.dedupe_key === `refund:${t.id}`)).toBe(false);
  });

  it('15: partner scope, a kyc row with no SENDER_SCREENING reason, the locked sender has a watchlist hit or an uncleared stamp: waits_platform', async () => {
    await certifiedQueuePartner(db);
    const a = await heldRowFor(db, 'acme', 'kyc', { id: 'rj_wl' });
    await db.execute(sql`UPDATE customers SET watchlist_hit = true WHERE partner_id = 'acme' AND phone = ${a.phone}`);
    let before = await snapshot(a.id);
    expect(await why(rejectTransfer(store, db, a.id, partnerAudit(), undefined, partnerReview(a, 'kyc', 'customer_not_verified')))).toBe('waits_platform');
    expect(await snapshot(a.id)).toEqual(before);

    // T9 (R2): readSenderScreeningFlags now reads screening_watchlist_at, so a PEP hit with an
    // uncleared stamp is PEP-only (senderPepOnly) and no longer waits for the platform on an owner
    // whose partner decides KYC (b2 below). An unattributable stamp (no boolean) still waits.
    const b = await heldRowFor(db, 'acme', 'kyc', { id: 'rj_stamp' });
    await db.execute(sql`UPDATE customers SET watchlist_hit = false, pep_hit = NULL, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${b.phone}`);
    before = await snapshot(b.id);
    expect(await why(rejectTransfer(store, db, b.id, partnerAudit(), undefined, partnerReview(b, 'kyc', 'customer_not_verified')))).toBe('waits_platform');
    expect(await snapshot(b.id)).toEqual(before);

    const b2 = await heldRowFor(db, 'acme', 'kyc', { id: 'rj_pep' });
    await db.execute(sql`UPDATE customers SET watchlist_hit = false, pep_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${b2.phone}`);
    await rejectTransfer(store, db, b2.id, partnerAudit(), undefined, partnerReview(b2, 'kyc', 'customer_not_verified'));
    expect((await store.getTransfer(b2.id))?.status).toBe('cancelled');

    // A watchlist hit whose stamp a platform clear covers adds no sender class, so the route
    // alone would let it through: the partner reject stance (P9 step 4) still refuses it.
    const c = await heldRowFor(db, 'acme', 'kyc', { id: 'rj_cleared' });
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, pep_hit = false, screening_flagged_at = now() - interval '1 hour',
      screening_cleared_at = now() WHERE partner_id = 'acme' AND phone = ${c.phone}`);
    before = await snapshot(c.id);
    expect(await why(rejectTransfer(store, db, c.id, partnerAudit(), undefined, partnerReview(c, 'kyc', 'customer_not_verified')))).toBe('waits_platform');
    expect(await snapshot(c.id)).toEqual(before);
  });

  it('16: review and partnerReject together, or an audit that is not the review, throw before any read', async () => {
    await delegated();
    const t = await heldRowFor(db, 'acme', 'kyc');
    const rv = review(t, 'kyc', 'customer_not_verified');
    ownerRead.mode = 'throw';
    await expect(rejectTransfer(store, db, 'no_such_row', REJ, { partnerId: 'acme' }, rv)).rejects.toThrow(/exclusive/);
    await expect(rejectTransfer(store, db, 'no_such_row', { actor: 'someone-else', reason: REASON }, undefined, rv)).rejects.toThrow(/audit context/);
    await expect(rejectTransfer(store, db, 'no_such_row', undefined, undefined, rv)).rejects.toThrow(/audit context/);
    ownerRead.mode = 'real';
    const before = await snapshot(t.id);
    await expect(rejectTransfer(store, db, t.id, REJ, undefined, { ...rv, ownerId: 'other' })).rejects.toBeInstanceOf(HoldReviewChangedError);
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('17: a LARGE row with a later sender watchlist stamp (R1 a): the partner kyc reject waits_platform; a platform sender_watchlist confirmed_match reject cancels', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    // O3: a small SQL step for the later stamp (heldRowFor has no option for it).
    await db.execute(sql`UPDATE customers SET watchlist_hit = true, screening_flagged_at = now() WHERE partner_id = 'acme' AND phone = ${t.phone}`);
    const before = await snapshot(t.id);
    expect(await why(rejectTransfer(store, db, t.id, partnerAudit(), undefined, partnerReview(t, 'kyc', 'customer_not_verified')))).toBe('waits_platform');
    expect(await snapshot(t.id)).toEqual(before);
    await rejectTransfer(store, db, t.id, REJ, undefined, review(t, 'sender_watchlist', 'confirmed_match'));
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.actor_scope])).toEqual([['sender_watchlist', 'platform']]);
  });

  it('18: the owner is re-read in the transaction: a certification revoked between the plan and the seam is changed; nothing written', async () => {
    await certifiedQueuePartner(db);
    const t = await heldRowFor(db, 'acme', 'kyc');
    const planned = partnerReview(t, 'kyc', 'customer_not_verified');
    await db.execute(sql`UPDATE partners SET live_controls = '{}'::jsonb WHERE id = 'acme'`);
    const before = await snapshot(t.id);
    expect(await why(rejectTransfer(store, db, t.id, partnerAudit(), undefined, planned))).toBe('changed');
    expect(await snapshot(t.id)).toEqual(before);
  });

  it('platformReviewFor fixtures: the review it returns rejects a mixed row on a delegated owner', async () => {
    await delegated();
    const t = await setReasons((await heldRowFor(db, 'acme', 'kyc')).id, [LARGE_AMOUNT_REASON, POSSIBLE_MATCH_REASON]);
    const rv = await platformReviewFor(db, t.id, REJ, { holdClass: 'sanctions_review', disposition: 'confirmed_match' });
    await rejectTransfer(store, db, t.id, REJ, undefined, rv);
    expect((await store.getTransfer(t.id))?.status).toBe('cancelled');
    expect((await reviewRows(t.id)).map((r) => [r.hold_class, r.disposition])).toEqual([
      ['kyc', 'documents_verified'], ['sanctions_review', 'confirmed_match'],
    ]);
  });
});
