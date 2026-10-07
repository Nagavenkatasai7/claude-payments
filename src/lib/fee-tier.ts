// The fee tier (A5): ONE place that decides which transfer count prices a
// quote, so the Partner API preview, the chat quote and the mint agree.
// fx.quote() waives the fee when the count is 0 (the sender's free first
// transfer); any count >= 1 is the standard fee.
import type { Store } from './store';
import type { PartnerId } from './types';

/** The count that prices a quote at the standard (non-first-transfer) fee. */
export const STANDARD_FEE_TIER_COUNT = 1;

/**
 * The sender's fee-tier count: the tenant's ledger count for this phone
 * (store.getTransferCount: live rows only, blocked excluded) when a phone is
 * known, else the standard count. A store failure propagates: each caller
 * picks its own fallback (the Partner API preview falls back to the standard
 * fee, a safe over-quote).
 */
export async function feeTierCount(
  store: Pick<Store, 'getTransferCount'>,
  partnerId: PartnerId,
  phone?: string | null,
): Promise<number> {
  if (!phone) return STANDARD_FEE_TIER_COUNT;
  return store.getTransferCount(partnerId, phone);
}

/** True when this count prices the sender's free first transfer. */
export const isFirstTransferFree = (n: number): boolean => n === 0;
