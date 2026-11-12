'use server';

import { revalidatePath } from 'next/cache';
import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { sendText } from '@/lib/whatsapp';
import {
  cancelTransfer,
  assignTransfer,
  resendPaymentLink,
  releaseTransfer,
  rejectTransfer,
  issueRefund,
  approveRefund,
  dismissRefund,
  retryRefund,
  canReleaseHeld,
  escalateHold,
  ESCALATE_NOT_HELD_REFUSAL,
  ESCALATE_NOT_QUEUE_REFUSAL,
  HOLD_REASON_REFUSAL,
  HOLD_REVIEW_RELOAD_REFUSAL,
  PARTNER_DECIDES_HOLD_REFUSAL,
  platformHoldRefusal,
  RESCREEN_ONLY_RELEASE_REFUSAL,
} from '@/lib/dashboard-ops';
import { getPartnerStore } from '@/lib/partner-store';
import { loadSenderScreening } from '@/lib/sender-screening';
import { getCustomerStore } from '@/lib/customer-store';
import { requireStaff, requireAdmin, requirePlatformAdmin } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { scopeOf, canSee } from '@/lib/staff-scope';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getDb } from '@/db/client';
import { boundStaffNote } from '@/lib/send-limits';
import type { StaffAuditCtx } from '@/lib/dashboard-ops';
import type { Partner, Staff, StaffPermissions, Transfer } from '@/lib/types';
import type { Store } from '@/lib/store';
import { isRescreenOnlyHold, ORIGINATOR_INFO_MISSING_REASON, RECIPIENT_IDENTITY_MISSING_REASON } from '@/lib/compliance-config';
import { realMoneyFor } from '@/lib/live-gate';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { identityMissingForRelease, originatorMissingForRelease } from '@/lib/release-data-checks';
import { allowedDispositions, classifyHold, dispositionReleases, isHoldClass, isHoldDisposition } from '@/lib/hold-queue';
import { holdQueueApplies, partnerDecidesKyc, reviewRecordApplies } from '@/lib/partner-decision-scope';
import { decideHold, HoldReviewChangedError, parseHoldReason, planHoldDecision } from '@/lib/hold-decision';
import { loadHoldEvidence, toHoldReviewEvidence } from '@/lib/partner-screening-view';
import type { HoldReviewEvidence } from '@/db/repos/hold-review-repo';
import { gateStaffStepUp } from '@/lib/partner-step-up-gate';
import { logWarn } from '@/lib/log';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { transferAssigneeRefusal } from '@/lib/transfer-assignable';

async function requirePermission(
  permission: keyof StaffPermissions,
): Promise<Staff> {
  const staff = await requireStaff();
  if (!hasPermission(staff, permission)) {
    throw new Error('You do not have permission to perform this action.');
  }
  return staff;
}

/**
 * Load a transfer by form-supplied id AND enforce the caller's partner scope.
 *
 * Every action below is a public POST endpoint, so page-level gating is not
 * enough: a partner-scoped staff member could `curl` it with another tenant's
 * transfer id. We resolve the transfer and reject (with a generic message, to
 * avoid disclosing the existence of out-of-scope records) before any mutation.
 * Platform staff (no partnerId) pass `canSee` for every partner; a partner-admin
 * only for their own. Closes the H1/H2 cross-tenant write holes.
 */
/**
 * Program-Fix 28: the audit context for a staff money decision. The actor is
 * the SESSION's stable username (identity, never a form field); the reason is
 * the optional `note` field, bounded (control characters stripped, 500-char
 * cut). A blank note ⇒ null. Written INSIDE the decision's transaction.
 */
function staffAudit(staff: Staff, formData: FormData): StaffAuditCtx {
  return { actor: staff.username, reason: boundStaffNote(formData.get('note')) };
}

async function getScopedTransfer(staff: Staff, id: string) {
  if (!id) throw new Error('Missing transfer id');
  const store = getStore();
  const transfer = await store.getTransfer(id);
  if (!transfer || !canSee(scopeOf(staff), transfer.partnerId)) {
    throw new Error('Transfer not found');
  }
  return { store, transfer };
}

