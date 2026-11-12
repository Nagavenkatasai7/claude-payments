import { suppressForOptOut, type OptOutLookup } from './consent-gate';
import { env } from './env';
import { isPartnerPulled } from './funding-method';
import { CANCEL_REFUSAL, decideStaffCancel } from './dashboard-cancel-policy';
import { pokeWorker } from './outbox';
import { payUrlFor } from './pay-url';
import { paylinkDedupeKey, resendEligibility } from './partner-transfer-ops';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { isSandbox, releaseHold, releaseHoldAfterRescreen, recordStaffTransferAudit, type StaffAuditCtx } from './settlement';
import { buildRejectContactMessage } from './payment';
import { SANCTIONS_FUNDS_RULE } from './sanctions/notices';
export type { StaffAuditCtx } from './settlement';
import type { Db, DbOrTx } from '@/db/client';
import type { Store } from './store';
import type { Scope } from './staff-scope';
import type { Partner, PartnerId, Transfer } from './types';
import {
  isPartnerReleasableHold, isRescreenOnlyHold, RECIPIENT_IDENTITY_MISSING_REASON, senderScreeningHoldActive, type CustomerScreeningFlags,
} from './compliance-config';
import { partnerMayRejectHold } from './partner-reviews';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { sanctionsNoticeAddress } from './sanctions/notices';
import { realMoneyFor, realMoneyRail } from './live-gate';
import { CARD_REFUND_UNAVAILABLE, cardRefundUnavailableFor, collectedOnRealMoneyFor } from './funding-class';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { listScreenEvidence, liveFresh } from './sanctions/evidence-read';
import { warmSanctionsList } from './providers/sanctions-provider';
import { screenHeldOnFile } from './list-hold-rescreen';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import {
  allowedDispositions, classifyHold, hasSanctionsHold, openHoldClasses, rowReasonsFp, type ClassifiedClass, type DecisionRefusal,
  type HoldClass, type HoldDisposition, type ReviewRowLite,
} from './hold-queue';
import { holdQueueApplies, partnerDecidesKyc, reviewRecordApplies, type ScopeOwner } from './partner-decision-scope';
import { HoldReviewChangedError, insertReview, lockAndRouteReview, readSenderFlagsLocked, type HoldReviewInput } from './hold-review-tx';
import { enqueueHoldDispositionIfEligible } from './partner-events';
import { logWarn } from './log';

/**
 * Fix pack 2 T4 (R02): the refusal for a hold waiting on a fresh sanctions list
 * (LIST_UNAVAILABLE). Only the automatic re-screen (list-hold-rescreen.ts)
 * releases it; Reject is unchanged.
 */
export const RESCREEN_ONLY_RELEASE_REFUSAL =
  'Cannot release: this hold lifts only by an automatic re-screen against a fresh sanctions list.';

/**
 * Fix pack 2 T6 (R06): the platform release refusal while the sender's
 * screening hold is active on a real-money rail (contracts section 8).
 */
export const SENDER_SCREENING_RELEASE_REFUSAL = 'Cannot release: clear the sender screening hold first.';

/**
 * Fix pack 4 (R03, C19): the release refusal (partner and platform staff
 * alike) for a real-money consumer row with no account-holder name on file,
 * whatever reason it is held for. Until a capture path for a held row exists
 * (PR7) such a row can only be rejected or refunded.
 */
export const RECIPIENT_IDENTITY_RELEASE_REFUSAL = 'This transfer cannot be released: the account holder name is missing. Reject or refund it.';

/**
 * Fix pack 5 (R38, P22): the release refusal (partner and platform staff
 * alike) for a real-money row whose sender's travel-rule data (the address,
 * or the date of birth by band) is not on file, or that is routed to another
 * tenant's rail, whatever reason it is held for. Until a capture path for a
 * held row exists (PR7) such a row can only be rejected or refunded.
 */
export const ORIGINATOR_INFO_RELEASE_REFUSAL =
  "This transfer cannot be released: the sender's address or date of birth is missing. Reject or refund it.";

/**
 * Pack 2 review F1 (A1): the refusal when a real-money release re-screened the
 * hold (its newest screen was not live and fresh) and the re-screen did not
 * clear it. Review R2 (J2): this is the PARTNER staff text, ONE for every
 * outcome (a list outage, a possible match, an uncovered name, a match): no
 * name, no match detail, so partner staff cannot tell them apart from it.
 */
export const RESCREEN_RELEASE_REFUSAL =
  'Cannot release: the sanctions re-screen at release did not clear this transfer.';

/**
 * Review R2 (J2): the same refusal for PLATFORM staff, one text per outcome
 * class, saying what to do next; none names a person or a list entry.
 *   • listNotLive: the row now waits on LIST_UNAVAILABLE (a person's click is
 *     refused). The automatic list re-screen screens it again once the list is
 *     live, but the row keeps the reason it was held for (it reached a person's
 *     release), so it returns to the review queue for a platform release
 *     (review round 3, K2).
 *   • review: a possible match or a name that could not be screened again
 *     added a review reason. The row is never released automatically; a
 *     second platform click (after reading the reasons) is the human review
 *     and releases it on the ordinary claim.
 *   • blocked: a match; the transfer is blocked and never released.
 */
export const PLATFORM_RESCREEN_REFUSALS = {
  listNotLive:
    'Cannot release: the sanctions list is not live, so the re-screen at release could not clear this transfer. ' +
    'The system re-screens it automatically once the list is live again; it then returns to the review queue for a platform release.',
  review:
    'Cannot release yet: the sanctions re-screen at release added a review reason. ' +
    'Read the reasons on the compliance page, and release again only after that review.',
  blocked: 'Cannot release: the sanctions re-screen at release blocked this transfer.',
} as const;

/**
 * Fix pack 7 (P12, P9 rule D6): the platform refusals on a partner certified
 * for live money. A queue partner (posture holdDecider 'partner') decides its
 * partner-decided classes itself; every other decision on a certified partner
 * needs a recorded review with a disposition (an old tab posts none).
 */
export const PARTNER_DECIDES_HOLD_REFUSAL = 'The partner decides this hold: pause or escalate.';
export const HOLD_REVIEW_RELOAD_REFUSAL =
  'This partner needs a recorded decision with a disposition: reload the page and decide again.';
export const HOLD_CHANGED_REFUSAL = 'This hold changed since the page loaded: reload the page and decide again.';
/** Fix pack 7 T14a (P7, P12): the platform decision reason rule (parseHoldReason) refused the note. */
export const HOLD_REASON_REFUSAL = 'Add a reason of at least 10 characters, with no account or phone numbers.';
/** Fix pack 7 T14a (P12): the escalate refusals. */
export const ESCALATE_NOT_QUEUE_REFUSAL = 'Escalate applies only to a partner that decides its own holds.';
export const ESCALATE_NOT_HELD_REFUSAL = 'This transfer is no longer held.';

/** The partner release refusal when the row or its sender changed (the partner actions map it to notAllowed). */
const PARTNER_RELEASE_CHANGED = 'Cannot release: transfer is not in_review or its sender is not releasable (it changed concurrently)';
/** The partner reject refusal when the row or its sender changed (the partner actions map it to notAllowed). */
const PARTNER_REJECT_CHANGED = 'Cannot reject: transfer is not in_review or its sender is not rejectable (it changed concurrently)';

