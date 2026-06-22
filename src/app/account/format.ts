import type { Transfer, TransferStatus } from '@/lib/types';

// Shared, customer-safe formatting for the /account portal — mirrors the
// recent-transfers.ts labels (the customer never sees the raw 'blocked' token or
// any internal/compliance wording). Pure helpers; no PII beyond what the customer
// already owns (their own amounts, recipient names, status).

/** Currency-formatted amount; falls back to "<n> <code>" for unknown codes. */
export function money(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The amount the customer sent, in their own source currency. */
export function transferAmount(t: Transfer): string {
  return money(t.amountSource ?? t.amountUsd ?? 0, t.sourceCurrency ?? 'USD');
}

const STATUS_LABEL: Record<TransferStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  in_review: 'Under review',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  blocked: 'On hold', // NEVER the raw internal token
};

// Refund-aware overlay (mirrors recent-transfers.ts): an active/settled refund
// replaces the base label; 'none'/'failed' fall through to the base status.
const REFUND_LABEL: Partial<Record<NonNullable<Transfer['refundStatus']>, string>> = {
  requested: 'Refund requested',
  pending: 'Refund on the way',
  completed: 'Refunded',
};

/** Customer-facing status label for a transfer (refund-aware). */
export function transferStatusLabel(t: Pick<Transfer, 'status' | 'refundStatus'>): string {
  return REFUND_LABEL[t.refundStatus ?? 'none'] ?? STATUS_LABEL[t.status] ?? 'In progress';
}

type BadgeTone = 'default' | 'secondary' | 'destructive' | 'outline';

/** A Badge variant for a transfer's status, so pills read consistently. */
export function transferStatusTone(t: Pick<Transfer, 'status' | 'refundStatus'>): BadgeTone {
  if (t.refundStatus === 'completed') return 'secondary';
  if (t.refundStatus === 'requested' || t.refundStatus === 'pending') return 'outline';
  switch (t.status) {
    case 'delivered':
      return 'default';
    case 'blocked':
      return 'destructive';
    case 'cancelled':
      return 'outline';
    default:
      return 'secondary'; // awaiting_payment / paid / in_review
  }
}

/** Mask a phone to its last 4 for display ("••• ••• 2030"). */
export function maskPhone(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length <= 4 ? phone : `••• ••• ${digits.slice(-4)}`;
}
