import { settingWithinLimits } from './settings';
import type {
  Catalog,
  FundedRewardKind,
  PartnerRewardSettings,
  PartnerRewardTerms,
  QuotedReward,
  SenderRewardUsage,
} from './types';

// B3 rewards v1: the pure engine. Who qualifies, in which order, how much
// comes off the fee and what SmartRemit gives back. No I/O: the quote path
// (resolver.ts) and the locked mint (transfer-create.ts) feed it the facts
// they read, so both decide with the same rules.
//
// Money safety: a reward lowers ONLY the fee and never below $0. The amount
// sent, the rate and the amount received never change. One reward per
// transfer. Order (plan B3): welcome (first transfer free, today's rule, which
// already prices the fee at $0 so nothing else applies), festival, loyalty
// (every Nth transfer in a month).

const ET = 'America/New_York';
const round2 = (x: number) => Math.round(x * 100) / 100;

/** The ET calendar day of `at`, 'YYYY-MM-DD'. */
export function etDateKey(at: Date): string {
  return at.toLocaleDateString('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' });
}

export interface RewardEligibilityInput {
  now: Date;
  amountUsd: number;
  /** The fee before any reward (fx.wouldBeFeeUsd for the funding method). */
  standardFeeUsd: number;
  catalog: Catalog;
  settings: PartnerRewardSettings;
  usage: SenderRewardUsage;
}

/** Does this sender qualify for `kind` right now? */
export function qualifies(kind: FundedRewardKind, i: RewardEligibilityInput): boolean {
  const c = i.catalog[kind];
  const s = i.settings[kind];
  if (!c.available || !s || !s.enabled || !settingWithinLimits(s, c)) return false;
  if (!(i.standardFeeUsd > 0) || !(c.maxDiscountUsd > 0)) return false;
  const held = i.usage.activeThisMonth[kind];
  if (held >= c.customerMonthlyCap) return false;
  if (kind === 'nth_transfer') {
    const n = s.nth as number;
    const position = i.usage.deliveredThisMonth + 1;
    // Every Nth delivered transfer; a position already rewarded (an unpaid or
    // delivered transfer holds it) is not given again.
    return position % n === 0 && held < Math.floor(position / n);
  }
  const today = etDateKey(i.now);
  return (
    (s.startsOn as string) <= today &&
    today <= (s.endsOn as string) &&
    i.amountUsd >= (s.minAmountUsd ?? 0)
  );
}

/** What `kind` takes off the fee: all of it, up to the admin limit. */
export function discountFor(kind: FundedRewardKind, i: RewardEligibilityInput): number {
  return round2(Math.min(i.standardFeeUsd, i.catalog[kind].maxDiscountUsd));
}

/** The one SmartRemit-funded reward for this quote, or null. Festival first, then loyalty. */
export function pickReward(i: RewardEligibilityInput): QuotedReward | null {
  for (const kind of ['festival', 'nth_transfer'] as const) {
    if (!qualifies(kind, i)) continue;
    const discountUsd = discountFor(kind, i);
    if (discountUsd <= 0) continue;
    const s = i.settings[kind]!;
    return {
      kind,
      discountUsd,
      detail: kind === 'nth_transfer' ? { nth: s.nth as number } : { festivalName: s.festivalName as string },
    };
  }
  return null;
}

/** SmartRemit's give-back credit for one discount (the partner's percentage), in cents. */
export function giveBackFor(discountUsd: number, pct: number): number {
  return round2((discountUsd * pct) / 100);
}

/**
 * May the partner's budget take `giveBackUsd` more this month? A $0 budget
 * allows nothing (owner decision, question 6): no SmartRemit-funded reward
 * until the admin sets one. Compared in cents.
 */
export function budgetAllows(terms: PartnerRewardTerms, usedUsd: number, giveBackUsd: number): boolean {
  const budget = Math.round(terms.monthlyBudgetUsd * 100);
  if (budget <= 0) return false;
  return Math.round(usedUsd * 100) + Math.round(giveBackUsd * 100) <= budget;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** The approval card's fee line for a SmartRemit-funded reward (amounts already formatted). */
export function rewardFeeLine(r: QuotedReward, feeUsd: number, feeText: string, savedText: string): string {
  let what: string;
  if (r.kind === 'festival') what = `${r.detail.festivalName ?? 'festival'} offer`;
  else if (r.kind === 'nth_transfer') {
    const nth = ordinal(r.detail.nth ?? 0);
    what = feeUsd === 0 ? `your ${nth} transfer this month is free` : `a reward for your ${nth} transfer this month`;
  } else what = 'first transfer free';
  return `Fee ${feeText}, ${what} (you save ${savedText}).`;
}

/** The receipt's reward line. `fmt` formats a USD amount. */
export function rewardReceiptLine(r: Pick<QuotedReward, 'kind' | 'discountUsd' | 'detail'>, fmt: (usd: number) => string): string {
  const saved = fmt(r.discountUsd);
  if (r.kind === 'first_transfer') return `Reward: first transfer free (saved ${saved}).`;
  if (r.kind === 'nth_transfer') return `Reward: ${ordinal(r.detail.nth ?? 0)} transfer this month (saved ${saved}).`;
  return `Reward: ${r.detail.festivalName ?? 'festival'} offer (saved ${saved}).`;
}
