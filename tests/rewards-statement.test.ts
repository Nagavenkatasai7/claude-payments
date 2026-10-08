import { describe, it, expect } from 'vitest';
import { computeStatement, statementMonth } from '@/lib/rewards/statement';
import type { StatementFacts } from '@/db/repos/reward-repo';

// B3 rewards v1: the monthly statement per partner. Fee owed, rewards given,
// give-back credit (the percentage, up to the budget) and net. Statement only.

const TERMS = { platformFeeUsd: 0.6, giveBackPct: 40, monthlyBudgetUsd: 100 };

function facts(over: Partial<StatementFacts> = {}): StatementFacts {
  return { partnerId: 'acme', deliveredCount: 0, feeOwedUsd: 0, rewards: [], ...over };
}

describe('computeStatement', () => {
  it('no activity ⇒ zeros', () => {
    expect(computeStatement('2026-10', facts(), TERMS)).toEqual({
      month: '2026-10', partnerId: 'acme', deliveredCount: 0, feeOwedUsd: 0,
      firstTransferFree: { count: 0, usd: 0 },
      rewardsGiven: { count: 0, usd: 0 },
      withheld: { count: 0, usd: 0 },
      giveBackEarnedUsd: 0, budgetUsd: 100, giveBackCreditUsd: 0, netUsd: 0,
    });
  });

  it('fee owed minus the give-back credit; withheld and first-transfer rewards earn no credit', () => {
    const s = computeStatement('2026-10', facts({
      deliveredCount: 1000,
      feeOwedUsd: 600,
      rewards: [
        { kind: 'nth_transfer', withheld: false, count: 100, discountUsd: 199, giveBackUsd: 80 },
        { kind: 'festival', withheld: false, count: 10, discountUsd: 29.9, giveBackUsd: 12 },
        { kind: 'nth_transfer', withheld: true, count: 2, discountUsd: 3.98, giveBackUsd: 0 },
        { kind: 'first_transfer', withheld: false, count: 50, discountUsd: 99.5, giveBackUsd: 0 },
      ],
    }), { ...TERMS, monthlyBudgetUsd: 500 });
    expect(s.rewardsGiven).toEqual({ count: 112, usd: 232.88 });
    expect(s.withheld).toEqual({ count: 2, usd: 3.98 });
    expect(s.firstTransferFree).toEqual({ count: 50, usd: 99.5 });
    expect(s.giveBackEarnedUsd).toBe(92);
    expect(s.giveBackCreditUsd).toBe(92);
    expect(s.netUsd).toBe(508);
  });

  it('the give-back credit never exceeds the monthly budget (a budget lowered after the rewards)', () => {
    const s = computeStatement('2026-10', facts({
      deliveredCount: 100, feeOwedUsd: 60,
      rewards: [{ kind: 'nth_transfer', withheld: false, count: 100, discountUsd: 199, giveBackUsd: 80 }],
    }), { ...TERMS, monthlyBudgetUsd: 25 });
    expect(s.giveBackEarnedUsd).toBe(80);
    expect(s.giveBackCreditUsd).toBe(25);
    expect(s.netUsd).toBe(35);
  });

  it('a credit larger than the fee owed gives a negative net (SmartRemit owes the partner)', () => {
    const s = computeStatement('2026-10', facts({
      deliveredCount: 10, feeOwedUsd: 6,
      rewards: [{ kind: 'festival', withheld: false, count: 10, discountUsd: 29.9, giveBackUsd: 12 }],
    }), TERMS);
    expect(s.netUsd).toBe(-6);
  });

  it('sums in cents (no float drift)', () => {
    const s = computeStatement('2026-10', facts({
      feeOwedUsd: 0.3,
      rewards: [
        { kind: 'nth_transfer', withheld: false, count: 1, discountUsd: 0.1, giveBackUsd: 0.1 },
        { kind: 'festival', withheld: false, count: 1, discountUsd: 0.2, giveBackUsd: 0.2 },
      ],
    }), TERMS);
    expect(s.rewardsGiven.usd).toBe(0.3);
    expect(s.netUsd).toBe(0);
  });

  it('statementMonth: a valid YYYY-MM is kept, anything else is the current ET month', () => {
    expect(statementMonth('2026-09', new Date('2026-10-08T12:00:00Z'))).toBe('2026-09');
    expect(statementMonth('2026-13', new Date('2026-10-08T12:00:00Z'))).toBe('2026-10');
    expect(statementMonth(undefined, new Date('2026-10-08T12:00:00Z'))).toBe('2026-10');
    expect(statementMonth("2026-09'; drop", new Date('2026-10-08T12:00:00Z'))).toBe('2026-10');
  });
});
