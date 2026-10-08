import { createRewardRepo, type RedemptionRow } from '@/db/repos/reward-repo';
import type { DbOrTx } from '@/db/client';
import { logWarn } from '../log';
import type { PartnerId } from '../types';
import { currentOfferLines, customerRewardLines } from './customer';
import { rewardsActive, type RewardStore } from './resolver';

// B3 rewards v1: the best-effort reward reads for receipts, the pay page and
// the portal card. Tenant-scoped (partnerId in the WHERE). A read failure logs
// one line (ids only) and shows nothing: a receipt or a page is never blocked.

/** Rewards the portal card lists. */
export const MY_REWARDS_MAX = 5;

export async function transferRewardOrNull(db: DbOrTx, partnerId: PartnerId, transferId: string): Promise<RedemptionRow | null> {
  try {
    return await createRewardRepo(db).getRedemption(partnerId, transferId);
  } catch (err) {
    logWarn('rewards.read', err instanceof Error ? err.name : 'error', { transferId });
    return null;
  }
}

export interface MyRewards {
  /** The offers that are on for this customer now (festival first). */
  offers: string[];
  /** The rewards the customer kept, newest first (released ones left out). */
  kept: Array<{ transferId: string; text: string }>;
}

/**
 * The portal "My rewards" card: null (no card) unless rewards are active for
 * the sender (demo mode AND the rewards.enabled switch, resolver.ts). Tenant
 * and sender scoped. Never throws: a read failure hides the card.
 */
export async function loadMyRewards(
  db: DbOrTx,
  flags: Pick<RewardStore, 'isFlagOn'>,
  partnerId: PartnerId,
  phone: string,
  now: Date,
  fmt: (usd: number) => string,
): Promise<MyRewards | null> {
  if (!(await rewardsActive(flags, partnerId, phone))) return null;
  try {
    const repo = createRewardRepo(db);
    const [catalog, settings, rows] = await Promise.all([
      repo.getCatalog(),
      repo.getPartnerSettings(partnerId),
      repo.listCustomerRewards(partnerId, phone, MY_REWARDS_MAX),
    ]);
    return { offers: currentOfferLines(catalog, settings, now, fmt), kept: customerRewardLines(rows, fmt) };
  } catch (err) {
    logWarn('rewards.my_rewards', err instanceof Error ? err.name : 'error', { partnerId });
    return null;
  }
}