/**
 * Staff "Cancel" = VOID an UNFUNDED draft, and nothing else (Phase 1 Task 5 /
 * Program-Fix 9 / money-05). NON-CUSTODIAL: this function commits NO effect
 * (no refund, no reversal, no rail message), so it may only flip a row with no
 * money behind it. The rule is the pure decideStaffCancel
 * (dashboard-cancel-policy), shared with the transactions list and the B2B page:
 *   • delivered / cancelled → silent no-op (a second click is never an error),
 *   • paid → refused: custodial → Refund (issueRefund), partner-pulled → Reverse,
 *   • ANY in_review hold, charged or not → refused: a hold is a compliance
 *     decision, so Reject (admin; cancel-only when uncharged, cancel +
 *     auto-refund when charged, one txn) or Release (admin),
 *   • charged awaiting_payment → refused: the funding-resume sweep settles or holds it,
 *   • blocked → refused (terminal compliance state),
 *   • otherwise (an unfunded awaiting_payment draft) → ONE guarded UPDATE
 *     (store.cancelTransferIfUnfunded → transfer-repo.cancelIfCancellable).
 *     The read above is advisory; the UPDATE is the claim. A miss means the
 *     row moved (paid flip, hold, capture, or a concurrent click): refuse
 *     from the FRESH row, and never fall back to a write.
 * Why refuse instead of flipping: a cancelled row is invisible to every safety
 * net. updateTransferFromWebhook refuses it, findStuckPaid skips it, and
 * issueRefund rejects it. A charged transfer cancelled here used to strand the
 * sender's money, with reconcile's cancelcharged:<id> alert as the only trace.
 */
export async function cancelTransfer(store: Store, id: string): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  const decision = decideStaffCancel(transfer);
  if (decision.kind === 'noop') return;
  if (decision.kind === 'refuse') throw new Error(decision.reason);
  // Tenant-scoped claim: the row's own partner (the action already enforced the
  // caller's scope via getScopedTransfer / platform scope before calling here).
  if (await store.cancelTransferIfUnfunded(id, transfer.partnerId)) return;
  const fresh = await store.getTransfer(id);
  const again = fresh ? decideStaffCancel(fresh) : null;
  throw new Error(again?.kind === 'refuse' ? again.reason : CANCEL_REFUSAL.changed);
}

/**
 * The /partner Cancel (lost-features restore p1 A1): the SAME rule and the SAME guarded claim as
 * cancelTransfer above (decideStaffCancel, then transfer-repo.cancelIfCancellable), read inside the
 * caller's tenant, plus ONE `transfer.cancel` audit row (the staff reason in its meta) in the same
 * transaction as the flip. No money moves, no effect is queued. A no-op (already cancelled or
 * delivered) writes nothing; a refusal or a lost race throws the policy copy and writes nothing.
 */
export async function cancelOwnedTransfer(
  db: Db,
  id: string,
  o: { partnerId: PartnerId; audit: StaffAuditCtx },
): Promise<'cancelled' | 'noop'> {
  return db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await repo.getOwnedTransfer(o.partnerId, id);
    if (!transfer) {
      throw new Error('Transfer not found');
    }
    const decision = decideStaffCancel(transfer);
    if (decision.kind === 'noop') return 'noop';
    if (decision.kind === 'refuse') throw new Error(decision.reason);
    const cancelled = await repo.cancelIfCancellable(id, o.partnerId);
    if (!cancelled) {
      const fresh = await repo.getOwnedTransfer(o.partnerId, id);
      const again = fresh ? decideStaffCancel(fresh) : null;
      throw new Error(again?.kind === 'refuse' ? again.reason : CANCEL_REFUSAL.changed);
    }
    await recordStaffTransferAudit(tx, o.audit, 'transfer.cancel', cancelled, {
      previousStatus: transfer.status,
      newStatus: 'cancelled',
    });
    return 'cancelled';
  });
}

/**
 * Reverse a PAID/DELIVERED B2B ach_pull transfer (staff-approved). NON-CUSTODIAL:
 * SmartRemit captured nothing — so unlike issueRefund this does NOT require a
 * fundingRef. It flips refundStatus none → pending and enqueues the durable
 * funding.refund effect IN ONE TRANSACTION; the worker's ach_pull branch turns
 * that into a SIGNED partner REVERSE instruction (not a PSP refund). Eligibility
 * is re-checked inside the txn so a double-click / wrong state throws and
 * enqueues nothing, and the fresh-row assert prevents a flip with no effect to
 * drain. The staff click IS the approval (the buyer's request_refund only flips
 * none → requested; a human runs this).
 */
