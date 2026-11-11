import type { DbOrTx } from '@/db/client';
import type { Transfer } from './types';
import { cardRefundUnavailableView } from './funding-class';

// Final check F9 (X2): the admin refund lists (the ops page and the refunds
// ledger) show the fixed CARD_REFUND_UNAVAILABLE line in place of Approve and
// Retry for a real-money card payment, because approveRefund and retryRefund
// refuse it. Read-only; the cores re-check inside their transaction.

type RefundListRow = Pick<
  Transfer,
  'id' | 'environment' | 'fundingMethod' | 'fundingProvider' | 'fundingRef' | 'fundingIntentRef' | 'partnerId' | 'settlementPartnerId' | 'paidAt' | 'refundStatus'
>;

/**
 * The ids of the LISTED rows with a decision button (refund 'requested' or
 * 'failed') that are card payments on a real-money rail. Only a card-class row
 * costs a rail read (cardRefundUnavailableView answers any other class with no
 * read); a failed read flags the row (the button hides; the core re-checks).
 */
export async function cardRefundBlockedIds(db: DbOrTx, rows: readonly RefundListRow[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const t of rows) {
    if (t.refundStatus !== 'requested' && t.refundStatus !== 'failed') continue;
    if (await cardRefundUnavailableView(db, t)) out.add(t.id);
  }
  return out;
}
