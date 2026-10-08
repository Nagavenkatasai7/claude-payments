import { wouldBeFeeUsd } from '../fx';
import { isFirstTransferFree } from '../fee-tier';
import { inDemo } from '../demo-mode';
import { logWarn } from '../log';
import { budgetAllows, giveBackFor, pickReward } from './engine';
import type { FlagContext, FlagKey } from '../flags';
import type { RewardQuoteFacts } from '../store';
import type { FundingMethod, PartnerId, TransferEnvironment } from '../types';
import type { QuotePricing, QuotedReward } from './types';

// B3 rewards v1: the quote-time resolver. The bot, the portal chat and the
// approval card call it; the draft keeps what it returns and the mint
// re-checks it under the sender lock (transfer-create.ts).
//
// Gate: a demo-mode phone (DEMO_PHONES) AND the rewards.enabled switch for the
// tenant. FAILS CLOSED: isFlagOn answers false on a read failure, and any
// other error here logs one line and answers "no reward", so a quote is never
// discounted on a guess. First transfer free is not decided here: fx.quote()
// already prices it at $0 (fee-tier.ts); this only names it for the customer.
// Sandbox and B2B quotes never carry a reward.

export interface RewardStore {
  isFlagOn(key: FlagKey, ctx?: FlagContext): Promise<boolean>;
  rewardQuoteFacts(partnerId: PartnerId, phone: string, now?: Date): Promise<RewardQuoteFacts>;
}

/** Is the reward program on for this sender (demo mode AND the switch)? Never throws. */
export async function rewardsActive(store: Pick<RewardStore, 'isFlagOn'>, partnerId: PartnerId, phone: string): Promise<boolean> {
  try {
    if (!inDemo(phone)) return false;
    return await store.isFlagOn('rewards.enabled', { partnerId });
  } catch (err) {
    logWarn('rewards.switch', err instanceof Error ? err.name : 'error', { partnerId });
    return false;
  }
}

export interface QuoteRewardArgs {
  partnerId: PartnerId;
  phone: string;
  /** The quote's USD-equivalent (fx.quote().amountUsd). */
  amountUsd: number;
  fundingMethod: FundingMethod;
  /** The fee-tier count the quote was priced at (fee-tier.ts). */
  transferCount: number;
  transferType?: 'b2c' | 'b2b';
  environment?: TransferEnvironment;
  now?: Date;
}

export interface QuoteRewardOffer {
  reward: QuotedReward;
  /** The pricing input for fx.quote(); absent for first transfer free (already $0). */
  pricing?: QuotePricing;
}

/** The reward this quote carries, or null. Never throws. */
export async function resolveQuoteReward(store: RewardStore, a: QuoteRewardArgs): Promise<QuoteRewardOffer | null> {
  if (a.transferType === 'b2b' || a.environment === 'test') return null;
  try {
    if (!(await rewardsActive(store, a.partnerId, a.phone))) return null;
    const standardFeeUsd = wouldBeFeeUsd(a.amountUsd, a.fundingMethod);
    if (isFirstTransferFree(a.transferCount)) {
      return standardFeeUsd > 0 ? { reward: { kind: 'first_transfer', discountUsd: standardFeeUsd, detail: {} } } : null;
    }
    const now = a.now ?? new Date();
    const facts = await store.rewardQuoteFacts(a.partnerId, a.phone, now);
    const reward = pickReward({
      now, amountUsd: a.amountUsd, standardFeeUsd, catalog: facts.catalog, settings: facts.settings, usage: facts.usage,
    });
    if (!reward) return null;
    // Unlocked here (a hint for the card); the mint re-checks under the partner budget lock.
    if (!budgetAllows(facts.terms, facts.budgetUsedUsd, giveBackFor(reward.discountUsd, facts.terms.giveBackPct))) return null;
    return { reward, pricing: { feeDiscountUsd: reward.discountUsd } };
  } catch (err) {
    logWarn('rewards.quote', err instanceof Error ? err.name : 'error', { partnerId: a.partnerId });
    return null;
  }
}