const NOT_ALLOWED = 'You do not have permission to perform this action.';
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');
/** The rowFp the page posts: rowReasonsFp, at most 1000 characters (P4). */
const ROW_FP_MAX = 1000;

/**
 * Fix pack 7 T14a (P12, P13, D5, D6): the SmartRemit limits on a hold of a partner certified for
 * live money, run right after the scope check by both admin hold actions. Returns
 * `{ decided: false, owner }` when the caller runs today's body unchanged (an uncertified owner,
 * every tenant today, or a sandbox row, which the core exempts too), and `{ decided: true }` when
 * the decision was taken here, through decideHold with ONE platform review row. Every refusal
 * THROWS one fixed text (the actions are void) and writes nothing:
 *   a. the owner read: a throw (logged by name) or null -> the generic permission text, never
 *      "not certified" (that would reopen the platform path, P2);
 *   b. a queue owner's partner-decided class (the posted class, or any class when none was
 *      posted) -> PARTNER_DECIDES_HOLD_REFUSAL; a release of a list-wait row -> RESCREEN_ONLY;
 *   c. a missing or invalid holdClass / disposition / rowFp, a disposition the platform may not
 *      give that class, or one of the other direction -> HOLD_REVIEW_RELOAD_REFUSAL (an old tab);
 *   d. the note fails the decision reason rule (P7) -> HOLD_REASON_REFUSAL;
 *   e/f. the unlocked plan (planHoldDecision; a refusal -> platformHoldRefusal);
 *   g. the step-up 'hold.decide', ALWAYS (the void action cannot return StepUpRequired: the form
 *      sends the code with its first submit, and a refused step-up is thrown as its text);
 *   h. decideHold with expectFinal = the plan's step (the locked paths re-check everything).
 */
async function platformReviewGate(
  staff: Staff,
  store: Store,
  transfer: Transfer,
  formData: FormData,
  want: 'release' | 'reject',
): Promise<{ decided: true } | { decided: false; owner: Partner }> {
  const db = getDb();
  // a. The owner read: a failure is a refusal.
  let owner: Partner | null;
  try {
    owner = await getPartnerStore().getPartner(transfer.partnerId);
  } catch (err) {
    logWarn('admin.hold-decide.owner-read', errName(err), { transferId: transfer.id });
    owner = null;
  }
  if (!owner) throw new Error(NOT_ALLOWED);
  // b. Uncertified (every tenant today) or a sandbox row: today's body, unchanged.
  if (!reviewRecordApplies(owner) || transfer.environment === 'test') return { decided: false, owner };

  // c. Classify as the decision does: the sender flags for a real-money row (R1, fail closed to
  // null) and dataOnFile with the rail partner's integrations (O2).
  const flags = (await realMoneyFor(db, transfer)) ? await loadSenderScreening(db, transfer.partnerId, transfer.phone) : undefined;
  const reasons = transfer.complianceReasons ?? [];
  let dataOnFile = false;
  if (reasons.includes(RECIPIENT_IDENTITY_MISSING_REASON) || reasons.includes(ORIGINATOR_INFO_MISSING_REASON)) {
    const rail = await createIntegrationsRepo(db).getIntegrations(transfer.settlementPartnerId ?? transfer.partnerId);
    dataOnFile = !(await identityMissingForRelease(db, transfer, rail)) && !(await originatorMissingForRelease(db, transfer, rail));
  }
  const classes = classifyHold(
    transfer.complianceReasons,
    flags,
    { queue: holdQueueApplies(owner), partnerDecidesKyc: partnerDecidesKyc(owner) },
    { blocked: transfer.complianceStatus === 'blocked', dataOnFile },
  );
  const rawClass = formData.get('holdClass');
  const holdClass = isHoldClass(rawClass) ? rawClass : null;
  if (holdQueueApplies(owner)) {
    const partnerDecided = holdClass
      ? classes.some((c) => c.holdClass === holdClass && c.decider === 'partner')
      : classes.some((c) => c.decider === 'partner');
    if (partnerDecided) throw new Error(PARTNER_DECIDES_HOLD_REFUSAL);
  }
  if (want === 'release' && isRescreenOnlyHold(transfer)) throw new Error(RESCREEN_ONLY_RELEASE_REFUSAL);
  const disposition = formData.get('disposition');
  const rowFp = formData.get('rowFp');
  if (!holdClass || !isHoldDisposition(disposition) || typeof rowFp !== 'string' || rowFp === '' || rowFp.length > ROW_FP_MAX) {
    throw new Error(HOLD_REVIEW_RELOAD_REFUSAL);
  }
  const lists = allowedDispositions(holdClass, 'platform');
  if (![...lists.release, ...lists.reject].includes(disposition) || dispositionReleases(disposition) !== (want === 'release')) {
    throw new Error(HOLD_REVIEW_RELOAD_REFUSAL);
  }
  // d. The decision reason (P7): the note.
  const parsed = parseHoldReason(formData.get('note'));
  if (!parsed.ok) throw new Error(HOLD_REASON_REFUSAL);
  // e. The review (no queue / partnerDecidesKyc / fourEyes: the seam derives them, P9 step 1b).
  let evidence: HoldReviewEvidence;
  try {
    evidence = toHoldReviewEvidence(await loadHoldEvidence(db, owner.id, transfer));
  } catch (err) {
    logWarn('admin.hold-decide.evidence', errName(err), { transferId: transfer.id });
    evidence = {};
  }
  const review = {
    ownerId: owner.id, holdClass, rowFp, disposition, reason: parsed.reason,
    actor: staff.username, actorScope: 'platform' as const, evidence, transferId: transfer.id,
  };
  // f. The unlocked plan.
  let expectFinal: boolean;
  try {
    expectFinal = (await planHoldDecision(db, store, review)).step.final;
  } catch (err) {
    if (err instanceof HoldReviewChangedError) throw new Error(platformHoldRefusal(err.why, transfer));
    throw err;
  }
  // g. The step-up, always (P3).
  const stepUp = await gateStaffStepUp(staff, formData, 'hold.decide', { always: true });
  if (stepUp) throw new Error(stepUp.error);
  // h. The decision.
  try {
    await decideHold(db, store, { ...review, expectFinal });
  } catch (err) {
    if (err instanceof HoldReviewChangedError) throw new Error(platformHoldRefusal(err.why, transfer));
    throw err;
  }
  return { decided: true };
}

