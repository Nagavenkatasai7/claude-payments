// Fix pack 6 (P11, R46): what /pay/<id> shows for a transfer row, by the P11 status table
// (first match wins). Pure; the page decides the markup. A cancelled row that was never
// charged (or a legacy id, or a payment-link transfer: the page checks that) answers null:
// the page keeps the ONE dead-link sheet, byte-equal to not-found.
import { isOpaqueTransferId } from './id';
import type { Transfer } from './types';

export type PayReceiptState =
  | 'form'
  | 'legacy_complete'
  | 'complete_receipt'
  | 'held_receipt'
  | 'held_no_receipt'
  | 'not_completed'
  | 'refunded'
  | 'cancelled_charged';

export function payReceiptState(
  t: Pick<Transfer, 'id' | 'status' | 'refundStatus' | 'paidAt' | 'fundingState' | 'complianceStatus' | 'environment'>,
): PayReceiptState | null {
  if (t.status === 'awaiting_payment') return 'form';
  if (t.status === 'cancelled') {
    const charged = !!t.paidAt || (t.refundStatus ?? 'none') !== 'none';
    if (!isOpaqueTransferId(t.id) || !charged) return null;
    return t.refundStatus === 'completed' ? 'refunded' : 'cancelled_charged';
  }
  if (t.environment === 'test') return 'legacy_complete';
  if (!isOpaqueTransferId(t.id)) return 'legacy_complete';
  if (t.refundStatus === 'completed') return 'refunded';
  if (t.fundingState === 'returned') return 'held_no_receipt';
  if (t.status === 'blocked') return t.paidAt ? 'held_no_receipt' : 'not_completed';
  if (t.status === 'in_review') return t.complianceStatus === 'blocked' ? 'held_no_receipt' : 'held_receipt';
  return 'complete_receipt';
}