export async function reverseB2bSettlement(db: Db, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    // Fix pack 7 F2 (early review EE1): the row is read FOR UPDATE, so the checks below and the
    // none -> pending flip see one locked row (lock order transfer -> customer, as rejectTransfer).
    const transfer = await repo.getTransferForUpdate(id);
    if (!transfer) {
      throw new Error('Cannot reverse: transfer not found.');
    }
    if (!isPartnerPulled(transfer.fundingMethod)) {
      throw new Error('Cannot reverse: only partner-pulled (ACH/bank) transfers are reversed — use Refund.');
    }
    if (transfer.status !== 'paid' && transfer.status !== 'delivered') {
      throw new Error(
        `Cannot reverse: transfer is ${transfer.status} — only paid or delivered partner-pulled transfers can be reversed.`,
      );
    }
    if ((transfer.refundStatus ?? 'none') !== 'none') {
      throw new Error('Cannot reverse: a reversal is already in progress or complete for this transfer.');
    }
    // Fix pack 7 F2 (P14 "Refund back doors", D7): the B2B Reverse is a refund path too. On real
    // money a sanctions-held row keeps its funds (REFUND_SANCTIONS_REFUSAL, thrown BEFORE the flip:
    // refund stays 'none', no funding.refund); the partner returns them on its own rail and staff
    // record it outside SmartRemit (P26). Not real money (mock, simulator, sandbox): one rail read,
    // then today's path with no further read.
    await refundHoldGuard(tx, transfer, await realMoneyFor(tx, transfer));
    await repo.updateRefund(id, { refundStatus: 'pending' });
    const fresh = await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}` },
    );
    if (!fresh) {
      throw new Error('Cannot reverse: a reversal effect already exists for this transfer.');
    }
  });
  pokeWorker();
}

/**
 * Assign (or, with null, unassign) a transfer: the ONE core for both dashboards (lost-features
 * restore p1 A2). One transaction: the read (inside `scope`'s tenant when given, so a foreign id is
 * not found), the compare-and-set on assigned_to from the value just read (assignIfUnchanged: it
 * never writes adminNote, which also holds rail-failure notes, and never status), then ONE
 * `transfer.assign` audit row (assignee, previous assignee, the optional note). The same assignee
 * again is a no-op with no audit row. A lost race throws "changed concurrently" and writes nothing.
 * The caller validates the assignee (transfer-assignable.ts) before calling.
 */
export async function assignTransfer(
  db: Db,
  id: string,
  assignee: string | null,
  audit: StaffAuditCtx & { note?: string | null },
  scope?: { partnerId: PartnerId },
): Promise<'assigned' | 'unchanged'> {
  return db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = scope ? await repo.getOwnedTransfer(scope.partnerId, id) : await repo.getTransfer(id);
    if (!transfer) {
      throw new Error('Transfer not found');
    }
    const previous = transfer.assignedTo ?? null;
    if (previous === assignee) return 'unchanged';
    const assigned = await repo.assignIfUnchanged(id, { partnerId: transfer.partnerId, from: previous, to: assignee });
    if (!assigned) {
      throw new Error('Cannot assign: the transfer changed concurrently — reload and try again.');
    }
    await recordStaffTransferAudit(tx, { actor: audit.actor, reason: audit.reason ?? null, actorScope: audit.actorScope }, 'transfer.assign', assigned, {
      assignee,
      previousAssignee: previous,
      note: audit.note ?? null,
    });
    return 'assigned';
  });
}

/**
 * Program-Fix 49A: a pay-link resend is NONESSENTIAL — refused, with a
 * staff-readable reason, when the customer opted out (STOP) under the
 * transfer's own tenant. `consent` is injected (the action passes the
 * customer store) so the check runs on the caller's database.
 */
export async function resendPaymentLink(
  store: Store,
  sendText: (to: string, text: string) => Promise<unknown>, // fix pack 4 (C5): the channel it resolves is ignored
  id: string,
  consent?: OptOutLookup,
): Promise<void> {
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  // Program-Fix 44 P2: a sandbox (test-key) transfer is never payable on the
  // hosted page and must never message a real phone. Refused before any read
  // of consent and before any send.
  if (transfer.environment === 'test') {
    throw new Error('Sandbox transfers have no payment link.');
  }
  if (consent && (await suppressForOptOut(consent, transfer.partnerId, transfer.phone, 'nonessential'))) {
    throw new Error('Cannot resend: this customer has opted out of WhatsApp messages (replied STOP).');
  }
  const url = `${env.appBaseUrl}/pay/${id}`;
  await sendText(transfer.phone, `Here is your secure payment link again: ${url}`);
}

/**
 * Lost-features restore p1 A3: resend the pay link through the OUTBOX (every external effect is an
 * outbox row). One transaction: the tenant-scoped read, the eligibility (a live, unpaid transfer
 * with no money in flight), ONE `whatsapp.text` row (the existing kind and shape: the worker sends
 * it on the OWNING partner's number, re-checks the opt-out at send time and skips a sandbox row),
 * deduped per transfer per 10 minutes, and ONE `transfer.paylink.resend` audit row (no phone, no
 * URL). A dedupe hit throws and rolls back, so a second click inside the bucket writes nothing.
 * The caller pre-checks the opt-out and the 24-hour window so staff get a clear reason.
 */
export async function queuePaymentLinkResend(
  db: Db,
  id: string,
  o: { partnerId: PartnerId; audit: StaffAuditCtx; nowMs: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    const transfer = await createTransferRepo(tx).getOwnedTransfer(o.partnerId, id);
    if (!transfer) {
      throw new Error('Transfer not found');
    }
    if (resendEligibility(transfer) !== 'ok') {
      throw new Error('Cannot resend: only an unpaid live transfer has a payment link to resend.');
    }
    const fresh = await createOutboxRepo(tx).enqueue(
      'whatsapp.text',
      {
        to: transfer.phone,
        body: `${PAYLINK_RESEND_TEXT} ${payUrlFor(transfer.id)}`,
        partnerId: transfer.partnerId,
        category: 'nonessential',
      },
      { dedupeKey: paylinkDedupeKey(transfer.id, o.nowMs) },
    );
    if (!fresh) {
      throw new Error(PAYLINK_RECENT);
    }
    await recordStaffTransferAudit(tx, o.audit, 'transfer.paylink.resend', transfer, {});
  });
  pokeWorker();
}

/** The customer-facing resend copy (unchanged from the legacy inline send). */
const PAYLINK_RESEND_TEXT = 'Here is your secure payment link again:';
export const PAYLINK_RECENT = 'Cannot resend: the payment link was resent in the last 10 minutes.';

/**
 * WHO may release a compliance hold. OWNER DECISION (2026-09-16): releasing a
 * transfer that SmartRemit's OWN screening flagged — owning partner kycMode
 * 'ours', which is also the default when kycMode is unset — requires PLATFORM
 * staff. A missing partner row fails CLOSED for partner-scoped staff.
 * Program-Fix 43 follow-up: even under 'delegated', a hold whose reasons came
 * from sanctions / name screening (isScreeningHold — KYC may be delegated,
 * sanctions may not) stays PLATFORM-only; a hold with no reasons fails closed.
 * UI redesign M3-10 Task 10.3 / O8: a PARTNER-scoped admin follows exactly the
 * /partner rule, isPartnerReleasableHold — a delegated partner's in_review,
 * non-blocked hold whose EVERY reason is in PARTNER_RELEASABLE_REASONS (so the
 * AML hold and any unknown reason are refused), and whose SENDER customer row
 * (`sender`, read in the owning tenant) exists with no PEP / watchlist hit and
 * (fix pack 2 review F2) no uncleared screening stamp.
 * PLATFORM staff are unchanged: `sender` is ignored for them.
 * Sanctions-blocked rows stay unreleasable for everyone regardless of this
 * (markPaidIfInReview carries compliance_status <> 'blocked').
 * Fix pack 2 T4 (R02): a hold the registry marks 'rescreen' (LIST_UNAVAILABLE:
 * screened while the sanctions list was not live) is released by NO person,
 * platform staff included: only the automatic re-screen on a fresh list
 * (list-hold-rescreen.ts) lifts it. That check comes first.
 * Pure: the server actions (authoritative gate) and the compliance page (which
 * hides the Release button) all call it, so the UI can never drift from it.
 */
export function canReleaseHeld(
  scope: Scope,
  owner: HoldOwner,
  transfer: Pick<Transfer, 'status' | 'complianceStatus' | 'complianceReasons'>,
  sender: CustomerScreeningFlags | null | undefined,
): boolean {
  if (isRescreenOnlyHold(transfer)) return false;
  if (scope.kind === 'platform') {
    // Fix pack 7 T14a (P12): a queue partner decides its partner-decided classes itself. The sender
    // flags are not read here (null: the sender classes read as platform watchlist, conservative);
    // the action re-checks with the flags.
    return !queueClasses(owner, transfer, null)?.some((c) => c.decider === 'partner');
  }
  return isPartnerReleasableHold(transfer, owner, sender);
}

/**
 * Fix pack 7 T14a (P12): the owner shape canReleaseHeld / canRejectHeld take (a full Partner row
 * fits). A `{ kycMode }`, `{}` or null owner (no id, status or liveControls) is never certified, so
 * it keeps today's answers. `status` is a plain string, like compliance-config's LegacyHoldOwner.
 */
export type HoldOwner =
  | { kycMode?: Partner['kycMode']; id?: string; status?: string; liveControls?: Partner['liveControls'] }
  | null
  | undefined;

/** The classes of a queue owner's row (null for every other owner). Pure. */
function queueClasses(
  owner: HoldOwner,
  transfer: Pick<Transfer, 'complianceStatus' | 'complianceReasons'>,
  sender: CustomerScreeningFlags | null | undefined,
) {
  const o = owner as ScopeOwner | null | undefined;
  if (!holdQueueApplies(o)) return null;
  return classifyHold(transfer.complianceReasons, sender, { queue: true, partnerDecidesKyc: partnerDecidesKyc(o) }, {
    blocked: transfer.complianceStatus === 'blocked',
  });
}

/**
 * Fix pack 7 T14a (P12): WHO may reject a held transfer. Platform staff: always, except on a queue
 * partner whose classes are ALL partner-decided (the partner decides them; SmartRemit pauses or
 * escalates). `sender`: the flags the caller read (undefined = not read; null = the read failed,
 * which adds a platform sender class, fail closed). Partner staff: partnerMayRejectHold (unchanged).
 * Pure.
 */
export function canRejectHeld(
  scope: Scope,
  owner: HoldOwner,
  transfer: Pick<Transfer, 'status' | 'complianceStatus' | 'complianceReasons'>,
  sender: CustomerScreeningFlags | null | undefined,
): boolean {
  if (scope.kind !== 'platform') return partnerMayRejectHold(transfer, owner, sender);
  const classes = queueClasses(owner, transfer, sender);
  return !classes || !classes.every((c) => c.decider === 'partner');
}

/**
 * Fix pack 7 T14a (P12): a HoldReviewChangedError's `why` as the ONE fixed platform text. No
 * sanctions detail beyond the existing texts.
 */
export function platformHoldRefusal(why: DecisionRefusal | 'changed', t: Pick<Transfer, 'complianceReasons'>): string {
  switch (why) {
    case 'not_yours':
    case 'waits_platform':
      return PARTNER_DECIDES_HOLD_REFUSAL;
    case 'waits_list':
      return RESCREEN_ONLY_RELEASE_REFUSAL;
    case 'waits_data':
      return (t.complianceReasons ?? []).includes(RECIPIENT_IDENTITY_MISSING_REASON)
        ? RECIPIENT_IDENTITY_RELEASE_REFUSAL
        : ORIGINATOR_INFO_RELEASE_REFUSAL;
    case 'blocked':
      return PLATFORM_RESCREEN_REFUSALS.blocked;
    default:
      return HOLD_CHANGED_REFUSAL;
  }
}

/** Fix pack 7 T14a (P12): one platform decision form of one open class. */
export interface PlatformHoldForm {
  holdClass: HoldClass;
  release: readonly HoldDisposition[];
  reject: readonly HoldDisposition[];
}
export type PlatformHoldControls =
  | { mode: 'legacy' }
  | { mode: 'review'; rowFp: string; forms: PlatformHoldForm[]; partnerDecides: boolean; escalate: boolean; waitsList: boolean };

/**
 * Fix pack 7 T14a (P12, C3, R1, M11): what the admin compliance page renders for one held row.
 * Legacy (today's Release / Reject) for every owner that is not certified. For a certified owner:
 * one form per OPEN class (openHoldClasses) the platform decides (a queue owner: the platform
 * classes; a delegated owner: every partner or platform class), plus a present data_missing class
 * (reject `data_not_provided`; release `data_received` only when `dataOnFile`) and a present blocked
 * class (reject `confirmed_match`) although no class decider owns them. While a list_wait class is
 * present only Reject lists are offered (P5 rule 3); a blocked class or a data_missing class whose
 * data is not on file also empties the Release lists (P5 rules 2, 4). A form with two empty lists
 * is dropped. `sender`: the flags the caller read for a real-money row (R1: a later stamp is a
 * synthetic platform sender class); `dataOnFile`: settlement's release data checks on the row.
 * `partnerDecides` / `escalate`: a queue owner with an open partner class. Pure.
 */
export function platformHoldControls(
  owner: HoldOwner,
  t: Pick<Transfer, 'complianceStatus' | 'complianceReasons'>,
  sender: CustomerScreeningFlags | null | undefined,
  reviews: readonly ReviewRowLite[],
  o: { dataOnFile?: boolean } = {},
): PlatformHoldControls {
  const so = owner as ScopeOwner | null | undefined;
  if (!reviewRecordApplies(so)) return { mode: 'legacy' };
  const queue = holdQueueApplies(so);
  const dataOnFile = o.dataOnFile === true;
  const classes = classifyHold(t.complianceReasons, sender, { queue, partnerDecidesKyc: partnerDecidesKyc(so) }, {
    blocked: t.complianceStatus === 'blocked',
    dataOnFile,
  });
  const open = openHoldClasses(classes, reviews, sender);
  const waitsList = classes.some((c) => c.holdClass === 'list_wait');
  const noRelease =
    waitsList || classes.some((c) => c.holdClass === 'blocked' || (c.holdClass === 'data_missing' && c.decider === 'nobody'));
  const forms: PlatformHoldForm[] = [];
  for (const c of open) {
    const ours =
      c.decider === 'platform' ||
      (!queue && c.decider === 'partner') ||
      c.holdClass === 'data_missing' ||
      c.holdClass === 'blocked' ||
      c.holdClass === 'list_wait';
    if (!ours) continue;
    const lists = allowedDispositions(c.holdClass, 'platform');
    const release = noRelease || (c.holdClass === 'data_missing' && !dataOnFile) ? [] : lists.release;
    if (release.length === 0 && lists.reject.length === 0) continue;
    forms.push({ holdClass: c.holdClass, release, reject: lists.reject });
  }
  const partnerDecides = queue && open.some((c) => c.decider === 'partner');
  return { mode: 'review', rowFp: rowReasonsFp(t.complianceReasons), forms, partnerDecides, escalate: partnerDecides, waitsList };
}

/**
 * Fix pack 7 T14a (P12, P28, P29): SmartRemit asks a queue partner to decide a held transfer. ONE
 * transaction: the locked row (not in_review -> 'not_held'), the owner (null or not
 * holdQueueApplies -> 'not_queue'), the classes (with the sender flags for a real-money row, R1),
 * ONE `transfer.hold.escalate` audit row (meta: the class names and actorScope, nothing else) and,
 * when the partner has a compliance address, ONE `email.send` deduped per transfer per UTC day.
 * Changes no state. Pokes after the commit.
 */
export async function escalateHold(db: Db, id: string, actor: string): Promise<'ok' | 'not_queue' | 'not_held'> {
  const r = await db.transaction(async (tx): Promise<'ok' | 'not_queue' | 'not_held'> => {
    const t = await createTransferRepo(tx).getTransferForUpdate(id);
    if (!t || t.status !== 'in_review') return 'not_held';
    const owner = await createPartnerRepo(tx).getPartner(t.partnerId);
    if (!owner || !holdQueueApplies(owner)) return 'not_queue';
    const flags = (await realMoneyFor(tx, t)) ? await readSenderScreeningFlags(tx, t.partnerId, t.phone) : undefined;
    const holdClasses = classifyHold(t.complianceReasons, flags, { queue: true, partnerDecidesKyc: partnerDecidesKyc(owner) }, {
      blocked: t.complianceStatus === 'blocked',
    }).map((c) => c.holdClass);
    await createAuditRepo(tx).record({
      partnerId: t.partnerId,
      actor,
      actorType: 'staff',
      action: 'transfer.hold.escalate',
      subjectId: t.id,
      meta: { holdClasses, actorScope: 'platform' },
    });
    const addr = sanctionsNoticeAddress(owner.supportConfig);
    if (addr) {
      await createOutboxRepo(tx).enqueue(
        'email.send',
        {
          to: [addr],
          subject: 'SmartRemit: a held transfer waits for your decision',
          text: `Transfer ${t.id} is held and waits for your compliance team's decision in your SmartRemit workspace (Reviews). Do not share this notice with the customer.`,
        },
        { dedupeKey: `holdescalate:${t.id}:${new Date().toISOString().slice(0, 10)}` },
      );
    }
    return 'ok';
  });
  if (r === 'ok') pokeWorker();
  return r;
}

