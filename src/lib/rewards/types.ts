// B3 rewards v1: the shared shapes. Money is USD numbers rounded to cents.

/** Every reward a transfer can carry. First transfer free is today's pricing rule (fee-tier.ts). */
export type RewardKind = 'first_transfer' | 'nth_transfer' | 'festival';

/** The rewards SmartRemit funds (the admin catalog, the partner's choices, the budget). */
export type FundedRewardKind = 'nth_transfer' | 'festival';

export const FUNDED_REWARD_KINDS: readonly FundedRewardKind[] = ['nth_transfer', 'festival'];

export function isFundedRewardKind(v: unknown): v is FundedRewardKind {
  return v === 'nth_transfer' || v === 'festival';
}

export function isRewardKind(v: unknown): v is RewardKind {
  return v === 'first_transfer' || isFundedRewardKind(v);
}

/** One admin catalog entry: whether partners may offer it and the limits they choose inside. */
export interface CatalogEntry {
  kind: FundedRewardKind;
  available: boolean;
  nthMin: number;
  nthMax: number;
  maxDays: number;
  /** The most one reward takes off a fee. */
  maxDiscountUsd: number;
  /** Rewards of this kind one customer may hold in one ET month. */
  customerMonthlyCap: number;
  festivalNames: string[];
}

export type Catalog = Record<FundedRewardKind, CatalogEntry>;

/** Admin-set money terms per partner (statement only in v1). */
export interface PartnerRewardTerms {
  platformFeeUsd: number;
  giveBackPct: number;
  monthlyBudgetUsd: number;
}

/** A partner's own choice for one reward (inside the catalog limits). */
export interface PartnerRewardSetting {
  kind: FundedRewardKind;
  enabled: boolean;
  nth?: number | null;
  festivalName?: string | null;
  /** ET calendar days, 'YYYY-MM-DD', inclusive. */
  startsOn?: string | null;
  endsOn?: string | null;
  minAmountUsd?: number | null;
}

export type PartnerRewardSettings = Record<FundedRewardKind, PartnerRewardSetting | undefined>;

/** The sender's reward facts for one ET month (reads leave out released rewards). */
export interface SenderRewardUsage {
  /** Live consumer transfers delivered this ET month and not refunded. */
  deliveredThisMonth: number;
  /** Rewards held this month by transfers that are not cancelled, blocked or refunded. */
  activeThisMonth: Record<FundedRewardKind, number>;
}

/**
 * The reward a quote carries: shown on the card, kept on the draft, re-checked
 * under the sender lock and saved as the redemption row with the mint.
 */
export interface QuotedReward {
  kind: RewardKind;
  /** What the reward takes off the fee, USD (first transfer free: the fee it waived). */
  discountUsd: number;
  detail: { nth?: number; festivalName?: string };
}

/** fx.quote()'s optional pricing input (B3): absent ⇒ today's prices exactly. */
export interface QuotePricing {
  /** Taken off the fee in USD; the fee never goes below $0. */
  feeDiscountUsd: number;
}
