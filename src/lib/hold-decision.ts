// hold-decision — Fix pack 7 (P7, P13): the decision reason and the evidence
// bounds of a hold decision. SERVER-ONLY (no 'use server': these are helpers,
// not actions): isPartnerNoteShaped lives in partner-transfers.ts, which
// reaches node:crypto, and PURPOSE_RISK_CATEGORIES reaches node:url. No
// 'use client' file may import this module.
//
// The decision reason is the ONE free text of pack 7. It is bounded, and
// stored only in `hold_reviews.reason` and in audit meta `reason`. It never
// enters an event, an alert, a log line, an outbox payload or DETAIL_KEYS.
// Known limit: it is not sealed, like audit meta reasons.
//
// T10 (P13): `planHoldDecision` (the unlocked pre-route) and `decideHold`
// (the shared decision core of the partner and platform actions) live here too.
import type { Db } from '@/db/client';
import { createHoldReviewRepo, type HoldReviewEvidence } from '@/db/repos/hold-review-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { ORIGINATOR_INFO_MISSING_REASON, RECIPIENT_IDENTITY_MISSING_REASON, senderScreeningHoldActive } from './compliance-config';
import { rejectTransfer, releaseTransfer } from './dashboard-ops';
import {
  classifyHold,
  classReasonsFp,
  decisionRoute,
  nextStep,
  rowReasonsFp,
  senderPepOnly,
  toReviewRowLite,
  type ClassifiedClass,
  type DecisionRoute,
  type ReviewRowLite,
} from './hold-queue';
import { HoldReviewChangedError, pepClearRefusal, type HoldRefusedWhy, type HoldReviewInput } from './hold-review-tx';
import { logWarn } from './log';
import { pokeWorker } from './outbox';
import { holdQueueApplies, partnerDecidesKyc, reviewRecordApplies } from './partner-decision-scope';
import { identityMissingForRelease, originatorMissingForRelease } from './release-data-checks';
import { loadSenderScreening } from './sender-screening';
import { recordHoldStep } from './settlement';
import type { Store } from './store';
import { AML_HOLD_RULES } from './aml-rules';
import { isPartnerNoteShaped } from './partner-transfers';
import { PURPOSE_RISK_CATEGORIES } from './purpose-detail';
import { RISK_SIGNALS } from './risk-signals';
import { requireStaffReason, STAFF_REASON_MAX, STAFF_REASON_MIN } from './send-limits';
import { isReasonValid } from './ui/confirm-reason';

// P9/P13: the contract names, re-exported by name. They live lower
// (hold-review-tx.ts, settlement.ts) to avoid the dashboard-ops -> settlement
// -> hold-decision import cycle (T8a gap a).
export { HoldReviewChangedError, type HoldReviewInput, type HoldRefusedWhy } from './hold-review-tx';
export { recordHoldStep } from './settlement';

export const HOLD_REASON_MIN = STAFF_REASON_MIN;
export const HOLD_REASON_MAX = STAFF_REASON_MAX;

/**
 * P7: the decision reason, for BOTH scopes. The exact sequence of the partner
 * release action (release-actions.ts): the client rule (code points after
 * collapsing spaces), then the server rule (bounded, control characters
 * collapsed, at least 10, cut at 500), then no long digit run.
 */
export function parseHoldReason(raw: unknown): { ok: true; reason: string } | { ok: false; code: 'short' | 'number' } {
  if (!isReasonValid(raw, STAFF_REASON_MIN)) return { ok: false, code: 'short' };
  let reason: string;
  try {
    reason = requireStaffReason(raw);
  } catch {
    return { ok: false, code: 'short' };
  }
  if (!isPartnerNoteShaped(reason)) return { ok: false, code: 'number' };
  return { ok: true, reason };
}

/** P7: at most this many entries per evidence list. */
export const HOLD_EVIDENCE_LIST_MAX = 20;
const TEXT_MAX = 128;
/** A list entry id (`<prefix>:<uid>`), P7: at most 64 characters. */
const ENTRY_ID_RE = /^[A-Za-z0-9._:#/-]{1,64}$/;
type AmlKind = NonNullable<HoldReviewEvidence['amlKinds']>[number];
const AML_KINDS: readonly AmlKind[] = Object.freeze(['aml_rule', 'aml_check_failed', 'scam_pattern', 'risk_signal'] as const);

function closedList<T extends string>(v: unknown, allowed: (s: string) => boolean): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !allowed(x) || out.includes(x as T)) continue;
    out.push(x as T);
    if (out.length >= HOLD_EVIDENCE_LIST_MAX) break;
  }
  return out.length > 0 ? out : undefined;
}

function text(v: unknown): string | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  return v.slice(0, TEXT_MAX);
}

