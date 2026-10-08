import { describe, it, expect } from 'vitest';
import {
  budgetAllows,
  giveBackFor,
  pickReward,
  qualifies,
  rewardFeeLine,
  rewardReceiptLine,
  etDateKey,
  type RewardEligibilityInput,
} from '@/lib/rewards/engine';
import { DEFAULT_CATALOG, DEFAULT_TERMS } from '@/lib/rewards/settings';
import type { CatalogEntry, PartnerRewardSetting } from '@/lib/rewards/types';

// B3 rewards v1: the pure engine (who qualifies, the order, the discount and
// the give-back). Relative dates only where a window matters.

const NOW = new Date();
const today = etDateKey(NOW);
const plusDays = (n: number) => etDateKey(new Date(NOW.getTime() + n * 86_400_000));

function catalog(over: Partial<Record<'nth_transfer' | 'festival', Partial<CatalogEntry>>> = {}) {
  return {
    nth_transfer: { ...DEFAULT_CATALOG.nth_transfer, available: true, ...over.nth_transfer },
    festival: { ...DEFAULT_CATALOG.festival, available: true, festivalNames: ['Diwali', 'Holi'], ...over.festival },
  };
}

const NTH5: PartnerRewardSetting = { kind: 'nth_transfer', enabled: true, nth: 5 };
const DIWALI: PartnerRewardSetting = {
  kind: 'festival', enabled: true, festivalName: 'Diwali', startsOn: plusDays(-1), endsOn: plusDays(3), minAmountUsd: 100,
};

function input(over: Partial<RewardEligibilityInput> = {}): RewardEligibilityInput {
  return {
    now: NOW,
    amountUsd: 200,
    standardFeeUsd: 1.99,
    catalog: catalog(),
    settings: { nth_transfer: NTH5, festival: undefined },
    usage: { deliveredThisMonth: 4, activeThisMonth: { nth_transfer: 0, festival: 0 } },
    ...over,
  };
}

describe('rewards engine — nth transfer in a month', () => {
  it('the 5th transfer (4 delivered this month) qualifies; the 4th and 6th do not', () => {
    expect(qualifies('nth_transfer', input())).toBe(true);
    expect(qualifies('nth_transfer', input({ usage: { deliveredThisMonth: 3, activeThisMonth: { nth_transfer: 0, festival: 0 } } }))).toBe(false);
    expect(qualifies('nth_transfer', input({ usage: { deliveredThisMonth: 5, activeThisMonth: { nth_transfer: 1, festival: 0 } } }))).toBe(false);
  });

  it('a 5th already rewarded (a reward held by an unpaid or delivered transfer) is not given twice', () => {
    expect(qualifies('nth_transfer', input({ usage: { deliveredThisMonth: 4, activeThisMonth: { nth_transfer: 1, festival: 0 } } }))).toBe(false);
  });

  it('the 10th qualifies again only when the cap allows a second reward this month', () => {
    const tenth = { deliveredThisMonth: 9, activeThisMonth: { nth_transfer: 1, festival: 0 } };
    expect(qualifies('nth_transfer', input({ usage: tenth }))).toBe(false); // cap 1
    expect(qualifies('nth_transfer', input({ usage: tenth, catalog: catalog({ nth_transfer: { customerMonthlyCap: 2 } }) }))).toBe(true);
  });

  it('off, not available, an N outside the admin range, or no fee to lower ⇒ no reward', () => {
    expect(qualifies('nth_transfer', input({ settings: { nth_transfer: { ...NTH5, enabled: false }, festival: undefined } }))).toBe(false);
    expect(qualifies('nth_transfer', input({ catalog: catalog({ nth_transfer: { available: false } }) }))).toBe(false);
    expect(qualifies('nth_transfer', input({ catalog: catalog({ nth_transfer: { nthMin: 6, nthMax: 10 } }) }))).toBe(false);
    expect(qualifies('nth_transfer', input({ standardFeeUsd: 0 }))).toBe(false);
    expect(qualifies('nth_transfer', input({ settings: { nth_transfer: undefined, festival: undefined } }))).toBe(false);
  });
});

describe('rewards engine — festival offer', () => {
  const fest = (o: Partial<RewardEligibilityInput> = {}) =>
    input({ settings: { nth_transfer: undefined, festival: DIWALI }, usage: { deliveredThisMonth: 0, activeThisMonth: { nth_transfer: 0, festival: 0 } }, ...o });

  it('inside its dates and at or above the minimum ⇒ qualifies', () => {
    expect(qualifies('festival', fest())).toBe(true);
    expect(qualifies('festival', fest({ amountUsd: 100 }))).toBe(true);
  });

  it('below the minimum, before or after its dates, a name not on the admin list, or longer than the admin limit ⇒ no', () => {
    expect(qualifies('festival', fest({ amountUsd: 99.99 }))).toBe(false);
    expect(qualifies('festival', fest({ settings: { nth_transfer: undefined, festival: { ...DIWALI, startsOn: plusDays(1) } } }))).toBe(false);
    expect(qualifies('festival', fest({ settings: { nth_transfer: undefined, festival: { ...DIWALI, endsOn: plusDays(-1), startsOn: plusDays(-3) } } }))).toBe(false);
    expect(qualifies('festival', fest({ settings: { nth_transfer: undefined, festival: { ...DIWALI, festivalName: 'Pongal' } } }))).toBe(false);
    expect(qualifies('festival', fest({ settings: { nth_transfer: undefined, festival: { ...DIWALI, startsOn: plusDays(-10), endsOn: plusDays(10) } } }))).toBe(false);
  });

  it('the festival day bounds are inclusive (today is the last day)', () => {
    expect(qualifies('festival', fest({ settings: { nth_transfer: undefined, festival: { ...DIWALI, startsOn: today, endsOn: today } } }))).toBe(true);
  });

  it('the customer monthly cap stops a second festival reward', () => {
    expect(qualifies('festival', fest({ usage: { deliveredThisMonth: 0, activeThisMonth: { nth_transfer: 0, festival: 1 } } }))).toBe(false);
  });
});