export async function cancelTransferAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePermission('canCancel');
  const id = String(formData.get('id') ?? '');
  const { store } = await getScopedTransfer(staff, id);
  await cancelTransfer(store, id);
  // 'layout' revalidates every page under /admin-dashboard (transactions, schedules,
  // compliance, etc.), not just the root — so the change shows up wherever the
  // viewer happens to be.
  revalidatePath('/admin-dashboard', 'layout');
}

// Lost-features restore p1 A2: the copy for each transferAssigneeRefusal (unchanged wording).
const ASSIGN_REFUSAL = {
  unknown: 'Cannot assign: unknown staff member.',
  scope: 'Cannot assign: staff member is outside this transfer’s scope.',
  inactive: 'Cannot assign: staff member is inactive.',
  role: 'Cannot assign: staff member cannot work transfers.',
} as const;

export async function assignTransferAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePermission('canAssign');
  const id = String(formData.get('id') ?? '');
  const assignee = String(formData.get('assignee') ?? '');
  const { transfer } = await getScopedTransfer(staff, id);
  // The ONE transfer assignee rule (transfer-assignable.ts): a real, active account that can see
  // this transfer's tenant and whose role works transfers (admin or agent: support cannot open a
  // transfer, finance is /partner-only), so an assignment is never a dead end.
  const refusal = transferAssigneeRefusal(await getAuthStore().getStaff(assignee), transfer.partnerId);
  if (refusal) throw new Error(ASSIGN_REFUSAL[refusal]);
  // The note lives only in the transfer.assign audit row (bounded); adminNote is never written.
  await assignTransfer(getDb(), id, assignee, { actor: staff.username, note: boundStaffNote(formData.get('note')), actorScope: 'platform' });
  revalidatePath('/admin-dashboard', 'layout');
}

