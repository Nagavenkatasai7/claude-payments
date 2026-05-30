import type { Customer, FundingMethod } from './types';

const STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

const FUNDING_LABEL: Record<FundingMethod, string> = {
  bank_transfer: 'bank transfer',
  debit_card: 'debit card',
  credit_card: 'credit card',
};

/**
 * A compact round-0 system note of the sender's last-used funding method, so the
 * bot can default it instead of re-asking. Returns '' (inject nothing) when there
 * is no recent default — preserving today's "always ask" behavior for new /
 * history-less customers and for stale (>90-day) defaults.
 *
 * Pure + read-only: takes the already-fetched Customer (no extra Redis read).
 * Surfaces ONLY the funding-method enum label — no PII, no partner, no amounts.
 */
export function getSenderDefaultsNote(customer: Customer | null): string {
  const method = customer?.lastFundingMethod;
  const at = customer?.lastFundingMethodAt;
  if (!method || !at) return '';
  const age = Date.now() - Date.parse(at);
  if (!Number.isFinite(age) || age > STALE_MS) return ''; // stale or unparseable ⇒ ask
  const label = FUNDING_LABEL[method];
  if (!label) return '';
  return (
    `[SENDER DEFAULTS] Last time, the sender paid by ${label}. If they don't say how ` +
    `they'll pay, default to this method; the approval card shows the fee so they can change it.`
  );
}