/**
 * Fix pack 7 (P9, D6): a release or reject with NO review on a live row reads
 * the owner (a throw propagates; null refuses with the generic permission
 * text). On a certified owner (reviewRecordApplies): a partner-scoped call is
 * refused with the partner's concurrent text (`changedText`: its legacy path is
 * closed by design); a platform call is refused with PARTNER_DECIDES_HOLD_REFUSAL
 * when a queue owner decides a class of the row, else HOLD_REVIEW_RELOAD_REFUSAL.
 * Uncertified owners (every tenant today): one read, no change.
 */
async function ownerGate(
  db: Db,
  transfer: Pick<Transfer, 'partnerId' | 'complianceReasons'>,
  o: { partnerScoped: boolean; changedText: string },
): Promise<void> {
  const owner = await createPartnerRepo(db).getPartner(transfer.partnerId);
  if (!owner) throw new Error('You do not have permission to perform this action.');
  if (!reviewRecordApplies(owner)) return;
  if (o.partnerScoped) throw new Error(o.changedText);
  if (
    holdQueueApplies(owner) &&
    classifyHold(transfer.complianceReasons, null, { queue: true, partnerDecidesKyc: partnerDecidesKyc(owner) }, { blocked: false })
      .some((c) => c.decider === 'partner')
  ) {
    throw new Error(PARTNER_DECIDES_HOLD_REFUSAL);
  }
  throw new Error(HOLD_REVIEW_RELOAD_REFUSAL);
}

/**
 * Release a held (in_review) transfer — a SETTLEMENT, not a status flip:
 * settlement.releaseHold commits in_review → paid AND the rail effect (signed
 * instruct / delayed mock settle) in ONE transaction, so the partner rail is
 * actually told to pay out (and to debit a B2B buyer). Rail config follows
 * the same rule as every settlement caller: the SETTLEMENT partner's when
 * routed, else the owner's. Throws if the transfer is not exactly in_review
 * (guards double-release / wrong status) — the status check is re-done by the
 * guarded claim inside releaseHold, so a race can never release twice.
 * Called by the compliance dashboard "Release" action (admin-gated, audited).
 * M3-10 follow-up: PARTNER-scoped callers (the /partner release action and a
 * partner-scoped legacy release) MUST pass `partnerRelease` with the session
 * tenant: the guarded claim then re-checks, atomically, that the sender's
 * customer row in that tenant exists with no PEP / watchlist hit, so a flag
 * raised after the caller's pre-check still refuses (the same "Cannot
 * release" error, nothing written). Platform staff pass nothing (unchanged).
 */