export async function resendPaymentLinkAction(
  formData: FormData,
): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePermission('canResend');
  const id = String(formData.get('id') ?? '');
  const { store } = await getScopedTransfer(staff, id);
  // Program-Fix 49A: refused when the customer opted out (nonessential).
  await resendPaymentLink(store, sendText, id, getCustomerStore(store));
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Release a held (in_review) transfer — a SETTLEMENT (releaseHold: in_review →
 * paid + the rail effect, one transaction), not a delivery flip.
 * Requires admin role (high-stakes compliance decision) AND partner scope:
 *   (a) requireAdmin — only staff with role:'admin'
 *   (b) getScopedTransfer — the transfer must be in the caller's scope (H2 fix:
 *       a partner-admin can no longer release another tenant's held transfer)
 *   (c) canReleaseHeld — a hold flagged by SmartRemit's own screening (owning
 *       partner kycMode 'ours') needs PLATFORM staff (owner decision 2026-09-16),
 *       and a sanctions / name-screening hold is PLATFORM-only in every KYC
 *       mode (Program-Fix 43 follow-up); a PARTNER-scoped admin follows the
 *       /partner allowlist incl. the sender PEP / watchlist check (M3-10 Task 10.3)
 *   (d) a non-blank release reason (the bounded `note`) is REQUIRED
 *   (e) releaseTransfer re-verifies status === 'in_review'
 */
export async function releaseTransferAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const { store, transfer } = await getScopedTransfer(staff, id);
  // Fix pack 7 T14a (P12): a certified owner's hold moves only with a recorded platform review.
  const gated = await platformReviewGate(staff, store, transfer, formData, 'release');
  if (gated.decided) {
    revalidatePath('/admin-dashboard', 'layout');
    return;
  }
  // Owner decision (2026-09-16): a hold SmartRemit's own screening flagged
  // (kycMode 'ours') is released by PLATFORM staff only — refused BEFORE any
  // mutation, with the same generic permission copy as the other actions.
  // Program-Fix 43 follow-up: a hold raised by sanctions / name screening is
  // PLATFORM-only even for a 'delegated' partner (canReleaseHeld keys on
  // isScreeningHold over the transfer's stored reasons).
  // UI redesign M3-10 Task 10.3 / O8: a PARTNER-scoped admin follows the /partner rule
  // (isPartnerReleasableHold: allowlisted reasons only, and the SENDER customer row, read in the
  // owning tenant, must exist with no PEP / watchlist hit). The lookup runs for partner scope only
  // and never throws (a miss or failure ⇒ null ⇒ refused); platform staff are unchanged.
  // (The owner was read once, by the gate above.)
  const owner = gated.owner;
  const scope = scopeOf(staff);
  const sender = scope.kind === 'partner' ? await loadSenderScreening(getDb(), transfer.partnerId, transfer.phone) : null;
  if (!canReleaseHeld(scope, owner, transfer, sender)) {
    throw new Error('You do not have permission to perform this action.');
  }
  // Program-Fix 43 follow-up: every release records WHO (the session actor)
  // and WHY — the bounded note is MANDATORY here (blank after bounding ⇒
  // refused before any mutation, platform staff included).
  const audit = staffAudit(staff, formData);
  if (audit.reason === null) {
    throw new Error('A release reason is required. Add a note explaining why this hold is being released.');
  }
  // M3-10 follow-up: a PARTNER-scoped release re-checks the sender flags inside the guarded claim
  // (the staff tenant, which canSee made equal to the owning tenant above); platform staff pass nothing (unchanged).
  await releaseTransfer(store, getDb(), id, audit, scope.kind === 'partner' ? { partnerId: scope.partnerId } : undefined);
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Reject a held (in_review) transfer — cancels it with an adminNote, and
 * AUTO-refunds the captured charge when the sender was charged (fundingRef
 * set): refund pending + a durable funding.refund effect, drained by the
 * worker. Requires admin role + partner scope (see releaseTransferAction).
 */
export async function rejectTransferAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const { store, transfer } = await getScopedTransfer(staff, id);
  // Fix pack 7 T14a (P12): a certified owner's hold moves only with a recorded platform review.
  // An uncertified owner: one owner read more (DP11), then today's body.
  if ((await platformReviewGate(staff, store, transfer, formData, 'reject')).decided) {
    revalidatePath('/admin-dashboard', 'layout');
    return;
  }
  await rejectTransfer(store, getDb(), id, staffAudit(staff, formData));
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Fix pack 7 T14a (P12, P28, P29): ask a queue partner (holdDecider 'partner', certified) to decide
 * a held transfer: one `transfer.hold.escalate` audit row and one email to its compliance address
 * (deduped per transfer per UTC day; no address -> the audit only). Changes no state. Platform
 * admins only; the transfer must be in scope.
 */
