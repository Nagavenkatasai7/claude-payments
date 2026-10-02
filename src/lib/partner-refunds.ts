import { maskPhoneLast4 } from './mask';
import { maskRecipientName } from './partner-transfers';
import type { PartnerRole } from './partner-access';
import type { RefundStatus, Transfer } from './types';

// partner-refunds (merge plan 2b): the /partner Refunds page's PURE helpers. Decisions are
// admin-only (owner decision D1). Approve and retry start a refund (a funding.refund effect), so
// they need a fresh step-up (D2); dismiss moves no money. The server action re-checks everything;
// the money path itself stays dashboard-ops approveRefund / dismissRefund / retryRefund.

export type RefundOp = 'approve' | 'dismiss' | 'retry';
const OPS: readonly RefundOp[] = ['approve', 'dismiss', 'retry'];

/** The form's op field: exactly approve | dismiss | retry, else null. */
export function parseRefundOp(v: unknown): RefundOp | null {
  return typeof v === 'string' && (OPS as readonly string[]).includes(v) ? (v as RefundOp) : null;
}

export interface RefundControls {
  approve: boolean;
  dismiss: boolean;
  retry: boolean;
}

/** What to offer for one refund. Admin only; requested → approve / dismiss, failed → retry. */
export function refundControls(refundStatus: RefundStatus | undefined, role: PartnerRole): RefundControls {
  const admin = role === 'admin';
  return {
    approve: admin && refundStatus === 'requested',
    dismiss: admin && refundStatus === 'requested',
    retry: admin && refundStatus === 'failed',
  };
}

/** The step-up target an op needs (D2), or null for an op that moves no money. */
export function refundStepUpTarget(op: RefundOp): 'refund.approve' | 'refund.retry' | null {
  if (op === 'approve') return 'refund.approve';
  if (op === 'retry') return 'refund.retry';
  return null;
}

export interface RefundCounts {
  requested: number;
  pending: number;
  failed: number;
  completed: number;
}

export function refundCounts(rows: ReadonlyArray<{ refundStatus?: RefundStatus }>): RefundCounts {
  const c: RefundCounts = { requested: 0, pending: 0, failed: 0, completed: 0 };
  for (const r of rows) {
    const s = r.refundStatus;
    if (s === 'requested' || s === 'pending' || s === 'failed' || s === 'completed') c[s] += 1;
  }
  return c;
}

/** The ONLY fields a refund row carries (masked). */
export interface PartnerRefundRow {
  id: string;
  sender: string;
  recipient: string;
  amount: number;
  currency: string;
  refundStatus: RefundStatus;
  test: boolean;
  /** The refund time once completed, else the transfer's creation time. */
  at: string;
  controls: RefundControls;
}

export function toPartnerRefundRow(tr: Transfer, role: PartnerRole): PartnerRefundRow {
  const refundStatus = tr.refundStatus ?? 'none';
  return {
    id: tr.id,
    sender: maskPhoneLast4(tr.phone),
    recipient: maskRecipientName(tr.recipientName),
    // The refundable amount is the FULL source-side charge (the legacy refunds page's rule).
    amount: tr.totalChargeSource ?? tr.totalChargeUsd,
    currency: tr.sourceCurrency ?? 'USD',
    refundStatus,
    test: (tr.environment ?? 'live') === 'test',
    at: refundStatus === 'completed' && tr.refundedAt ? tr.refundedAt : tr.createdAt,
    controls: refundControls(refundStatus, role),
  };
}
