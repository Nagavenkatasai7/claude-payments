import type { DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { createHoldReviewRepo, type HoldReviewEvidence } from '@/db/repos/hold-review-repo';
import {
  ORIGINATOR_INFO_MISSING_REASON,
  RECIPIENT_IDENTITY_MISSING_REASON,
  senderScreeningHoldActive,
  type CustomerScreeningFlags,
} from './compliance-config';
import {
  classifyHold,
  classReasonsFp,
  decisionRoute,
  dispositionReleases,
  nextStep,
  rowReasonsFp,
  senderPepOnly,
  toReviewRowLite,
  type ClassifiedClass,
  type DecisionRoute,
  type HoldClass,
  type HoldDisposition,
  type ReviewRowLite,
} from './hold-queue';
import { holdQueueApplies, partnerDecidesKyc, reviewRecordApplies } from './partner-decision-scope';
import { identityMissingForRelease, originatorMissingForRelease } from './release-data-checks';
import { realMoneyRail } from './live-gate';
import { clearPepInTx } from './sender-screening';
import { logWarn } from './log';
import type { PartnerIntegrations } from './partner-integrations';
import type { Partner, PartnerId, Transfer } from './types';

// hold-review-tx — Fix pack 7 T8a (P9): the in-transaction check of a hold
// decision with a review record. SERVER-ONLY. It never imports settlement or
// dashboard-ops (settlement.ts and dashboard-ops.ts import THIS module; T10's
// hold-decision.ts re-exports the contract names), so there is no import cycle.
//
// The seam re-reads the OWNER inside the transaction (P9 step 1b) and derives
// queue / partnerDecidesKyc / fourEyes there: a caller can neither pass a wrong
// value nor miss a certification revoked between its read and the transaction.
// The sender flags are ALWAYS read under the lock (R1; a failed read is null:
// fail closed). Nothing here writes, except insertReview.

export interface HoldReviewInput {
  ownerId: PartnerId;
  holdClass: HoldClass;
  rowFp: string;
  disposition: HoldDisposition;
  reason: string;
  actor: string;
  actorScope: 'partner' | 'platform';
  evidence: HoldReviewEvidence;
  /** R6: the plan's step.final; the locked step must match. */
  expectFinal: boolean;
  /** A partner's final releasing sender_pep step only (P23, T9: clearPepInTx in the seam's transaction). */
  pepClear?: { reviewedFlaggedAt: string };
}

export type HoldRefusedWhy = Extract<DecisionRoute, { kind: 'refused' }>['why'];

/** A review the locked row no longer matches. The message never starts with "Cannot". */
export class HoldReviewChangedError extends Error {
  constructor(readonly why: HoldRefusedWhy) {
    super(`hold_review_changed:${why}`);
    this.name = 'HoldReviewChangedError';
  }
}

export interface RoutedReview {
  kind: 'ok';
  t: Transfer;
  owner: Partner;
  flags: CustomerScreeningFlags | null;
  cls: ClassifiedClass;
  step: { step: 1 | 2; final: boolean };
  reasonsFp: string;
}

export type ReviewRouteResult =
  | RoutedReview
  | { kind: 'already' }
  | { kind: 'changed'; why: HoldRefusedWhy }
  /** want 'release' only: refused while the sender's screening hold is active on real money (no pepClear). */
  | { kind: 'sender_hold' };

export type ReviewWant = 'release' | 'reject' | 'record';

/**
 * P9 step 6 (T9): the PEP-clear rule on a routed review, checked BEFORE anything
 * is written. A partner's final releasing sender_pep step needs `pepClear`
 * (without it: 'disposition'). F1 (early review EA1/EB1): `pepClear` on a
 * partner sender_pep releasing step that is NOT final (four-eyes step 1; the
 * cycle changed between the plan and the lock) answers 'changed' like every
 * other changed-under-lock case; callers drop pepClear on a planned non-final
 * step. `pepClear` on any other class, scope or a disposition that does not
 * release is a programming error (throws). Returns null when the review may go on.
 */
export function pepClearRefusal(r: Pick<RoutedReview, 'cls' | 'step'>, review: HoldReviewInput): HoldRefusedWhy | null {
  const partnerPepReleaseStep =
    r.cls.holdClass === 'sender_pep' && review.actorScope === 'partner' && dispositionReleases(review.disposition);
  const partnerPepRelease = partnerPepReleaseStep && r.step.final;
  if (review.pepClear) {
    if (!partnerPepReleaseStep) throw new Error('hold review: pepClear is for a final partner sender_pep release only');
    return partnerPepRelease ? null : 'changed';
  }
  return partnerPepRelease ? 'disposition' : null;
}

/**
 * P9 step 6 (T9, P23): the partner's PEP clear in the caller's transaction, on
 * the LOCKED row (clearPepInTx re-checks the locked customer flags and throws
 * KycScreeningChangedError, which the caller maps to 'changed' after the
 * rollback). Call pepClearRefusal first; a no-op without `pepClear`.
 */
export async function applyPepClear(tx: DbOrTx, t: Pick<Transfer, 'id' | 'partnerId' | 'phone'>, review: HoldReviewInput): Promise<void> {
  if (!review.pepClear) return;
  await clearPepInTx(tx, {
    partnerId: t.partnerId,
    phone: t.phone,
    reviewedFlaggedAt: review.pepClear.reviewedFlaggedAt,
    actor: review.actor,
    via: 'hold_review',
    transferId: t.id,
  });
}

function hasDataMissingReason(t: Pick<Transfer, 'complianceReasons'>): boolean {
  const r = t.complianceReasons ?? [];
  return r.includes(RECIPIENT_IDENTITY_MISSING_REASON) || r.includes(ORIGINATOR_INFO_MISSING_REASON);
}

/**
 * P9 steps 1-4: lock the row tenant-pinned to `review.ownerId`, then route it
 * (routeLockedReview). Null or not in_review -> 'already'.
 */
/**
 * Fix pack 7 F4 (early review EE2): the sender flags read under the lock (`forUpdate`, transfer ->
 * customer order) for the callers that turn a FAILED read into a fail-closed answer and then go on
 * in the SAME transaction (routeLockedReview, rejectTransfer, refundHoldGuard). The read runs in a
 * SAVEPOINT (drizzle's nested transaction: node_modules/drizzle-orm/neon-serverless/session.js:197-208,
 * pglite/session.js:138-153, typed at neon-serverless/session.d.ts:56 and pglite/session.d.ts:54;
 * the same pattern as store.ts `inSavepoint`): a failed statement rolls back to the savepoint
 * ONLY, so the caller's next statement does not fail with 25P02 (in failed transaction). The lock
 * taken by a successful read belongs to the outer transaction (a released savepoint keeps its
 * locks). `{ read: false }` = the read failed (the error NAME only, never the driver object);
 * `{ read: true, flags: null }` = this tenant has no customer row for the phone. Call it inside a
 * transaction: on a bare Db handle the read would run in a transaction of its own and the lock
 * would not outlive it.
 */
export async function readSenderFlagsLocked(
  tx: DbOrTx,
  partnerId: PartnerId,
  phone: string,
): Promise<{ read: true; flags: CustomerScreeningFlags | null } | { read: false; errorName: string }> {
  try {
    const flags = await tx.transaction((sp) => readSenderScreeningFlags(sp, partnerId, phone, { forUpdate: true }));
    return { read: true, flags };
  } catch (err) {
    return { read: false, errorName: err instanceof Error ? err.name : 'error' };
  }
}

export async function lockAndRouteReview(
  tx: DbOrTx,
  transferId: string,
  review: HoldReviewInput,
  want: ReviewWant,
  railIntegrations?: PartnerIntegrations,
): Promise<ReviewRouteResult> {
  const t = await createTransferRepo(tx).getTransferForUpdate(transferId, { partnerId: review.ownerId });
  if (!t || t.status !== 'in_review') return { kind: 'already' };
  return routeLockedReview(tx, t, review, want, railIntegrations);
}

/**
 * P9 steps 1b-4 on a row the caller already locked (FOR UPDATE, tenant-pinned):
 * the owner re-read, the row fingerprint, the sender flags (locked), dataOnFile,
 * the classes, the stored reviews, decisionRoute and nextStep. Every refusal is
 * RETURNED here (nothing is written); the money paths throw it so their
 * transaction rolls back (M5).
 */
export async function routeLockedReview(
  tx: DbOrTx,
  t: Transfer,
  review: HoldReviewInput,
  want: ReviewWant,
  railIntegrations?: PartnerIntegrations,
): Promise<ReviewRouteResult> {
  const changed = (why: HoldRefusedWhy): ReviewRouteResult => ({ kind: 'changed', why });
  if (typeof review.reason !== 'string' || review.reason.trim() === '' || typeof review.actor !== 'string' || review.actor === '') {
    throw new Error('hold review: actor and reason are required');
  }
  if (t.partnerId !== review.ownerId || t.status !== 'in_review') return { kind: 'already' };
  // F3 (defence in depth): a partner never decides a sandbox row (the queue is live only); platform scope unchanged.
  if (review.actorScope === 'partner' && t.environment === 'test') return changed('not_yours');

  // 1b. the owner, re-read in this transaction.
  let owner: Partner | null;
  try {
    owner = await createPartnerRepo(tx).getPartner(t.partnerId);
  } catch (err) {
    logWarn('hold-review.owner-read', err instanceof Error ? err.name : 'error', { transferId: t.id });
    return changed('changed');
  }
  if (!owner || !reviewRecordApplies(owner)) return changed('changed');
  const queue = holdQueueApplies(owner);
  if (review.actorScope === 'partner' && !queue) return changed('not_yours');
  const fourEyes = owner.liveControls?.posture?.fourEyesNonSanctions === true;

  // 2. the whole row's fingerprint.
  let fp: string;
  try {
    fp = rowReasonsFp(t.complianceReasons);
  } catch {
    return changed('changed');
  }
  if (fp !== review.rowFp) return changed('changed');

  // 3. the sender flags, ALWAYS, locked (transfer -> customer order); a failed read is null (fail
  // closed). F4 (EE2): in a savepoint, so a SQL failure leaves this transaction usable.
  const read = await readSenderFlagsLocked(tx, t.partnerId, t.phone);
  if (!read.read) logWarn('hold-review.flags-read', read.errorName, { transferId: t.id });
  const flags: CustomerScreeningFlags | null = read.read ? read.flags : null;

  // 3b. dataOnFile (P4), only when a data_missing reason is present, with the RAIL partner's integrations.
  let dataOnFile = false;
  if (hasDataMissingReason(t)) {
    const rail = railIntegrations ?? (await createIntegrationsRepo(tx).getIntegrations(t.settlementPartnerId ?? t.partnerId));
    dataOnFile = !(await identityMissingForRelease(tx, t, rail)) && !(await originatorMissingForRelease(tx, t, rail));
  }

  // 4. classes, the stored reviews, the route and the step.
  const classes = classifyHold(
    t.complianceReasons,
    flags,
    { queue, partnerDecidesKyc: partnerDecidesKyc(owner) },
    { blocked: t.complianceStatus === 'blocked', dataOnFile },
  );
  const stored = await createHoldReviewRepo(tx).listForTransfer(t.partnerId, t.id);
  const reviews = stored.map(toReviewRowLite).filter((r): r is ReviewRowLite => r !== null);

  // A release refused while the sender's screening hold is active on real money says so
  // (the sender rule would refuse it anyway). With pepClear (T9) the rule runs after the clear.
  const senderHeld = () =>
    want === 'release' &&
    !review.pepClear &&
    railIntegrations !== undefined &&
    realMoneyRail({ environment: t.environment, railProviderType: railIntegrations.payment.providerType ?? null }) &&
    senderScreeningHoldActive(flags);
  const refuse = (why: HoldRefusedWhy): ReviewRouteResult => (senderHeld() ? { kind: 'sender_hold' } : changed(why));

  const route = decisionRoute({
    classes,
    reviews,
    scope: review.actorScope,
    holdClass: review.holdClass,
    disposition: review.disposition,
    actor: review.actor,
    fourEyes,
    flags,
  });
  if (route.kind === 'refused') return refuse(route.why);
  if (route.kind !== want) return refuse('changed');
  const cls = classes.find((c) => c.holdClass === review.holdClass);
  if (!cls) return refuse('changed');
  const reasonsFp = classReasonsFp(cls, flags);
  const cycle = reviews.filter((r) => r.holdClass === cls.holdClass && r.reasonsFp === reasonsFp);
  const step = nextStep(cycle, review.actor, review.disposition, fourEyes && review.actorScope === 'partner');
  if ('refused' in step) return refuse(step.refused);
  // R6: a final step is never written without the step-up the plan asked for (and the converse).
  if (step.final !== review.expectFinal) return refuse('changed');
  if ((want === 'release' || want === 'reject') && !step.final) return refuse('changed');
  // P9 step 4 (T8b): a partner-scope reject keeps today's partner reject stance
  // (cancelInReviewForPartner refuses a flagged sender): unreadable flags, a watchlist
  // hit or an active stamp that is not PEP-only (senderPepOnly, R2) wait for the platform.
  // F4 (EB2): rule 8 of decisionRoute subsumes this today; kept as the last guard, pinned by
  // tests/hold-step4-guard.test.ts.
  if (
    want === 'reject' &&
    review.actorScope === 'partner' &&
    (flags === null || flags.watchlistHit === true || (senderScreeningHoldActive(flags) && !senderPepOnly(flags)))
  ) {
    return changed('waits_platform');
  }
  return { kind: 'ok', t, owner, flags, cls, step, reasonsFp };
}

/** P9 step 8: the review row, AFTER the claim. A unique index refusal throws (the claim rolls back). */
export async function insertReview(tx: DbOrTx, r: RoutedReview, review: HoldReviewInput): Promise<string> {
  const row = await createHoldReviewRepo(tx).insert({
    transferId: r.t.id,
    partnerId: r.t.partnerId,
    holdClass: r.cls.holdClass,
    reasonsFp: r.reasonsFp,
    step: r.step.step,
    final: r.step.final,
    disposition: review.disposition,
    reason: review.reason,
    evidence: review.evidence,
    actor: review.actor,
    actorScope: review.actorScope,
  });
  if (!row) throw new HoldReviewChangedError('changed');
  return row.id;
}
