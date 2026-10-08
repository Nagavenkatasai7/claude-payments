import { createRewardRepo } from '@/db/repos/reward-repo';
import type { Db, DbOrTx } from '@/db/client';
import { easternMonth } from '../dates';
import { logWarn } from '../log';
import type { Transfer } from '../types';

// B3 rewards v1: the platform fee ledger. Every LIVE delivered transfer owes
// the partner's platform fee ($0.60 placeholder): ONE platform_fee_ledger row
// (the PK is the transfer id, so a replayed delivery or the sweep never adds a
// second). deliverTransfer (delivery-receipt.ts) writes it in the delivery
// transaction, inside a SAVEPOINT, so a ledger failure never blocks delivery;
// sweepPlatformFeeGaps fills any row a failure left out. Statement only in v1:
// no invoice, no payment.

/** How far back the sweep looks for a delivered transfer without a fee row. */
export const FEE_GAP_LOOKBACK_DAYS = 40;
const FEE_GAP_BATCH = 200;

/** The ET month a delivery belongs to. */
export function deliveryMonth(t: Pick<Transfer, 'deliveredAt'>, now: number = Date.now()): string {
  const at = t.deliveredAt ? Date.parse(t.deliveredAt) : NaN;
  return easternMonth(Number.isFinite(at) ? at : now);
}

/**
 * The ledger row and, for a transfer compliance flagged, the withheld
 * give-back (owner decision, question 9). Runs on the delivery transaction's
 * savepoint (or the root handle in the sweep). Throws on a database error: the
 * caller decides (the delivery logs and commits without it).
 */
export async function recordDeliveryFee(db: DbOrTx, t: Pick<Transfer, 'id' | 'partnerId' | 'environment' | 'deliveredAt'>): Promise<boolean> {
  if ((t.environment ?? 'live') !== 'live') return false;
  const rewards = createRewardRepo(db);
  const inserted = await rewards.recordPlatformFee({ id: t.id, partnerId: t.partnerId }, deliveryMonth(t));
  await rewards.withholdGiveBackIfFlagged(t.id);
  return inserted;
}

/**
 * The gap sweep (worker, twice an hour): live delivered transfers of the last
 * FEE_GAP_LOOKBACK_DAYS with no fee row get one. Each row on its own; a
 * failure is logged (ids only) and the sweep goes on. Returns rows written.
 */
export async function sweepPlatformFeeGaps(db: Db, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - FEE_GAP_LOOKBACK_DAYS * 86_400_000);
  const gaps = await createRewardRepo(db).listFeeGaps(since, FEE_GAP_BATCH);
  let written = 0;
  for (const g of gaps) {
    try {
      const ok = await db.transaction((tx) =>
        recordDeliveryFee(tx, { id: g.id, partnerId: g.partnerId, environment: 'live', deliveredAt: g.deliveredAt.toISOString() }),
      );
      if (ok) written++;
    } catch (err) {
      logWarn('rewards.fee_sweep', err instanceof Error ? err.name : 'error', { transferId: g.id });
    }
  }
  return written;
}
