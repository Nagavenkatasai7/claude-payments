import type { Transfer } from './types';
import { CANCEL_WINDOW_MS } from './remittance-disclosure';

// refund-policy — the single source of truth for "what can this customer do
// about this transfer's money right now?". Pure (no I/O) so the bot tools, the
// portal, and tests all share ONE disposition. Two outcomes move money-adjacent
// state, and both stay HUMAN-gated downstream:
//   • a not-yet-delivered transfer is REFUNDABLE → request flags it for ops review
//   • a delivered transfer is RECALL-eligible for a fixed window → opens a dispute
//     case (a support ticket) a human works; recovery is never guaranteed.
//
// Decision (2026-06-17): the recall/dispute window is 24h after delivery.

export const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours after delivery

/**
 * Program-Fix 15 PR C: the Reg E cancellation window (12 CFR 1005.34) — a
 * consumer sender may cancel within 30 minutes of PAYMENT. The same constant
 * the receipt disclosure uses (remittance-disclosure.ts), re-exported here.
 */
export { CANCEL_WINDOW_MS } from './remittance-disclosure';

export type RefundDisposition =
  | { kind: 'cancellable'; msLeft: number }      // paid within 30 min of the charge (consumer) → self-service cancel (Program-Fix 15 PR C)
  | { kind: 'refundable' }                       // paid, not delivered, no refund yet → ops-reviewed refund
  | { kind: 'recall_eligible'; msLeft: number }  // delivered within the window → open a recall/dispute case
  | { kind: 'recall_window_passed' }             // delivered, window elapsed → too late to recall
  | { kind: 'awaiting_payment' }                 // not paid yet → nothing to refund (just don't pay / cancel)
  | { kind: 'under_review' }                     // held for compliance review → ops follows up
  | { kind: 'already_requested' }                // a refund is already flagged for ops
  | { kind: 'in_progress' }                      // refund approved / failed-and-retrying → being handled
  | { kind: 'completed' }                        // already refunded
  | { kind: 'blocked' }                          // never charged (sanctions block)
  | { kind: 'cancelled' };                       // cancelled

/**
 * What the customer can do about THIS transfer's money, judged against `now`.
 * Refund pipeline state (refundStatus) takes precedence over transfer status so
 * we never offer a second refund on one already moving through the queue.
 *
 * Program-Fix 15 PR C: `chargedAt` is the CHARGE time (the `stage1:<id>` outbox
 * row's created_at — markPaidIfInReview resets paid_at on a released hold, so
 * paid_at is not the charge time). When absent, paid_at is the fallback; that
 * is only a HINT for the UI and the bot. The locked cancel service
 * (sender-cancel.ts) re-reads the charge time under the row lock and compares
 * it with the database clock — it alone decides.
 */
export function refundDisposition(
  transfer: Transfer,
  now: number = Date.now(),
  chargedAt?: string,
): RefundDisposition {
  const refundStatus = transfer.refundStatus ?? 'none';

  // Already in the refund pipeline — surface its state, never re-offer.
  if (refundStatus === 'completed') return { kind: 'completed' };
  if (refundStatus === 'pending' || refundStatus === 'failed') return { kind: 'in_progress' };

  // The Reg E cancellation window: a CONSUMER (b2c) transfer, paid, charged
  // under 30 minutes ago, refund none or merely requested. B2B is not a
  // consumer "sender" (1005.30); in_review is never auto-cancelled (C4).
  if (transfer.status === 'paid' && transfer.transferType !== 'b2b') {
    const msLeft = cancelMsLeft(chargedAt ?? transfer.paidAt, now);
    if (msLeft > 0) return { kind: 'cancellable', msLeft };
  }

  if (refundStatus === 'requested') return { kind: 'already_requested' };

  // refundStatus === 'none' from here — judge by transfer status.
  switch (transfer.status) {
    case 'blocked':
      return { kind: 'blocked' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'awaiting_payment':
      return { kind: 'awaiting_payment' };
    case 'in_review':
      return { kind: 'under_review' };
    case 'paid':
      return { kind: 'refundable' };
    case 'delivered': {
      // Defensive: a delivered transfer should always carry deliveredAt; if it
      // somehow doesn't, stay lenient toward the customer and allow the recall.
      const deliveredMs = transfer.deliveredAt ? Date.parse(transfer.deliveredAt) : NaN;
      if (!Number.isFinite(deliveredMs)) return { kind: 'recall_eligible', msLeft: RECALL_WINDOW_MS };
      const msLeft = deliveredMs + RECALL_WINDOW_MS - now;
      return msLeft > 0 ? { kind: 'recall_eligible', msLeft } : { kind: 'recall_window_passed' };
    }
    default:
      return { kind: 'under_review' };
  }
}

/** Ms left in the 30-minute window from `chargedAt` (0 when closed or unknown; capped at the full window). */
function cancelMsLeft(chargedAt: string | undefined, now: number): number {
  const chargedMs = chargedAt ? Date.parse(chargedAt) : NaN;
  if (!Number.isFinite(chargedMs)) return 0;
  return Math.min(CANCEL_WINDOW_MS, Math.max(0, chargedMs + CANCEL_WINDOW_MS - now));
}

/** A delivered transfer still inside the 24h recall/dispute window. */
export function isRecallEligible(transfer: Transfer, now: number = Date.now()): boolean {
  return refundDisposition(transfer, now).kind === 'recall_eligible';
}

/**
 * A paid, not-yet-delivered transfer that can be flagged for an ops-reviewed
 * refund. True for `cancellable` too: inside the 30-minute window the ordinary
 * refund request still works.
 */
export function isRefundable(transfer: Transfer, now: number = Date.now(), chargedAt?: string): boolean {
  const kind = refundDisposition(transfer, now, chargedAt).kind;
  return kind === 'refundable' || kind === 'cancellable';
}
