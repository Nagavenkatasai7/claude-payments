import type { Store } from './store';
import type { Transfer, TransferStatus } from './types';
import { easternDate } from './dates';
import { boundUntrustedText, ID_MAX, NAME_MAX } from './untrusted-text';

const MAX_RECENT = 5; // last 5 of the already-newest-first list (fixed token cost)

// Customer-facing status labels. NEVER the raw internal token for `blocked` —
// the customer must never see internal screening wording. bot-content-guard backstops this.
const STATUS_LABEL: Record<TransferStatus, string> = {
  awaiting_payment: 'awaiting payment',
  paid: 'paid',
  in_review: 'under review',
  delivered: 'delivered',
  cancelled: 'cancelled',
  blocked: 'on hold',
};

// Refund-aware overlay: an active or settled refund replaces the base status
// label. 'none' and 'failed' deliberately fall through — a FAILED refund
// attempt is ops-internal; the customer keeps seeing the prior state.
const REFUND_LABEL: Partial<Record<NonNullable<Transfer['refundStatus']>, string>> = {
  requested: 'refund requested',
  pending: 'refund on the way',
  completed: 'refunded',
};

function formatAmount(transfer: Transfer): string {
  // Mirrors the dashboard money() helper (transactions-tabs.tsx) — source
  // currency, customer-visible. amountSource ?? amountUsd defends pre-P4 records
  // (getTransfer already backfills amountSource = amountUsd, belt-and-braces here).
  const currency = transfer.sourceCurrency ?? 'USD';
  const amount = transfer.amountSource ?? transfer.amountUsd ?? 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`; // Intl rejected an unknown code — never throw
  }
}

/** The customer-safe summary fields for ONE transfer. */
export interface TransferSummaryFields {
  id: string; // the customer's own short id (no PII); '' when absent
  date: string; // Eastern date, or 'recently' when missing
  recipientName: string; // recipientName (clamped), or 'a recipient' when blank
  amount: string; // source-currency, customer-visible
  status: string; // customer-facing label (never the raw 'blocked' token)
}

/**
 * The ONE customer-safe per-transfer shape, shared by the round-0
 * get_customer_context result and the list_recent_transfers tool. Surfaces only
 * fields the customer already owns — recipientName + source-currency amount +
 * status label + date + their own short id — NEVER a payout account, an internal
 * screening reason, or a tenant field. bot-content-guard scans this file, so a
 * single formatter keeps both surfaces leak-safe and in lockstep.
 *
 * fix 5 (F43): the recipient name may have been written by an outsider (an
 * external API caller, pre-fix), so it is clamped here — no control character,
 * line separator or []{}<> marker, at most 80 characters — and the id too.
 */
export function transferSummaryFields(transfer: Transfer): TransferSummaryFields {
  return {
    id: boundUntrustedText(transfer.id ?? '', ID_MAX),
    date: transfer.createdAt ? easternDate(Date.parse(transfer.createdAt)) : 'recently',
    recipientName: boundUntrustedText(transfer.recipientName ?? '', NAME_MAX) || 'a recipient',
    amount: formatAmount(transfer),
    status:
      REFUND_LABEL[transfer.refundStatus ?? 'none'] ??
      STATUS_LABEL[transfer.status] ??
      'in progress',
  };
}

/**
 * The customer's OWN most-recent transfers (newest first, at most 5) as DATA
 * for the round-0 get_customer_context result (fix 5 — never a system note).
 * Returns [] when the customer has no transfer history ⇒ nothing is injected.
 *
 * Read-only. Surfaces only transferSummaryFields (fields the customer already
 * owns, names clamped). Stage 4: an INDEXED own-customer query (WHERE tenant =
 * $1 AND phone = $2) — this runs on every chat turn and must never scan the
 * ledger.
 */
export async function getRecentTransfers(
  tenantId: string,
  phone: string,
  store: Store,
): Promise<TransferSummaryFields[]> {
  const top = await store.listTransfersByPhone(tenantId, phone, MAX_RECENT); // newest-first, indexed, keyed by the customer's own tenant
  return top.slice(0, MAX_RECENT).map(transferSummaryFields);
}
