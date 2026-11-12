'use server';

import { revalidatePath } from 'next/cache';
import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_OPS } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import type { HoldReviewEvidence } from '@/db/repos/hold-review-repo';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuthStore } from '@/lib/auth-store';
import { staffMfaEnrolled } from '@/lib/staff-mfa-store';
import { holdQueueApplies, isQualifiedComplianceUser } from '@/lib/partner-decision-scope';
import { allowedDispositions, dispositionReleases, isHoldClass, isHoldDisposition } from '@/lib/hold-queue';
import {
  decideHold,
  HoldReviewChangedError,
  parseHoldReason,
  planHoldDecision,
  type HoldRefusedWhy,
  type HoldReviewInput,
} from '@/lib/hold-decision';
import { loadHoldEvidence, toHoldReviewEvidence } from '@/lib/partner-screening-view';
import { ORIGINATOR_INFO_RELEASE_REFUSAL, PLATFORM_RESCREEN_REFUSALS, RECIPIENT_IDENTITY_RELEASE_REFUSAL } from '@/lib/dashboard-ops';
import { isTransferId } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import { gatePartnerStepUp } from '@/lib/partner-step-up-gate';
import type { StepUpRequired } from '@/lib/staff-step-up-result';
import type { Partner, Staff } from '@/lib/types';

export type HoldDecisionResult =
  | { ok: true; outcome: 'recorded' | 'awaiting_second' | 'released' | 'rejected' }
  | { ok: false; error: string };

type Fail = { ok: false; error: string };
type Key = Parameters<typeof t>[0];

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
const fail = (key: Key): Fail => ({ ok: false, error: t(key) });
const ROW_FP_MAX = 1000;

/** P10 step 9: a refusal of the plan or of the locked path, by its why. */
const WHY_KEY: Readonly<Record<HoldRefusedWhy, Key>> = Object.freeze({
  changed: 'partner.holdDecision.changed',
  not_yours: 'partner.holdDecision.notYours',
  waits_list: 'partner.holdDecision.waitsList',
  waits_data: 'partner.holdDecision.waitsData',
  waits_platform: 'partner.holdDecision.waitsPlatform',
  blocked: 'partner.holdDecision.notAllowed',
  closed: 'partner.holdDecision.closed',
  same_actor: 'partner.holdDecision.sameActor',
  disposition: 'partner.holdDecision.invalid',
});

/** The money path's refusal Errors, mapped to fixed partner copy (no sanctions wording). Null = unexpected. */
function refusalKey(err: unknown): Key | null {
  if (err instanceof HoldReviewChangedError) return WHY_KEY[err.why] ?? 'partner.holdDecision.changed';
  if (!(err instanceof Error)) return null;
  const m = err.message;
  if (m === RECIPIENT_IDENTITY_RELEASE_REFUSAL) return 'partner.transfers.holdIdentity';
  if (m === ORIGINATOR_INFO_RELEASE_REFUSAL) return 'partner.transfers.holdOriginator';
  // M13: the platform re-screen at release (newest screen older than 36 h) did not clear the row.
  if (m === PLATFORM_RESCREEN_REFUSALS.listNotLive) return 'partner.holdDecision.waitsList';
  if (m === PLATFORM_RESCREEN_REFUSALS.review || m === PLATFORM_RESCREEN_REFUSALS.blocked) return 'partner.holdDecision.changed';
  if (m.startsWith('Cannot release') || m.startsWith('Cannot reject')) return 'partner.holdDecision.notAllowed';
  return null;
}

/**
 * Fix pack 7 T11 (P10): a qualified compliance user of a hold-queue partner
 * records or completes ONE hold decision (a disposition for one hold class).
 * The page binds the transfer id: `decideHoldAction.bind(null, transfer.id)`.
 * Nothing here is trusted from the client: the tenant comes from the session,
 * the route id is authoritative (a body id that differs is not found), and
 * the routing (queue, four-eyes, who decides each class) is derived from the
 * OWNER row, here and again inside the money transaction. Gates, in order,
 * each refusing with one fixed text and nothing written:
 *  1. refuseOnSiteHost; 2. requirePartnerStaff(PARTNER_OPS) (outside any try);
 *  3. the owner (a failed or empty read refuses) is holdQueueApplies
 *     (certified for live money, signed posture holdDecider 'partner');
 *  4. a FRESH staff read: a listed, active admin/agent of this tenant
 *     (isQualifiedComplianceUser), then two-step enrolled (fails closed); a
 *     user who is not listed never learns about the MFA rule;
 *  5. the bound id is a transfer id of this OWNER (getOwnedTransfer; a routed
 *     row's settlement partner never sees it; 404, never 403);
 *  6. the inputs: a hold class, a disposition the partner may give for it, the
 *     row fingerprint the page saw, the reason (P7), and for a sender_pep
 *     release the screening flag time the user reviewed (the PEP clear);
 *  7. the unlocked plan (planHoldDecision): its refusal, or a stale row
 *     fingerprint, maps to fixed copy BEFORE any step-up;
 *  8. the forced step-up 'hold.decide' (always asks) on a FINAL step only; a
 *     non-final four-eyes step 1 needs none. The four-eyes rule is ENFORCED
 *     (the posture's fourEyesNonSanctions; two distinct qualified users);
 *  9. decideHold (the review row, the audit row and the money change in ONE
 *     transaction; it pokes after every final outcome). Its refusals map to
 *     fixed copy; anything else logs the error NAME only.
 */
