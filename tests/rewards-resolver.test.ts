import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveQuoteReward, rewardsActive, type RewardStore } from '@/lib/rewards/resolver';
import { DEFAULT_CATALOG } from '@/lib/rewards/settings';
import type { RewardQuoteFacts } from '@/lib/store';

// B3 rewards v1: the quote-time resolver. Demo mode AND the switch; fails
// closed (no discount) on any read error; first transfer free is only named.

const PHONE = '15556660001';
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.DEMO_PHONES;
  process.env.DEMO_PHONES = '*';
});
afterEach(() => {
  if (saved === undefined) delete process.env.DEMO_PHONES;
  else process.env.DEMO_PHONES = saved;
});

function facts(over: Partial<RewardQuoteFacts> = {}): RewardQuoteFacts {
  return {
    catalog: { nth_transfer: { ...DEFAULT_CATALOG.nth_transfer, available: true }, festival: DEFAULT_CATALOG.festival },
    settings: { nth_transfer: { kind: 'nth_transfer', enabled: true, nth: 5 }, festival: undefined },
    terms: { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 100 },
    usage: { deliveredThisMonth: 4, activeThisMonth: { nth_transfer: 0, festival: 0 } },
    budgetUsedUsd: 0,
    ...over,
  };
}

function store(o: { on?: boolean; flagThrows?: boolean; facts?: RewardQuoteFacts; factsThrow?: boolean } = {}): RewardStore {
  return {
    isFlagOn: vi.fn(async () => {
      if (o.flagThrows) throw new Error('flag read');
      return o.on ?? true;
    }),
    rewardQuoteFacts: vi.fn(async () => {
      if (o.factsThrow) throw new Error('db down');
      return o.facts ?? facts();
    }),
  };
}

const args = { partnerId: 'default', phone: PHONE, amountUsd: 200, fundingMethod: 'bank_transfer' as const, transferCount: 4 };

describe('resolveQuoteReward', () => {
  it('a qualifying 5th transfer ⇒ the reward and the fee discount for quote()', async () => {
    expect(await resolveQuoteReward(store(), args)).toEqual({
      reward: { kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 } },
      pricing: { feeDiscountUsd: 1.99 },
    });
  });

  it('switch off, switch unreadable, not a demo phone ⇒ no reward (fails closed)', async () => {
    expect(await resolveQuoteReward(store({ on: false }), args)).toBeNull();
    expect(await resolveQuoteReward(store({ flagThrows: true }), args)).toBeNull();
    process.env.DEMO_PHONES = '15550000000';
    const s = store();
    expect(await resolveQuoteReward(s, args)).toBeNull();
    expect(s.isFlagOn).not.toHaveBeenCalled();
  });

  it('a facts read error ⇒ no reward, never a throw', async () => {
    expect(await resolveQuoteReward(store({ factsThrow: true }), args)).toBeNull();
  });

  it('the partner budget is spent ⇒ no reward', async () => {
    expect(await resolveQuoteReward(store({ facts: facts({ budgetUsedUsd: 99.5 }) }), args)).toBeNull();
    expect(await resolveQuoteReward(store({ facts: facts({ terms: { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 0 } }) }), args)).toBeNull();
  });

  it('first transfer: named (fee already $0 by today’s rule), no pricing input, no facts read', async () => {
    const s = store();
    expect(await resolveQuoteReward(s, { ...args, transferCount: 0 })).toEqual({
      reward: { kind: 'first_transfer', discountUsd: 1.99, detail: {} },
    });
    expect(s.rewardQuoteFacts).not.toHaveBeenCalled();
  });

  it('sandbox and B2B quotes never carry a reward', async () => {
    const s = store();
    expect(await resolveQuoteReward(s, { ...args, environment: 'test' })).toBeNull();
    expect(await resolveQuoteReward(s, { ...args, transferType: 'b2b' })).toBeNull();
    expect(s.isFlagOn).not.toHaveBeenCalled();
  });

  it('rewardsActive reads the switch for the tenant only', async () => {
    const s = store();
    expect(await rewardsActive(s, 'acme', PHONE)).toBe(true);
    expect(s.isFlagOn).toHaveBeenCalledWith('rewards.enabled', { partnerId: 'acme' });
  });
});