export async function releaseTransfer(
  store: Store,
  db: Db,
  id: string,
  audit: StaffAuditCtx,
  partnerRelease?: { partnerId: PartnerId },
  review?: HoldReviewInput,
): Promise<void> {
  // Fix pack 7 (P9): programming errors, before any read.
  if (review) {
    if (partnerRelease) throw new Error('releaseTransfer: review and partnerRelease are exclusive');
    if (audit?.actor !== review.actor || audit.reason !== review.reason) {
      throw new Error("releaseTransfer: the audit context must be the review's actor and reason");
    }
  }
  // Program-Fix 43 follow-up (defence in depth behind releaseTransferAction):
  // every release records WHO and WHY, so no audit context or a blank reason
  // is refused before any read or write.
  if (!audit || typeof audit.reason !== 'string' || audit.reason.trim() === '') {
    throw new Error('A release reason is required.');
  }
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot release: transfer is not in_review (current status: ${transfer.status})`);
  }
  // Review round 3 (M3): a blocked hold (a re-screen match) is never released;
  // say so before any write instead of losing the claim as "moved
  // concurrently". Partner staff get the one re-screen text, so a match looks
  // the same as a list outage to them.
  if (transfer.complianceStatus === 'blocked') {
    throw new Error(partnerRelease ? RESCREEN_RELEASE_REFUSAL : PLATFORM_RESCREEN_REFUSALS.blocked);
  }
  // Fix pack 2 T4: a hold waiting on a fresh sanctions list is never released
  // by a person (every caller, platform included), before any write. A row
  // gains LIST_UNAVAILABLE only on its way INTO in_review (beginHold), so this
  // read cannot be overtaken by a concurrent addition.
  if (isRescreenOnlyHold(transfer)) {
    throw new Error(RESCREEN_ONLY_RELEASE_REFUSAL);
  }
  // Fix pack 7 (P9, D6 defence in depth): a certified owner's hold moves only with a recorded
  // review. A sandbox ('test') row is exempt and its owner is not read (P0 rule 3).
  if (review) {
    if (review.ownerId !== transfer.partnerId) throw new HoldReviewChangedError('changed');
  } else if (transfer.environment !== 'test') {
    await ownerGate(db, transfer, { partnerScoped: partnerRelease !== undefined, changedText: PARTNER_RELEASE_CHANGED });
  }
  const railIntegrations = await createIntegrationsRepo(db).getIntegrations(transfer.settlementPartnerId ?? transfer.partnerId);
  // Fix pack 2 T6 (R06): on a real-money rail, PLATFORM staff clear the
  // sender's screening hold first (the audited clearSenderScreeningHoldAction
  // on the customer page), then release. The flags are the OWNING tenant's
  // row; a read error throws (nothing released). This unlocked read is the
  // fast refusal; review R1 (H2): the release transaction re-reads it locked
  // right before the claim ('sender_hold' below), so a stamp in between refuses. The partner path is already
  // refused in markPaidIfInReview (partnerRelease) for a flagged sender, a
  // stamp-only hold included (pack 2 review F2: senderClearForPartnerRelease).
  // Fix pack 7 T9 (P9 step 6): a review with pepClear skips this unlocked read: the locked
  // transaction clears the PEP hit first, then re-checks with platformSenderHoldLocked.
  if (
    !partnerRelease &&
    !review?.pepClear &&
    realMoneyRail({ environment: transfer.environment, railProviderType: railIntegrations.payment.providerType ?? null }) &&
    senderScreeningHoldActive(await readSenderScreeningFlags(db, transfer.partnerId, transfer.phone))
  ) {
    throw new Error(SENDER_SCREENING_RELEASE_REFUSAL);
  }
  // Pack 2 review F1 (A1): on a real-money rail a release never pays out on a
  // screen that is not live and fresh (older than 36 h, not on a live list,
  // no evidence, or evidence written before pack 2): it re-screens with the
  // names on file FIRST (reads outside the transaction; a read error throws,
  // nothing released), then releaseHoldAfterRescreen decides in ONE
  // transaction: released only on a live, fresh, clear screen; otherwise held
  // (LIST_UNAVAILABLE when the list is not live, so the automatic sweep owns
  // the row) or blocked (with its notices). Partner staff get ONE fixed text;
  // platform staff a text per outcome class (review R2, J2). Not real money: unchanged.
  const now = new Date();
  if (
    realMoneyRail({ environment: transfer.environment, railProviderType: railIntegrations.payment.providerType ?? null }) &&
    !liveFresh((await listScreenEvidence(db, transfer, now)).at(-1), now)
  ) {
    await warmSanctionsList();
    const { result, uncovered } = await screenHeldOnFile(db, transfer, true, now);
    const rr = await releaseHoldAfterRescreen(db, transfer.id, {
      result, uncovered, railIntegrations, audit, partnerRelease, ...(review ? { review } : {}),
    });
    if (rr.kind === 'released') {
      pokeWorker();
      return;
    }
    if (rr.kind === 'changed') throw new HoldReviewChangedError(rr.why);
    // Review R1 (H2): a stamp that landed after the pre-read above (platform only).
    if (rr.kind === 'sender_hold') throw new Error(SENDER_SCREENING_RELEASE_REFUSAL);
    // Fix pack 4 (C19): the clear re-screen's evidence is kept; nothing else written.
    if (rr.kind === 'identity_missing') throw new Error(RECIPIENT_IDENTITY_RELEASE_REFUSAL);
    // Fix pack 5 (P22): the same, for missing travel-rule data (the evidence is kept).
    if (rr.kind === 'originator_missing') throw new Error(ORIGINATOR_INFO_RELEASE_REFUSAL);
    if (rr.kind === 'already') {
      throw new Error(
        partnerRelease ? PARTNER_RELEASE_CHANGED : 'Cannot release: transfer is not in_review (it moved concurrently)',
      );
    }
    if (rr.kind === 'blocked') pokeWorker(); // the block notices are committed
    // Fix pack 7 (P21 site 4): a held re-screen may have queued a partner event; mark the worker due.
    if (rr.kind === 'held') pokeWorker();
    // Review R2 (J2): partner staff get one text for every outcome; platform
    // staff get the text for the outcome class (what to do next).
    if (partnerRelease) throw new Error(RESCREEN_RELEASE_REFUSAL);
    throw new Error(
      rr.kind === 'blocked'
        ? PLATFORM_RESCREEN_REFUSALS.blocked
        : rr.cause === 'list_not_live'
          ? PLATFORM_RESCREEN_REFUSALS.listNotLive
          : PLATFORM_RESCREEN_REFUSALS.review,
    );
  }
  // Program-Fix 28: the audit row is written INSIDE releaseHold's transaction.
  const r = await releaseHold(db, transfer, railIntegrations, audit, partnerRelease, review);
  if (r.kind === 'changed') throw new HoldReviewChangedError(r.why);
  if (r.kind === 'sender_hold') throw new Error(SENDER_SCREENING_RELEASE_REFUSAL);
  if (r.kind === 'identity_missing') throw new Error(RECIPIENT_IDENTITY_RELEASE_REFUSAL); // fix pack 4 (C19): nothing written
  if (r.kind === 'originator_missing') throw new Error(ORIGINATOR_INFO_RELEASE_REFUSAL); // fix pack 5 (P22): nothing written
  if (r.kind === 'already') {
    throw new Error(
      partnerRelease ? PARTNER_RELEASE_CHANGED : 'Cannot release: transfer is not in_review (it moved concurrently)',
    );
  }
  pokeWorker(); // fast path for the rail effect — the per-minute cron drains it regardless
}

/**
 * Reject a held (in_review) transfer: cancel it with an admin note, and — when
 * the sender was actually CHARGED (fundingRef set by the funds-capture seam) —
 * AUTO-refund: refundStatus → pending plus a durable funding.refund effect,
 * committed together so a crash can never strand a charged-but-unrefunded
 * reject. Uncharged legacy rows keep the old cancel-only behavior.
 * Called by the compliance dashboard "Reject" action.
 * Throws if the transfer is not exactly in_review.
 * Merge plan 2c (D4): the /partner reject action passes `partnerReject` with the session tenant:
 * the claim then re-checks, atomically, the tenant, a non-blocked row and the sender's customer
 * row (present, no PEP / watchlist hit), and the audit meta carries actorScope 'partner'. Omitted
 * (platform and legacy callers) ⇒ unchanged.
 *
 * Fix pack 7 T16 (D7, P14): on real money (`realMoneyFor`, every non-'test' row: one rail read) a
 * reject of a row that carries a SANCTIONS hold class (`hasSanctionsHold`: sanctions_review,
 * sender_watchlist, blocked; classes from the sender flags read under the lock, fail closed) KEEPS
 * the funds: the row cancels, the refund status is left as it is (none, or requested after a
 * sender-cancel escalation), no funding.refund; the audit meta says `fundsKept: true`, ONE
 * `rejectfunds:<id>` ops alert and ONE neutral `rejectmsg:<id>` customer message are queued. A
 * PEP-only sender is not a sanctions hold and refunds as today. The exit (P14 "Named exits"): the
 * partner returns the funds on its own processor or rail once its compliance officer approves, and
 * staff record it with `recordRefundOutsideAction` (T34, `sanctionsReturnApproved` + `approvalRef`).
 */
export async function rejectTransfer(
  store: Store,
  db: Db,
  id: string,
  audit?: StaffAuditCtx,
  partnerReject?: { partnerId: PartnerId },
  review?: HoldReviewInput,
): Promise<void> {
  // Fix pack 7 (P9): programming errors, before any read.
  if (review) {
    if (partnerReject) throw new Error('rejectTransfer: review and partnerReject are exclusive');
    if (review.pepClear) throw new Error('rejectTransfer: review.pepClear is for a release only');
    if (!audit || audit.actor !== review.actor || audit.reason !== review.reason) {
      throw new Error("rejectTransfer: the audit context must be the review's actor and reason");
    }
  }
  const transfer = await store.getTransfer(id);
  if (!transfer) {
    throw new Error('Transfer not found');
  }
  if (transfer.status !== 'in_review') {
    throw new Error(`Cannot reject: transfer is not in_review (current status: ${transfer.status})`);
  }
  // Fix pack 7 (P9, D6 defence in depth): a certified owner's hold is rejected only with a
  // recorded review. A sandbox ('test') row is exempt and its owner is not read (P0 rule 3).
  if (review) {
    if (review.ownerId !== transfer.partnerId) throw new HoldReviewChangedError('changed');
  } else if (transfer.environment !== 'test') {
    await ownerGate(db, transfer, { partnerScoped: partnerReject !== undefined, changedText: PARTNER_REJECT_CHANGED });
  }
  // The in_review check above is advisory; the GUARDED UPDATE below is the
  // claim. A concurrent release (in_review → paid + rail instructed) between
  // the read and here makes it match nothing ⇒ throw, enqueue nothing — never
  // pay out AND refund. CHARGED: the cancel claim, the refund-pending flip and
  // the durable funding.refund effect commit in ONE transaction, so a crash
  // can never leave a cancelled, charged, UNREFUNDED transfer.
  const refunding = await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    // Fix pack 7 T16 (P14): real money BEFORE every claim (reads only; a 'test' row reads nothing).
    const realMoney = await realMoneyFor(tx, transfer);
    // The classes for the funds rule, from the claimed (locked) row; on real money only.
    let classes: readonly ClassifiedClass[] = [];
    let cancelled: Transfer | null;
    if (review) {
      // Fix pack 7 (P9 steps 1-4): the tenant-pinned locked read, the owner re-read, the row
      // fingerprint, the locked sender flags, the classes, the route ('reject', final) and the
      // partner-scope sender stance. Every refusal throws, so nothing commits.
      const r = await lockAndRouteReview(tx, id, review, 'reject');
      if (r.kind === 'already') throw new Error('Cannot reject: transfer is not in_review (it moved concurrently)');
      if (r.kind !== 'ok') throw new HoldReviewChangedError(r.kind === 'changed' ? r.why : 'changed');
      // P9 step 7: the claim on the locked, tenant-pinned row (never the partner claim, DP6).
      cancelled = await repo.updateIfStatus(id, 'in_review', { status: 'cancelled', adminNote: 'rejected in review' });
      if (!cancelled) throw new Error('Cannot reject: transfer is not in_review (it moved concurrently)');
      // T16 (P14): the review path reuses the flags lockAndRouteReview read under the lock.
      if (realMoney) classes = fundsRuleClasses(cancelled, r.flags);
      // P9 step 8: the review row AFTER the claim (a refused insert throws: the claim rolls back).
      const reviewId = await insertReview(tx, r, review);
      // P9 step 9: the audit ctx is DERIVED from the review, so the two rows can never differ.
      await recordStaffTransferAudit(
        tx,
        { actor: review.actor, reason: review.reason, actorScope: review.actorScope },
        'transfer.reject',
        cancelled,
        {
          previousStatus: 'in_review',
          newStatus: 'cancelled',
          refundStatus: rejectRefundStatus(cancelled, realMoney && hasSanctionsHold(classes)),
          reviewId,
          step: r.step.step,
          disposition: review.disposition,
          holdClass: r.cls.holdClass,
          actorScope: review.actorScope,
          ...(realMoney && hasSanctionsHold(classes) ? { fundsKept: true } : {}),
        },
      );
      // P21 (T23): the disposition event, after the audit and before the funds rule / refund branch.
      await enqueueHoldDispositionIfEligible(tx, cancelled, r.owner, reviewId, r.step.final);
    } else {
      // Merge plan 2c (D4): a PARTNER-scoped reject claims with the partner-release predicates
      // (tenant, not blocked, sender row present with no PEP / watchlist hit) in the SAME UPDATE.
      cancelled = partnerReject
        ? await repo.cancelInReviewForPartner(id, partnerReject.partnerId, 'rejected in review')
        : await repo.updateIfStatus(id, 'in_review', { status: 'cancelled', adminNote: 'rejected in review' });
      if (!cancelled) {
        throw new Error(
          partnerReject
            ? PARTNER_REJECT_CHANGED
            : 'Cannot reject: transfer is not in_review (it moved concurrently)',
        );
      }
      // T16 (P14): the sender flags under the lock, AFTER the claim (the claim holds the transfer
      // row lock: transfer -> customer order). A failed read is null: fail closed (a synthetic
      // sender_watchlist class keeps the funds). No customer row in the owner tenant (a partner-API
      // sender) has no stamp to read: undefined, so only a SENDER_SCREENING reason makes a sender class.
      if (realMoney) classes = fundsRuleClasses(cancelled, await lockedFundsRuleFlags(tx, cancelled));
    }
    const fundsKept = realMoney && hasSanctionsHold(classes);
    // Program-Fix 28: the audit row BEFORE the uncharged early return, so both
    // branches record the decision in this transaction (the review path wrote its own above).
    if (audit && !review) {
      await recordStaffTransferAudit(tx, audit, 'transfer.reject', cancelled, {
        previousStatus: 'in_review',
        newStatus: 'cancelled',
        refundStatus: rejectRefundStatus(cancelled, fundsKept),
        ...(partnerReject ? { actorScope: 'partner' } : {}),
        ...(fundsKept ? { fundsKept: true } : {}),
      });
    }
    if (fundsKept) {
      // T16 (P14, D7): the funds are kept; ops and the customer are told, once each.
      const outbox = createOutboxRepo(tx);
      await outbox.enqueue(
        'ops.alert',
        {
          message:
            `⚠️ SmartRemit ops: transfer ${id} (partner ${cancelled.partnerId}) was rejected while a sanctions screening hold was on it. ` +
            `It is cancelled and NOT refunded: ${SANCTIONS_FUNDS_RULE}. The partner blocks or returns the funds on its own processor or rail; ` +
            `once the partner's compliance officer has approved a return and the money is back with the sender, record it with "Record refund made outside SmartRemit".`,
        },
        { dedupeKey: `rejectfunds:${id}` },
      );
      await outbox.enqueue(
        'whatsapp.text',
        // M9, P6: essential (survives STOP); neutral, no refund promised, no check named.
        { to: cancelled.phone, body: buildRejectContactMessage(cancelled), partnerId: cancelled.partnerId, category: 'essential', ...(isSandbox(cancelled) ? { sandbox: true } : {}) },
        { dedupeKey: `rejectmsg:${id}` },
      );
      return true; // the poke below runs
    }
    // T32: card / partner-collected variants (P27)
    if (!cancelled.fundingRef) return false; // uncharged legacy row: cancel-only
    await repo.updateRefund(id, { refundStatus: 'pending' });
    await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id },
      { dedupeKey: `refund:${id}` },
    );
    return true;
  });
  if (!refunding) return;
  pokeWorker(); // fast path — the per-minute cron drains it regardless
}

