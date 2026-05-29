import type { Store } from './store';
import type { Transfer, TransferStatus } from './types';
import { easternDate } from './dates';

const MAX_RECENT = 5; // last 5 of the already-newest-first list (fixed token cost)

// Customer-facing status labels. NEVER the raw internal token for `blocked` —
// the customer must never see internal screening wording. bot-content-guard backstops this.
const STATUS_LABEL: Record<TransferStatus, string> = {
  awaiting_payment: 'awaiting payment',
  paid: 'paid',
  delivered: 'delivered',
  cancelled: 'cancelled',
  blocked: 'on hold',
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

function formatLine(transfer: Transfer): string {
  const when = transfer.createdAt ? easternDate(Date.parse(transfer.createdAt)) : 'recently';
  const who = (transfer.recipientName ?? '').trim() || 'a recipient';
  const amount = formatAmount(transfer);
  const status = STATUS_LABEL[transfer.status] ?? 'in progress';
  return `${when} · ${who} · ${amount} · ${status}`;
}

/**
 * A compact, round-0 system note of the customer's OWN most-recent transfers.
 * Returns '' (inject nothing) when the customer has no transfer history.
 *
 * Read-only: calls store.listTransfers() and nothing else — no Redis writes,
 * no schema change, no new key. Tenant-blind by construction: surfaces only
 * recipientName + source-currency amount + status label + date (fields the
 * customer already owns). Strict own-phone filter; a legacy record with a
 * missing phone matches nothing and is dropped (fail-closed).
 */
export async function getRecentTransfersNote(phone: string, store: Store): Promise<string> {
  const all = await store.listTransfers();                   // newest-first, defensively sorted
  const mine = all.filter((t) => (t.phone ?? '') === phone); // strict own-phone filter
  const top = mine.slice(0, MAX_RECENT);
  if (top.length === 0) return '';                           // history-less ⇒ unchanged behavior
  const lines = top.map(formatLine);
  return (
    `[RECENT TRANSFERS] The customer's most recent sends (newest first), for context only — ` +
    `reference naturally if relevant, do not list them unprompted:\n${lines.join('\n')}`
  );
}
