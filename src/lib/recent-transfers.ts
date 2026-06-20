import type { Store } from './store';
import type { Transfer, TransferStatus } from './types';
import { easternDate } from './dates';

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
  recipientName: string; // recipientName, or 'a recipient' when blank
  amount: string; // source-currency, customer-visible
  status: string; // customer-facing label (never the raw 'blocked' token)
}

/**
 * The ONE customer-safe per-transfer shape, shared by the round-0 [RECENT
 * TRANSFERS] note (formatLine) and the list_recent_transfers tool. Surfaces only
 * fields the customer already owns — recipientName + source-currency amount +
 * status label + date + their own short id — NEVER a payout account, an internal
 * screening reason, or a tenant field. bot-content-guard scans this file, so a
 * single formatter keeps both surfaces leak-safe and in lockstep.
 */
export function transferSummaryFields(transfer: Transfer): TransferSummaryFields {
  return {
    id: (transfer.id ?? '').trim(),
    date: transfer.createdAt ? easternDate(Date.parse(transfer.createdAt)) : 'recently',
    recipientName: (transfer.recipientName ?? '').trim() || 'a recipient',
    amount: formatAmount(transfer),
    status:
      REFUND_LABEL[transfer.refundStatus ?? 'none'] ??
      STATUS_LABEL[transfer.status] ??
      'in progress',
  };
}

function formatLine(transfer: Transfer): string {
  // Short transfer ref so the bot can name a SPECIFIC transfer (e.g. when the
  // customer asks for a refund) without echoing the full id. The id is the
  // customer's own and carries no PII — leak-safe.
  const f = transferSummaryFields(transfer);
  const ref = f.id ? `#${f.id} · ` : '';
  return `${ref}${f.date} · ${f.recipientName} · ${f.amount} · ${f.status}`;
}

/**
 * A compact, round-0 system note of the customer's OWN most-recent transfers.
 * Returns '' (inject nothing) when the customer has no transfer history.
 *
 * Read-only. Tenant-blind by construction: surfaces only recipientName +
 * source-currency amount + status label + date (fields the customer already
 * owns). Stage 4: an INDEXED own-phone query (WHERE phone = $1) — this runs
 * on every chat turn and must never scan the ledger.
 */
export async function getRecentTransfersNote(phone: string, store: Store): Promise<string> {
  const top = await store.listTransfersByPhone(phone, MAX_RECENT); // newest-first, indexed
  if (top.length === 0) return '';                           // history-less ⇒ unchanged behavior
  const lines = top.map(formatLine);
  return (
    `[RECENT TRANSFERS] The customer's most recent sends (newest first), for context only — ` +
    `reference naturally if relevant, do not list them unprompted:\n${lines.join('\n')}`
  );
}