/** T16 (P14): the classes the funds rule reads; the owner argument only changes deciders. */
function fundsRuleClasses(t: Transfer, flags: Parameters<typeof classifyHold>[1]): readonly ClassifiedClass[] {
  return classifyHold(t.complianceReasons, flags, { queue: false, partnerDecidesKyc: false }, { blocked: t.complianceStatus === 'blocked' });
}

/** T16 (P14, M1): the reject audit's refundStatus: the real status when the funds are kept. */
function rejectRefundStatus(t: Transfer, fundsKept: boolean): string {
  if (fundsKept) return t.refundStatus ?? 'none';
  return t.fundingRef ? 'pending' : 'none';
}

/**
 * Merge plan 2b: an optional tenant for the refund decisions below. When given, the in-transaction
 * reload is `getOwnedTransfer(partnerId, id)` (tenant in the WHERE), so a foreign id reads as
 * missing and nothing is written. Omitted = the existing unscoped reload (legacy callers).
 */
export interface RefundScope {
  partnerId: PartnerId;
}

function loadForRefund(repo: ReturnType<typeof createTransferRepo>, id: string, scope: RefundScope | undefined): Promise<Transfer | null> {
  return scope ? repo.getOwnedTransfer(scope.partnerId, id) : repo.getTransfer(id);
}