describe('pickReward — one reward per transfer, the fee only, never below $0', () => {
  it('festival before loyalty when both qualify; one reward only', () => {
    const r = pickReward(input({ settings: { nth_transfer: NTH5, festival: DIWALI } }));
    expect(r).toEqual({ kind: 'festival', discountUsd: 1.99, detail: { festivalName: 'Diwali' } });
  });

  it('a bank fee is waived in full ($1.99 ⇒ $0 floor)', () => {
    expect(pickReward(input())).toEqual({ kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } });
  });

  it('a card fee: the reward takes off at most the admin limit, so the % part above it is still charged', () => {
    // credit card on $200: 2.99 + 3% = 8.99; the limit is $2.99
    const r = pickReward(input({ standardFeeUsd: 8.99 }));
    expect(r?.discountUsd).toBe(2.99);
    // a limit above the fee never takes the fee below $0
    const big = pickReward(input({ standardFeeUsd: 1.99, catalog: catalog({ nth_transfer: { maxDiscountUsd: 50 } }) }));
    expect(big?.discountUsd).toBe(1.99);
  });

  it('nothing qualifies ⇒ null', () => {
    expect(pickReward(input({ usage: { deliveredThisMonth: 0, activeThisMonth: { nth_transfer: 0, festival: 0 } } }))).toBeNull();
  });

  it('a $0 admin limit gives no reward (nothing would be taken off)', () => {
    expect(pickReward(input({ catalog: catalog({ nth_transfer: { maxDiscountUsd: 0 } }) }))).toBeNull();
  });
});

describe('give-back and the partner budget', () => {
  it('give-back is the percentage of the discount, in cents', () => {
    expect(giveBackFor(1.99, 40)).toBe(0.8);
    expect(giveBackFor(2.99, 40)).toBe(1.2);
    expect(giveBackFor(1.99, 0)).toBe(0);
  });

  it('a $0 budget allows nothing (no SmartRemit-funded reward until the admin sets one)', () => {
    expect(DEFAULT_TERMS).toEqual({ platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 0 });
    expect(budgetAllows(DEFAULT_TERMS, 0, 0.8)).toBe(false);
    expect(budgetAllows({ ...DEFAULT_TERMS, monthlyBudgetUsd: 0.8 }, 0, 0.8)).toBe(true);
    expect(budgetAllows({ ...DEFAULT_TERMS, monthlyBudgetUsd: 1.59 }, 0.8, 0.8)).toBe(false);
    expect(budgetAllows({ ...DEFAULT_TERMS, monthlyBudgetUsd: 1.6 }, 0.8, 0.8)).toBe(true);
  });
});

describe('customer-facing lines (SmartRemit wording)', () => {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  it('bot fee line', () => {
    expect(rewardFeeLine({ kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } }, 0, '$0.00', '$1.99'))
      .toBe('Fee $0.00, your 5th transfer this month is free (you save $1.99).');
    expect(rewardFeeLine({ kind: 'nth_transfer', discountUsd: 2.99, detail: { nth: 3 } }, 6, '$6.00', '$2.99'))
      .toBe('Fee $6.00, a reward for your 3rd transfer this month (you save $2.99).');
    expect(rewardFeeLine({ kind: 'festival', discountUsd: 1.99, detail: { festivalName: 'Diwali' } }, 0, '$0.00', '$1.99'))
      .toBe('Fee $0.00, Diwali offer (you save $1.99).');
  });
  it('receipt line', () => {
    expect(rewardReceiptLine({ kind: 'first_transfer', discountUsd: 1.99, detail: {} }, usd)).toBe('Reward: first transfer free (saved $1.99).');
    expect(rewardReceiptLine({ kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } }, usd)).toBe('Reward: 5th transfer this month (saved $1.99).');
    expect(rewardReceiptLine({ kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 2 } }, usd)).toBe('Reward: 2nd transfer this month (saved $1.99).');
    expect(rewardReceiptLine({ kind: 'festival', discountUsd: 2.99, detail: { festivalName: 'Holi' } }, usd)).toBe('Reward: Holi offer (saved $2.99).');
  });
});