/**
 * P7: the evidence stored with a decision: ids, versions, scores and closed
 * enums only. Known keys only; every list is intersected with its closed set
 * (or the id shape), de-duplicated, kept in order and capped at 20. Anything
 * else (a hash, a name, a phone, an unknown key) is dropped.
 */
export function boundHoldEvidence(e: unknown): HoldReviewEvidence {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return {};
  const src = e as Record<string, unknown>;
  const out: HoldReviewEvidence = {};
  const listSource = text(src.listSource);
  if (listSource !== undefined) out.listSource = listSource;
  const listVersion = text(src.listVersion);
  if (listVersion !== undefined) out.listVersion = listVersion;
  // Kept as its ISO form (bounded and canonical; an ISO input is unchanged).
  if (typeof src.screenedAt === 'string' && Number.isFinite(Date.parse(src.screenedAt))) out.screenedAt = new Date(Date.parse(src.screenedAt)).toISOString();
  if (typeof src.maxScore === 'number' && Number.isFinite(src.maxScore) && src.maxScore >= 0 && src.maxScore <= 1) out.maxScore = src.maxScore;
  const ids = closedList<string>(src.matchedEntryIds, (s) => ENTRY_ID_RE.test(s));
  if (ids) out.matchedEntryIds = ids;
  const kinds = closedList<AmlKind>(src.amlKinds, (s) => (AML_KINDS as readonly string[]).includes(s));
  if (kinds) out.amlKinds = kinds;
  const rules = closedList<string>(src.amlRules, (s) => (AML_HOLD_RULES as readonly string[]).includes(s));
  if (rules) out.amlRules = rules;
  const signals = closedList<string>(src.riskSignals, (s) => (RISK_SIGNALS as readonly string[]).includes(s));
  if (signals) out.riskSignals = signals;
  if (typeof src.scamCategory === 'string' && (PURPOSE_RISK_CATEGORIES as readonly string[]).includes(src.scamCategory)) {
    out.scamCategory = src.scamCategory;
  }
  return out;
}

/** P13: the unlocked pre-route of one decision. `route` is never 'refused' (a refusal throws). */
export interface HoldDecisionPlan {
  route: DecisionRoute;
  step: { step: 1 | 2; final: boolean };
  /** P10 step 8 / P12: the step-up is forced on every FINAL step, both scopes. */
  stepUp: boolean;
  classes: ClassifiedClass[];
  rowFp: string;
}

export type HoldDecisionInput = HoldReviewInput & { transferId: string };

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/**
 * P13 (P10 step 7, P12): the UNLOCKED pre-route both decision actions run
 * before the step-up: the row (tenant, in_review, row fingerprint), the owner
 * (queue / partnerDecidesKyc / fourEyes are derived from it, never input
 * fields), the sender flags (always read, fail closed: null), dataOnFile, the
 * classes, the stored reviews, decisionRoute and nextStep. Every refusal
 * THROWS HoldReviewChangedError with the route's why. Reads only.
 * SERVER-ONLY. The step-up is the CALLER's job between this and decideHold;
 * the locked paths re-check everything (rowFp, classes, route, step, sender, tenant).
 */