export async function decideHoldAction(
  routeId: string,
  _prev: unknown,
  formData: FormData,
): Promise<HoldDecisionResult | StepUpRequired> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_OPS);

  // 3. The owner: a failed or empty read is a refusal, never "not certified".
  let owner: Partner | null;
  try {
    owner = await getPartnerStore().getPartner(ctx.partnerId);
  } catch {
    owner = null;
  }
  if (!owner || !holdQueueApplies(owner)) return fail('partner.holdDecision.notAllowed');

  // 4. A fresh staff read (a session may outlive a role change), then MFA (fails closed).
  let staff: Staff | null;
  try {
    staff = await getAuthStore().getStaff(ctx.username);
  } catch {
    return fail('partner.holdDecision.notCompliance');
  }
  const fact = staff
    ? { username: staff.username, partnerId: staff.partnerId ?? null, role: staff.role, active: staff.status !== 'suspended' }
    : null;
  if (!fact || fact.username !== ctx.username || !isQualifiedComplianceUser(owner, fact, true)) {
    return fail('partner.holdDecision.notCompliance');
  }
  let mfa: boolean;
  try {
    mfa = await staffMfaEnrolled(ctx.username);
  } catch {
    mfa = false;
  }
  if (!isQualifiedComplianceUser(owner, fact, mfa)) return fail('partner.holdDecision.mfaRequired');

  // 5. The bound route id is authoritative; the owner tenant only (404, never 403).
  const notFound = fail('partner.common.notFound');
  const id = routeId;
  const bodyId = formData.get('id');
  if (bodyId !== null && bodyId !== id) return notFound;
  if (!isTransferId(id)) return notFound;
  const transfer = await createTransferRepo(getDb()).getOwnedTransfer(ctx.partnerId, id);
  if (!transfer || transfer.partnerId !== ctx.partnerId) return notFound;
  // F3 (early review EA2/EC2): the queue is for LIVE rows only; SmartRemit decides sandbox holds.
  if (transfer.environment === 'test') return fail('partner.holdDecision.notAllowed');

  // 6. The inputs.
  const invalid = fail('partner.holdDecision.invalid');
  const holdClass = formData.get('holdClass');
  const disposition = formData.get('disposition');
  const rowFp = formData.get('rowFp');
  if (!isHoldClass(holdClass) || !isHoldDisposition(disposition)) return invalid;
  const allowed = allowedDispositions(holdClass, 'partner');
  if (!allowed.release.includes(disposition) && !allowed.reject.includes(disposition)) return invalid;
  if (typeof rowFp !== 'string' || rowFp === '' || rowFp.length > ROW_FP_MAX) return invalid;
  const parsed = parseHoldReason(formData.get('reason'));
  if (!parsed.ok) return fail(parsed.code === 'short' ? 'partner.release.reasonTooShort' : 'partner.release.reasonHasNumber');
  let pepClear: HoldReviewInput['pepClear'];
  if (holdClass === 'sender_pep' && dispositionReleases(disposition)) {
    const at = formData.get('screeningFlaggedAt');
    // '' = the user reviewed a flag with no time on file; anything else must be a readable time.
    if (typeof at !== 'string' || (at !== '' && !Number.isFinite(Date.parse(at)))) return invalid;
    pepClear = { reviewedFlaggedAt: at };
  }

  // 7. The unlocked plan (no fourEyes / queue input: derived from the owner, P9).
  const review: HoldReviewInput = {
    ownerId: ctx.partnerId,
    holdClass,
    rowFp,
    disposition,
    reason: parsed.reason,
    actor: ctx.username,
    actorScope: 'partner',
    evidence: {},
    expectFinal: false,
    ...(pepClear ? { pepClear } : {}),
  };
  let plan: Awaited<ReturnType<typeof planHoldDecision>>;
  try {
    const { expectFinal: _unused, ...planInput } = review;
    void _unused;
    plan = await planHoldDecision(getDb(), getStore(), { ...planInput, transferId: id });
  } catch (err) {
    const key = refusalKey(err);
    if (key) return fail(key);
    logWarn('partner.hold-decide', errName(err), { transferId: id });
    return fail('partner.common.failed');
  }
  review.expectFinal = plan.step.final; // R6: the locked step must be the planned one
  // F1 (early review EA1/EB1): the PEP clear rides only on the FINAL step; a four-eyes
  // step 1 is recorded with no clear (the second user's final step clears).
  if (!plan.step.final) delete review.pepClear;

  // 8. The forced step-up, on a final step only.
  if (plan.stepUp) {
    const s = await gatePartnerStepUp(ctx, formData, 'hold.decide', { always: true });
    if (s) return s;
  }

  // 9. Evidence (ids, versions, scores and enums only; the decision does not depend on it), then the decision.
  let evidence: HoldReviewEvidence = {};
  try {
    evidence = toHoldReviewEvidence(await loadHoldEvidence(getDb(), ctx.partnerId, transfer));
  } catch (err) {
    logWarn('partner.hold-decide.evidence', errName(err), { transferId: id });
  }
  let outcome: Extract<HoldDecisionResult, { ok: true }>['outcome'];
  try {
    ({ outcome } = await decideHold(getDb(), getStore(), { ...review, evidence, transferId: id }));
  } catch (err) {
    const key = refusalKey(err);
    if (key) return fail(key);
    logWarn('partner.hold-decide', errName(err), { transferId: id });
    return fail('partner.common.failed');
  }
  // 10. decideHold pokes after every final outcome (C6); nothing to poke here.
  revalidatePath(`/partner/transfers/${id}`);
  revalidatePath('/partner/reviews');
  return { ok: true, outcome };
}
