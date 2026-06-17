import type { Transfer } from './types';

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

export type RefundDisposition =
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
 */
export function refundDisposition(transfer: Transfer, now: number = Date.now()): RefundDisposition {
  const refundStatus = transfer.refundStatus ?? 'none';

  // Already in the refund pipeline — surface its state, never re-offer.
  if (refundStatus === 'completed') return { kind: 'completed' };
  if (refundStatus === 'requested') return { kind: 'already_requested' };
  if (refundStatus === 'pending' || refundStatus === 'failed') return { kind: 'in_progress' };

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

/** A delivered transfer still inside the 24h recall/dispute window. */
export function isRecallEligible(transfer: Transfer, now: number = Date.now()): boolean {
  return refundDisposition(transfer, now).kind === 'recall_eligible';
}

/** A paid, not-yet-delivered transfer that can be flagged for an ops-reviewed refund. */
export function isRefundable(transfer: Transfer, now: number = Date.now()): boolean {
  return refundDisposition(transfer, now).kind === 'refundable';
}