export async function planHoldDecision(
  db: Db,
  store: Store,
  i: Omit<HoldReviewInput, 'expectFinal'> & { transferId: string },
): Promise<HoldDecisionPlan> {
  const refuse = (why: HoldRefusedWhy): never => {
    throw new HoldReviewChangedError(why);
  };
  const t = await store.getTransfer(i.transferId);
  if (!t || t.partnerId !== i.ownerId || t.status !== 'in_review') return refuse('changed');
  let rowFp: string;
  try {
    rowFp = rowReasonsFp(t.complianceReasons);
  } catch {
    return refuse('changed');
  }
  if (rowFp !== i.rowFp) return refuse('changed');

  let owner: Awaited<ReturnType<ReturnType<typeof createPartnerRepo>['getPartner']>>;
  try {
    owner = await createPartnerRepo(db).getPartner(t.partnerId);
  } catch (err) {
    logWarn('hold-decision.owner-read', errName(err), { transferId: t.id });
    return refuse('changed');
  }
  if (!owner || !reviewRecordApplies(owner)) return refuse('changed');
  const queue = holdQueueApplies(owner);
  // P13 (defence in depth): a partner scope only on a queue owner.
  if (i.actorScope === 'partner' && !queue) return refuse('not_yours');
  const fourEyes = owner.liveControls?.posture?.fourEyesNonSanctions === true;

  // R1: the flags are always read (the locked path reads them always too); fails closed to null.
  const flags = await loadSenderScreening(db, t.partnerId, t.phone);

  // P4 dataOnFile, only when a data_missing reason is present, with the RAIL partner's integrations.
  const reasons = t.complianceReasons ?? [];
  let dataOnFile = false;
  if (reasons.includes(RECIPIENT_IDENTITY_MISSING_REASON) || reasons.includes(ORIGINATOR_INFO_MISSING_REASON)) {
    const rail = await createIntegrationsRepo(db).getIntegrations(t.settlementPartnerId ?? t.partnerId);
    dataOnFile = !(await identityMissingForRelease(db, t, rail)) && !(await originatorMissingForRelease(db, t, rail));
  }

  const classes = classifyHold(
    t.complianceReasons,
    flags,
    { queue, partnerDecidesKyc: partnerDecidesKyc(owner) },
    { blocked: t.complianceStatus === 'blocked', dataOnFile },
  );
  const stored = await createHoldReviewRepo(db).listForTransfer(i.ownerId, t.id);
  const reviews = stored.map(toReviewRowLite).filter((r): r is ReviewRowLite => r !== null);
  const route = decisionRoute({
    classes,
    reviews,
    scope: i.actorScope,
    holdClass: i.holdClass,
    disposition: i.disposition,
    actor: i.actor,
    fourEyes,
    flags,
  });
  if (route.kind === 'refused') return refuse(route.why);
  const cls = classes.find((c) => c.holdClass === i.holdClass);
  if (!cls) return refuse('changed');
  const fp = classReasonsFp(cls, flags);
  const cycle = reviews.filter((r) => r.holdClass === cls.holdClass && r.reasonsFp === fp);
  const step = nextStep(cycle, i.actor, i.disposition, fourEyes && i.actorScope === 'partner');
  if ('refused' in step) return refuse(step.refused);
  if (route.kind !== 'record' && !step.final) return refuse('changed');
  // The locked path's checks that need no lock, so the action shows the right copy before a step-up:
  // the PEP-clear rule (P9 step 6) and the partner reject sender stance (P9 step 4).
  const pepRefused = pepClearRefusal({ cls, step }, { ...i, expectFinal: step.final });
  if (pepRefused) return refuse(pepRefused);
  if (
    route.kind === 'reject' &&
    i.actorScope === 'partner' &&
    (flags === null || flags.watchlistHit === true || (senderScreeningHoldActive(flags) && !senderPepOnly(flags)))
  ) {
    return refuse('waits_platform');
  }
  return { route, step, stepUp: step.final, classes, rowFp };
}

/**
 * P13: the shared decision core of the partner action (T11) and the platform
 * actions (T14a). Plans (planHoldDecision; a partner scope on an owner that
 * is not holdQueueApplies is 'not_yours'), refuses a plan whose step.final is
 * not `i.expectFinal` (R6), then hands off to exactly ONE path: recordHoldStep,
 * releaseTransfer or rejectTransfer with the review. It writes nothing itself;
 * the locked paths re-check everything (rowFp, classes, route, step, sender,
 * tenant) and their refusal Errors propagate unchanged (the callers map them).
 * The audit context is built from the review (P18-critic), so the review row
 * and the audit row never differ. Pokes after every FINAL outcome (C6).
 * SERVER-ONLY; the step-up is the CALLER's job between planHoldDecision and this.
 */
export async function decideHold(
  db: Db,
  store: Store,
  i: HoldDecisionInput,
): Promise<{ outcome: 'recorded' | 'awaiting_second' | 'released' | 'rejected' }> {
  const plan = await planHoldDecision(db, store, i);
  if (plan.step.final !== i.expectFinal) throw new HoldReviewChangedError('changed');
  const { transferId, ...review } = i;
  const audit = { actor: i.actor, reason: i.reason, actorScope: i.actorScope };
  let outcome: 'recorded' | 'awaiting_second' | 'released' | 'rejected';
  let final: boolean;
  switch (plan.route.kind) {
    case 'record': {
      const r = await recordHoldStep(db, i);
      if (r.kind !== 'recorded') throw new HoldReviewChangedError(r.kind === 'changed' ? r.why : 'changed');
      final = r.final;
      outcome = r.final ? 'recorded' : 'awaiting_second';
      break;
    }
    case 'release':
      await releaseTransfer(store, db, transferId, audit, undefined, review);
      final = true;
      outcome = 'released';
      break;
    case 'reject':
      await rejectTransfer(store, db, transferId, audit, undefined, review);
      final = true;
      outcome = 'rejected';
      break;
    default:
      throw new HoldReviewChangedError('changed');
  }
  // C6: rejectTransfer pokes only when it queued a refund; a final step's rows must not wait for the cron.
  if (final) pokeWorker();
  return { outcome };
}
