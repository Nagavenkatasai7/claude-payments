import type { B2bInvoice } from './types';

/**
 * Program-Fix 44 (P3, b2b-04): an UNPAID B2B bill dies B2B_BILL_TTL_DAYS after
 * it was created. The expiry is DERIVED from created_at (no column, no
 * migration), and this module is the ONE authority: the pay page, the pay
 * route, the chat pay path, the bot's open-bill lookup and the seller's
 * duplicate-bill check all read it, so they can never disagree.
 *
 * A code constant, not an env var: no new configuration, nothing to boot-assert.
 */
export const B2B_BILL_TTL_DAYS = 30;

const TTL_MS = B2B_BILL_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The oldest created_at that is still live (inclusive): now − TTL. */
export function billExpiryCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TTL_MS);
}

/**
 * True when an UNPAID bill is older than the TTL. Paid, voided and disputed
 * bills keep their own terminal state and never read as expired. An
 * unparseable created_at fails closed (expired): a bill whose age we cannot
 * prove is not payable.
 */
export function isBillExpired(
  inv: Pick<B2bInvoice, 'status' | 'createdAt'>,
  now: Date = new Date(),
): boolean {
  if (inv.status !== 'unpaid') return false;
  const created = Date.parse(inv.createdAt);
  if (!Number.isFinite(created)) return true;
  return created < billExpiryCutoff(now).getTime();
}