/**
 * Fix pack 7 T16b (P14 "Refund back doors", D7, M1): why approveRefund, retryRefund and
 * issueRefund refuse a real-money row that carries a sanctions hold class. Staff-facing; the
 * exit is the partner's own return plus "Record refund made outside SmartRemit" (P26).
 */
export const REFUND_SANCTIONS_REFUSAL =
  'Cannot refund: a sanctions hold is on this transfer. The partner\'s compliance officer decides; record an approved return with "Record refund made outside SmartRemit".';

/** Fix pack 7 T16b (P14, D5/D6): a certified owner's held (in_review) row is decided in the review first. */
export const REFUND_HOLD_FIRST_REFUSAL = 'Decide this hold in the review first.';

/**
 * Fix pack 7 T16b (P14, D7): the refund back-door guard, inside each refund core's transaction.
 * `realMoney` was read BEFORE the claim (`realMoneyFor`: one rail read, a 'test' row reads
 * nothing); false = today's path, nothing else is read. On real money it runs AFTER the core's
 * guarded claim (the claim UPDATE holds the transfer row lock, so the sender flags are locked
 * transfer -> customer, the order rejectTransfer uses; a throw rolls the claim back), on the
 * CLAIMED row: the sender flags under the lock (a thrown read is null: fail closed; no customer
 * row is undefined, nothing to read, as rejectTransfer), the classes, and `hasSanctionsHold` ->
 * REFUND_SANCTIONS_REFUSAL in both scopes. Then an in_review row of a certified owner
 * (`reviewRecordApplies`) -> REFUND_HOLD_FIRST_REFUSAL (a refund on a held row would race a later
 * release). A missing owner refuses with the generic permission text. Uncertified owners: unchanged.
 */
/**
 * Fix pack 7 F4 (early review EE2): the funds rule's sender flags under the lock, for rejectTransfer
 * and refundHoldGuard. The read runs in a savepoint (readSenderFlagsLocked), so a SQL failure
 * answers null (fail closed: a synthetic sender_watchlist class) AND the transaction goes on (the
 * reject commits with the funds kept, its rejectfunds alert and rejectmsg). No customer row in the
 * owner tenant (a partner-API sender) is undefined: nothing to read is not a hit.
 */
async function lockedFundsRuleFlags(tx: DbOrTx, t: Transfer): Promise<CustomerScreeningFlags | null | undefined> {
  const read = await readSenderFlagsLocked(tx, t.partnerId, t.phone);
  if (!read.read) {
    logWarn('funds-rule.flags-read', read.errorName, { transferId: t.id });
    return null;
  }
  return read.flags ?? undefined;
}

async function refundHoldGuard(tx: DbOrTx, t: Transfer, realMoney: boolean): Promise<void> {
  if (!realMoney) return;
  if (hasSanctionsHold(fundsRuleClasses(t, await lockedFundsRuleFlags(tx, t)))) throw new Error(REFUND_SANCTIONS_REFUSAL);
  if (t.status !== 'in_review') return;
  const owner = await createPartnerRepo(tx).getPartner(t.partnerId);
  if (!owner) throw new Error('You do not have permission to perform this action.');
  if (reviewRecordApplies(owner)) throw new Error(REFUND_HOLD_FIRST_REFUSAL);
}

/**
 * PROACTIVELY issue a refund on a PAID or DELIVERED transfer that was actually
 * charged (fundingRef set) — admin-initiated, no prior customer request needed.
 * none → pending + the durable funding.refund effect, one transaction, with the
 * eligibility re-checked INSIDE it so a double-click or an ineligible transfer
 * throws and enqueues nothing. Refunding a DELIVERED transfer is a clawback the
 * operator settles out-of-band; the seam just returns the original charge.
 *
 * Defensive beyond its siblings: it asserts the funding.refund row is FRESH
 * (enqueue returns false on dedupe-key conflict) and throws to roll back the
 * pending flip if not — so a stale `refund:<id>` row can never leave a transfer
 * flipped-to-pending with no effect to drain (a state no sweep would heal).
 *
 * With a `scope` (the /partner caller): the reload is tenant-scoped, a transfer whose
 * settlementPartnerId names another partner is refused in every status, and a test transfer is
 * refused. Without one: the platform path, unchanged.
 */
