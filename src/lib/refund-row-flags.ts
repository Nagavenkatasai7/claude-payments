import type { DbOrTx } from '@/db/client';
import type { Transfer } from './types';
import { cardRefundUnavailableView } from './funding-class';
import { realMoneyFor } from './live-gate';
import { classifyHold, hasSanctionsHold } from './hold-queue';
import { reviewRecordApplies } from './partner-decision-scope';
import { REFUND_HOLD_FIRST_REFUSAL, REFUND_SANCTIONS_REFUSAL } from './dashboard-ops';
import { logWarn } from './log';
import { readSenderScreeningFlags } from '@/db/repos/customer-repo';
import { createPartnerRepo } from '@/db/repos/partner-repo';

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

// Fix pack 7 T16b (P14 "Refund back doors", D7): the admin refund lists and the
// partner refunds page hide Approve and Retry for a real-money row that carries
// a sanctions hold class, and for a certified owner's held (in_review) row.
// Read-only and unlocked; approveRefund / retryRefund / issueRefund re-check
// inside their transaction (refundHoldGuard, dashboard-ops.ts).

type RefundHoldRow = RefundListRow & Pick<Transfer, 'phone' | 'status' | 'complianceStatus' | 'complianceReasons'>;

/**
 * The refusal text per LISTED row with a decision button (refund 'requested'
 * or 'failed') that the cores would refuse: REFUND_SANCTIONS_REFUSAL or
 * REFUND_HOLD_FIRST_REFUSAL (the order of refundHoldGuard). The rail read
 * (realMoneyFor, never throws) comes first; a non-real-money row costs nothing
 * more. A failed flags or owner read flags the row with the sanctions text
 * (fail closed: the button hides; the core re-checks). No customer row is
 * nothing to read (as the cores).
 */
export async function refundHoldRefusals(db: DbOrTx, rows: readonly RefundHoldRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of rows) {
    if (t.refundStatus !== 'requested' && t.refundStatus !== 'failed') continue;
    if (!(await realMoneyFor(db, t))) continue;
    try {
      const flags = await readSenderScreeningFlags(db, t.partnerId, t.phone).then(
        (f) => f ?? undefined,
        () => null,
      );
      const classes = classifyHold(t.complianceReasons, flags, { queue: false, partnerDecidesKyc: false }, { blocked: t.complianceStatus === 'blocked' });
      if (hasSanctionsHold(classes)) {
        out.set(t.id, REFUND_SANCTIONS_REFUSAL);
        continue;
      }
      if (t.status === 'in_review' && reviewRecordApplies(await createPartnerRepo(db).getPartner(t.partnerId))) {
        out.set(t.id, REFUND_HOLD_FIRST_REFUSAL);
      }
    } catch (err) {
      logWarn('refund-row-flags.hold', err instanceof Error ? err.name : 'error', { transferId: t.id });
      out.set(t.id, REFUND_SANCTIONS_REFUSAL);
    }
  }
  return out;
}

/** The ids refundHoldRefusals flags (P14: mirrors cardRefundBlockedIds). */
export async function refundHoldBlockedIds(db: DbOrTx, rows: readonly RefundHoldRow[]): Promise<Set<string>> {
  return new Set((await refundHoldRefusals(db, rows)).keys());
}
