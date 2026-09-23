import { isPartnerPulled } from './funding-method';
import type { Transfer } from './types';

// dashboard-cancel-policy: the ONE rule for what staff "Cancel" may do
// (Phase 1 Task 5 / Program-Fix 9 / money-05).
//
// NON-CUSTODIAL: Cancel commits NO effect (no refund, no reversal, no rail
// message). So it may only VOID a row with no money behind it and no decision
// pending on it: an UNFUNDED draft, meaning awaiting_payment with no fundingRef.
// "Charged" is fundingRef (write-once, set by the capture seam BEFORE any
// settlement claim), not status.
//
// A compliance HOLD (in_review) is never Cancel-voidable, charged or not.
// Ending a hold IS the compliance decision, and it stays with admins: Release
// (a settlement) or Reject (cancel-only when uncharged, cancel + auto-refund
// when charged). Both are requireAdmin; the Compliance queue lists every hold.
// Everything else is refused with the action that returns money or decides the
// hold. canCancel can be granted to non-admin staff, so Cancel must never stand
// in for a refund, a reversal, or a compliance decision.
//
// PURE and client-safe: funding-method.ts has only a type import. The server
// guard (dashboard-ops.cancelTransfer), the transactions list (a 'use client'
// component) and the B2B page all call it, so the UI can never offer a Cancel
// the server refuses. The same pattern as canReleaseHeld.

/** Refusal copy. Thrown to the browser, so staff-safe: no PII (test-pinned). */
export const CANCEL_REFUSAL = {
  paid:
    'Cannot cancel a paid transfer: the rail has already been told to pay out, and a cancel would not return the sender’s charge. If the sender was charged here, an admin can use Refund on the transfer’s Details page.',
  paidPartnerPulled:
    'Cannot cancel a paid partner-pulled transfer directly — use Reverse (it instructs the partner to return the debit).',
  inReview:
    'Cannot cancel a transfer that is in compliance review — a hold is a compliance decision: an admin can use Reject on the Compliance page (it cancels the transfer and refunds any captured charge in one step).',
  chargedAwaiting:
    'Cannot cancel: the sender has already been charged. The reconcile sweep settles or holds this transfer within minutes — then use Refund (paid) or Reject (in review).',
  blocked: 'Cannot cancel a blocked transfer — blocked is a terminal compliance state.',
  changed: 'Cannot cancel: the transfer changed concurrently — reload and try again.',
} as const;

export type StaffCancelDecision =
  | { kind: 'void' } // unfunded draft: the guarded claim may run
  | { kind: 'noop' } // delivered / cancelled: idempotent second click
  | { kind: 'refuse'; reason: string };

type CancelView = Pick<Transfer, 'status' | 'fundingMethod' | 'fundingRef'> & Partial<Pick<Transfer, 'fundingIntentRef'>>;

export function decideStaffCancel(t: CancelView): StaffCancelDecision {
  switch (t.status) {
    case 'delivered':
    case 'cancelled':
      return { kind: 'noop' };
    case 'blocked':
      return { kind: 'refuse', reason: CANCEL_REFUSAL.blocked };
    case 'paid':
      return {
        kind: 'refuse',
        reason: isPartnerPulled(t.fundingMethod) ? CANCEL_REFUSAL.paidPartnerPulled : CANCEL_REFUSAL.paid,
      };
    case 'in_review':
      // Charged or not: a hold is decided by Reject / Release (admin), never by Cancel.
      return { kind: 'refuse', reason: CANCEL_REFUSAL.inReview };
    case 'awaiting_payment':
      // Exactly `== null`, matching the claim's SQL `funding_ref IS NULL`: an
      // empty-string ref is NOT NULL there, so it must be refused here too,
      // never offered as a void the guarded UPDATE cannot land.
      // Program-Fix 7: a bound PSP intent (an ACH debit may land days later)
      // counts as charged — the claim's SQL refuses it too (funding_intent_ref IS NULL).
      return t.fundingRef == null && t.fundingIntentRef == null
        ? { kind: 'void' }
        : { kind: 'refuse', reason: CANCEL_REFUSAL.chargedAwaiting };
    default: {
      // Exhaustive: a new TransferStatus (e.g. Task 4's rail-failure state)
      // fails tsc HERE until its Cancel semantics are decided. At runtime an
      // unknown ledger value is refused, never voided.
      const unknownStatus: never = t.status;
      return { kind: 'refuse', reason: `Cannot cancel a transfer in status ${String(unknownStatus)}.` };
    }
  }
}

/**
 * The transactions list (and the B2B page, through decideStaffCancel) shows
 * Cancel only where the server would void it: an UNCHARGED awaiting_payment
 * row. Holds are decided on the Compliance page (Release / Reject).
 */
export function showsStaffCancel(t: CancelView): boolean {
  return decideStaffCancel(t).kind === 'void';
}
