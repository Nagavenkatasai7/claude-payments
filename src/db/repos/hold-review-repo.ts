import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { holdReviews } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import type { PartnerId } from '@/lib/types';

// hold-review-repo (fix pack 7, P6) — the append-only record of every hold
// decision (table 0041 hold_reviews).
//
//  • APPEND-ONLY: the database triggers hold_reviews_no_update / _no_delete
//    reject every UPDATE and DELETE. This module has no update and no delete
//    (tests/hold-reviews-append-only.test.ts, tests/hold-review-repo.test.ts).
//  • INSERT: ON CONFLICT DO NOTHING with NO target, so BOTH unique indexes
//    (hold_reviews_cycle_step, hold_reviews_cycle_actor) answer with null; the
//    caller throws HoldReviewChangedError and rolls back. A FK or CHECK error
//    propagates (throws).
//  • TENANT-SCOPED: every read has partner_id = the OWNER (transfers.partner_id),
//    never the settlement partner of a routed row.
//  • `reason` is the bounded decision reason (P7): never log it, never put it in
//    an event, an alert or an outbox payload.
//  • holdClass and disposition are `string` here (the DB has no CHECK on
//    either): callers validate before a write (P5/P6), readers narrow rows with
//    hold-queue's toReviewRowLite (T6).

/** Ids, versions, scores and closed enums only (P15). T7 derives AmlSubKind from `amlKinds`. */
export interface HoldReviewEvidence {
  listSource?: string;
  listVersion?: string;
  screenedAt?: string;
  maxScore?: number;
  matchedEntryIds?: string[];
  amlKinds?: Array<'aml_rule' | 'aml_check_failed' | 'scam_pattern' | 'risk_signal'>;
  amlRules?: string[];
  riskSignals?: string[];
  scamCategory?: string;
}

export interface HoldReviewWrite {
  transferId: string;
  /** The transfer OWNER. */
  partnerId: PartnerId;
  holdClass: string;
  reasonsFp: string;
  step: 1 | 2;
  final: boolean;
  disposition: string;
  reason: string;
  evidence: HoldReviewEvidence;
  actor: string;
  actorScope: 'partner' | 'platform';
}

export interface HoldReviewRow extends HoldReviewWrite {
  id: string;
  createdAt: string;
}

/** listForQueue reads at most this many transfer ids per call (one queue page). */
export const HOLD_QUEUE_MAX_IDS = 50;

type Selected = typeof holdReviews.$inferSelect;

function toRow(r: Selected): HoldReviewRow {
  return {
    id: r.id,
    transferId: r.transferId,
    partnerId: r.partnerId,
    holdClass: r.holdClass,
    reasonsFp: r.reasonsFp,
    // The CHECKs hold_reviews_step and hold_reviews_actor_scope make other values impossible.
    step: r.step as 1 | 2,
    final: r.final,
    disposition: r.disposition,
    reason: r.reason,
    evidence: (r.evidence ?? {}) as HoldReviewEvidence,
    actor: r.actor,
    actorScope: r.actorScope as 'partner' | 'platform',
    createdAt: new Date(r.createdAt).toISOString(),
  };
}

export function createHoldReviewRepo(db: DbOrTx) {
  const order = [asc(holdReviews.createdAt), asc(holdReviews.step), asc(holdReviews.id)] as const;
  return {
    /** Insert one review. null = a unique index refused it (same step, or same actor, in this cycle). */
    async insert(w: HoldReviewWrite): Promise<{ id: string } | null> {
      const rows = await db
        .insert(holdReviews)
        .values({
          id: randomUUID(),
          transferId: w.transferId,
          partnerId: w.partnerId,
          holdClass: w.holdClass,
          reasonsFp: w.reasonsFp,
          step: w.step,
          final: w.final,
          disposition: w.disposition,
          reason: w.reason,
          evidence: w.evidence,
          actor: w.actor,
          actorScope: w.actorScope,
        })
        .onConflictDoNothing()
        .returning({ id: holdReviews.id });
      return rows[0] ? { id: rows[0].id } : null;
    },

    /** The owner's reviews of one transfer, oldest first (created_at, then step). */
    async listForTransfer(partnerId: PartnerId, transferId: string): Promise<HoldReviewRow[]> {
      const rows = await db
        .select()
        .from(holdReviews)
        .where(and(eq(holdReviews.partnerId, partnerId), eq(holdReviews.transferId, transferId)))
        .orderBy(...order);
      return rows.map(toRow);
    },

    /** One review of this owner (the event body read, P21); null for another tenant or an unknown id. */
    async getById(partnerId: PartnerId, id: string): Promise<HoldReviewRow | null> {
      const rows = await db
        .select()
        .from(holdReviews)
        .where(and(eq(holdReviews.partnerId, partnerId), eq(holdReviews.id, id)))
        .limit(1);
      return rows[0] ? toRow(rows[0]) : null;
    },

    /** The owner's reviews of up to HOLD_QUEUE_MAX_IDS transfers (hold_reviews_partner_queue). */
    async listForQueue(partnerId: PartnerId, transferIds: readonly string[]): Promise<HoldReviewRow[]> {
      if (transferIds.length > HOLD_QUEUE_MAX_IDS) {
        throw new RangeError(`hold-review-repo: at most ${HOLD_QUEUE_MAX_IDS} transfer ids`);
      }
      if (transferIds.length === 0) return [];
      const rows = await db
        .select()
        .from(holdReviews)
        .where(and(eq(holdReviews.partnerId, partnerId), inArray(holdReviews.transferId, [...transferIds])))
        .orderBy(asc(holdReviews.transferId), ...order);
      return rows.map(toRow);
    },
  };
}