export async function escalateHoldAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requirePlatformAdmin();
  const id = String(formData.get('id') ?? '');
  await getScopedTransfer(staff, id);
  const r = await escalateHold(getDb(), id, staff.username);
  if (r === 'not_queue') throw new Error(ESCALATE_NOT_QUEUE_REFUSAL);
  if (r === 'not_held') throw new Error(ESCALATE_NOT_HELD_REFUSAL);
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * PROACTIVELY issue a refund on a paid/delivered, charged transfer (none →
 * pending + funding.refund effect + worker poke) — no prior customer request
 * needed. Admin role + partner scope, like the other refund actions; issueRefund
 * re-verifies status + fundingRef + refundStatus inside the transaction, so an
 * ineligible transfer or a double-click throws instead of moving money twice.
 */
export async function issueRefundAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  await getScopedTransfer(staff, id);
  await issueRefund(getDb(), id, staffAudit(staff, formData));
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Approve a CUSTOMER-REQUESTED refund (requested → pending + funding.refund
 * effect + worker poke). Admin role + partner scope, like release/reject;
 * approveRefund re-verifies refundStatus === 'requested' inside the
 * transaction, so replays and double-clicks throw instead of double-enqueuing.
 */
export async function approveRefundAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  await getScopedTransfer(staff, id);
  await approveRefund(getDb(), id, staffAudit(staff, formData));
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Dismiss a CUSTOMER-REQUESTED refund (requested → none, adminNote trail).
 * Admin role + partner scope; the guarded transition (legal only from
 * 'requested') makes wrong-state calls throw without mutating.
 */
export async function dismissRefundAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  await getScopedTransfer(staff, id);
  await dismissRefund(getDb(), id, staffAudit(staff, formData));
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Retry a FAILED refund (failed → pending + a FRESH-keyed funding.refund
 * effect — the original dedupe key is spent — + worker poke). Admin role +
 * partner scope; retryRefund re-verifies refundStatus === 'failed'.
 */
export async function retryRefundAction(formData: FormData): Promise<void> {
  await refuseOnSiteHost();
  const staff = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  await getScopedTransfer(staff, id);
  await retryRefund(getDb(), id, staffAudit(staff, formData));
  revalidatePath('/admin-dashboard', 'layout');
}

/**
 * Reveal the FULL payout destination of one transfer (Stage 3 audited reveal).
 * List reads are masked at the repo layer (****last4), so this action is the
 * ONLY path from a staff view to the decrypted value — self-gated (staff
 * session + canRevealPii + partner scope) and every call writes an append-only audit_events
 * row. The decrypted value is returned to the caller, never logged.
 */
export async function revealDestinationAction(
  transferId: string,
): Promise<{ destination: string } | { error: string }> {
  await refuseOnSiteHost();
  const staff = await requireStaff();
  // Program-Fix 45 P1 (authz-06): revealing needs canRevealPii (admins pass
  // through hasPermission's bypass; support never reveals). Checked BEFORE any
  // read or decrypt, and refused with the same shape as a missing or
  // out-of-scope transfer. It returns rather than throws, so
  // masked-destination.tsx shows its "Reveal failed" state.
  if (staff.role === 'support' || !hasPermission(staff, 'canRevealPii')) {
    return { error: 'Transfer not found' };
  }
  try {
    const { store, transfer } = await getScopedTransfer(staff, transferId);
    const full = await store.getTransferDecrypted(transferId);
    if (!full) return { error: 'Transfer not found' };
    await createAuditRepo(getDb()).record({
      partnerId: transfer.partnerId,
      actor: staff.username,
      actorType: 'staff',
      action: 'pii.reveal',
      subjectId: transferId,
      meta: { field: 'payout_destination' },
    });
    return { destination: full.payoutDestination };
  } catch {
    // Out-of-scope reads collapse to the same generic shape as missing ones.
    return { error: 'Transfer not found' };
  }
}