export async function issueRefund(db: Db, id: string, audit?: StaffAuditCtx, scope?: RefundScope): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await loadForRefund(repo, id, scope);
    if (!transfer) {
      throw new Error('Cannot refund: transfer not found.');
    }
    if (scope) {
      // A tenant caller (the /partner Issue refund) may only refund what it also pays out: a
      // transfer routed to another network partner is refused in EVERY status, re-checked here on
      // the transaction's own read so a page rendered before the routing cannot slip through.
      if (transfer.settlementPartnerId && transfer.settlementPartnerId !== scope.partnerId) {
        throw new Error('Cannot refund: another partner pays this transfer out.');
      }
      if ((transfer.environment ?? 'live') === 'test') {
        throw new Error('Cannot refund: a test transfer moves no money.');
      }
    }
    if (transfer.status !== 'paid' && transfer.status !== 'delivered') {
      throw new Error(
        `Cannot refund: transfer is ${transfer.status} — only paid or delivered transfers can be refunded.`,
      );
    }
    // Fix pack 5 (P15, M3): a real-money partner-collected row has no fundingRef
    // (the partner holds the money); its refund is the signed reverse of P15
    // step 5. realMoneyFor is read only when fundingRef is null (no new read on
    // a charged row). Review round 1: never a routed row (RF1), and only when
    // this row's settle instruction went to its rail after go-live (RC2; a
    // demo-era row is refused as before pack 5). A failed read throws.
    const collectedOnRealMoney = await collectedOnRealMoneyFor(tx, transfer);
    if (!transfer.fundingRef && !collectedOnRealMoney) {
      throw new Error('Cannot refund: transfer was never charged (no funding reference).');
    }
    // Review round 2 GE1: a real-money card payment (class 'stripe') cannot be
    // refunded from SmartRemit yet; refused here, refund_status stays 'none'.
    if (await cardRefundUnavailableFor(tx, transfer)) {
      throw new Error(`Cannot refund: ${CARD_REFUND_UNAVAILABLE}`);
    }
    // An async debit that is still pending, failed, or was returned is not money we hold.
    if (transfer.fundingState && transfer.fundingState !== 'succeeded') {
      throw new Error(`Cannot refund: the sender debit is ${transfer.fundingState}.`);
    }
    if ((transfer.refundStatus ?? 'none') !== 'none') {
      throw new Error('Cannot refund: a refund is already in progress or complete for this transfer.');
    }
    // Fix pack 7 T16b (P14): real money before the claim (reads only).
    const realMoney = await realMoneyFor(tx, transfer);
    // The guarded write is the claim, from exactly 'none': a concurrent decision that committed
    // after the read above leaves nothing to claim, so this throws (rolls back) instead of
    // flipping a row that moved.
    const claimed = await repo.updateRefund(id, { refundStatus: 'pending' }, { from: 'none' });
    if (!claimed) {
      throw new Error('Cannot refund: a refund is already in progress or complete for this transfer.');
    }
    // Fix pack 7 T16b (P14, D7): no refund of a sanctions-held or review-held row (rolls back).
    await refundHoldGuard(tx, claimed, realMoney);
    // Review round 1 RC3: the issue-time real-money decision rides the payload,
    // so a rail that is no longer real money at the drain never sends this
    // refund down the mock path. Absent for every other row (unchanged payload).
    const fresh = await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id, ...(collectedOnRealMoney ? { collectedOnRealMoney: true } : {}) },
      { dedupeKey: `refund:${id}` },
    );
    if (!fresh) {
      throw new Error('Cannot refund: a refund effect already exists for this transfer.');
    }
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.issue', transfer, {
        previousStatus: transfer.status,
        newStatus: transfer.status,
        previousRefundStatus: 'none',
        refundStatus: 'pending',
      });
    }
  });
  pokeWorker();
}

/**
 * Approve a CUSTOMER-REQUESTED refund: requested → pending + the durable
 * funding.refund effect, one transaction. The state is re-checked inside the
 * transaction, so a double-click (or a refund never requested) throws and
 * enqueues nothing — refunds are never minted from thin air.
 */
export async function approveRefund(db: Db, id: string, audit?: StaffAuditCtx, scope?: RefundScope): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await loadForRefund(repo, id, scope);
    if (!transfer || (transfer.refundStatus ?? 'none') !== 'requested') {
      throw new Error('Cannot approve: refund is not awaiting approval.');
    }
    // Review round 2 GE1: as issueRefund; the request stays 'requested'.
    if (await cardRefundUnavailableFor(tx, transfer)) {
      throw new Error(`Cannot approve: ${CARD_REFUND_UNAVAILABLE}`);
    }
    // Fix pack 7 T16b (P14): real money before the claim (reads only).
    const realMoney = await realMoneyFor(tx, transfer);
    // The guarded write is the claim, from exactly 'requested': a concurrent decision that committed
    // after the read above (a dismiss to 'none', another approve) leaves nothing to claim, so this
    // call throws (rolls back) instead of starting a refund or auditing a no-op.
    const claimed = await repo.updateRefund(id, { refundStatus: 'pending' }, { from: 'requested' });
    if (!claimed) {
      throw new Error('Cannot approve: refund is not awaiting approval.');
    }
    // Fix pack 7 T16b (P14, D7): no refund of a sanctions-held or review-held row (rolls back).
    await refundHoldGuard(tx, claimed, realMoney);
    // Review round 1 RC3: carry the real-money decision (as issueRefund). No
    // admission here: a row that fails it is closed by the worker (RC2, RF1).
    const collectedOnRealMoney = await collectedOnRealMoneyFor(tx, transfer);
    await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id, ...(collectedOnRealMoney ? { collectedOnRealMoney: true } : {}) },
      { dedupeKey: `refund:${id}` },
    );
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.approve', transfer, {
        previousStatus: transfer.status,
        newStatus: transfer.status,
        previousRefundStatus: 'requested',
        refundStatus: 'pending',
      });
    }
  });
  pokeWorker();
}

/**
 * Dismiss a CUSTOMER-REQUESTED refund: requested → none + an adminNote trail.
 * The guarded updateRefund (legal only from 'requested') is the gate — an
 * in-flight or completed refund can never be "dismissed" away.
 */
export async function dismissRefund(db: Db, id: string, audit?: StaffAuditCtx, scope?: RefundScope): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    // A tenant-scoped call resolves the id inside the tenant first; a foreign id writes nothing.
    if (scope && !(await loadForRefund(repo, id, scope))) {
      throw new Error('Cannot dismiss: refund is not awaiting approval.');
    }
    const updated = await repo.updateRefund(id, { refundStatus: 'none' }, { from: 'requested' });
    if (!updated || (scope && updated.partnerId !== scope.partnerId)) {
      throw new Error('Cannot dismiss: refund is not awaiting approval.');
    }
    // APPENDED after any existing note (a rail-failure note, a staff note) —
    // the same rule as transfer-repo.failPaidFromRail; never clobbered.
    const prior = (updated.adminNote ?? '').trim();
    await repo.saveTransfer({
      ...updated,
      adminNote: prior === '' ? 'refund request dismissed' : `${prior} | refund request dismissed`,
    });
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.dismiss', updated, {
        previousStatus: updated.status,
        newStatus: updated.status,
        previousRefundStatus: 'requested',
        refundStatus: 'none',
      });
    }
  });
}

/**
 * Retry a FAILED refund: failed → pending + a fresh funding.refund effect.
 * The original `refund:<id>` dedupe key is spent (that row ran and the
 * provider reported failure), so each retry mints a unique key — while the
 * failed-state check inside the transaction keeps double-clicks to one.
 */
export async function retryRefund(db: Db, id: string, audit?: StaffAuditCtx, scope?: RefundScope): Promise<void> {
  await db.transaction(async (tx) => {
    const repo = createTransferRepo(tx);
    const transfer = await loadForRefund(repo, id, scope);
    if (!transfer || (transfer.refundStatus ?? 'none') !== 'failed') {
      throw new Error('Cannot retry: refund is not in a failed state.');
    }
    // Review round 2 GE1: as issueRefund; the refund stays 'failed'.
    if (await cardRefundUnavailableFor(tx, transfer)) {
      throw new Error(`Cannot retry: ${CARD_REFUND_UNAVAILABLE}`);
    }
    // Fix pack 7 T16b (P14): real money before the claim (reads only).
    const realMoney = await realMoneyFor(tx, transfer);
    // The guarded write is the claim, from exactly 'failed'. Each retry mints a UNIQUE dedupe key, so
    // this check (not the key) is what keeps a concurrent second retry from enqueueing a second
    // refund effect.
    const claimed = await repo.updateRefund(id, { refundStatus: 'pending' }, { from: 'failed' });
    if (!claimed) {
      throw new Error('Cannot retry: refund is not in a failed state.');
    }
    // Fix pack 7 T16b (P14, D7): no refund of a sanctions-held or review-held row (rolls back).
    await refundHoldGuard(tx, claimed, realMoney);
    // Review round 1 RC3: carry the real-money decision (as issueRefund).
    const collectedOnRealMoney = await collectedOnRealMoneyFor(tx, transfer);
    await createOutboxRepo(tx).enqueue(
      'funding.refund',
      { transferId: id, ...(collectedOnRealMoney ? { collectedOnRealMoney: true } : {}) },
      { dedupeKey: `refund:${id}:retry:${Date.now()}` },
    );
    if (audit) {
      await recordStaffTransferAudit(tx, audit, 'refund.retry', transfer, {
        previousStatus: transfer.status,
        newStatus: transfer.status,
        previousRefundStatus: 'failed',
        refundStatus: 'pending',
      });
    }
  });
  pokeWorker();
}
