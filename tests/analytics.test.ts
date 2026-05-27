import { describe, it, expect } from 'vitest';
import {
  transfersInWindow,
  dailyCounts,
  dailyVolume,
  dailyCommission,
  statusDistribution,
  complianceDistribution,
  fundingMethodMix,
  topRecipientsByCount,
  WINDOW_DAYS,
} from '@/lib/analytics';
import type { Transfer } from '@/lib/types';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-05-23T16:00:00.000Z');

function makeTransfer(overrides: Partial<Transfer>): Transfer {
  return {
    id: 't',
    phone: 'p',
    amountUsd: 100,
    feeUsd: 5,
    totalChargeUsd: 105,
    fxRate: 85,
    amountInr: 8500,
    recipientName: 'R',
    recipientPhone: '91999',
    payoutMethod: 'upi',
    payoutDestination: 'r@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'delivered',
    createdAt: new Date(NOW).toISOString(),
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    ...overrides,
  };
}

describe('WINDOW_DAYS', () => {
  it('exports the three supported windows', () => {
    expect(WINDOW_DAYS).toEqual([7, 30, 90]);
  });
});

describe('transfersInWindow', () => {
  it('includes transfers within the window', () => {
    const t = [
      makeTransfer({ id: 'a', createdAt: new Date(NOW - 1 * DAY_MS).toISOString() }),
      makeTransfer({ id: 'b', createdAt: new Date(NOW - 5 * DAY_MS).toISOString() }),
      makeTransfer({ id: 'c', createdAt: new Date(NOW - 10 * DAY_MS).toISOString() }),
    ];
    expect(transfersInWindow(t, NOW, 7).map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
});

describe('dailyCounts', () => {
  it('zero-fills empty days and groups by eastern date', () => {
    const t = [
      makeTransfer({ id: 'a', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'b', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'c', createdAt: new Date(NOW - 2 * DAY_MS).toISOString() }),
    ];
    const result = dailyCounts(t, NOW, 3);
    expect(result).toHaveLength(3);
    // Oldest first
    expect(result[0].count).toBe(1); // 2 days ago
    expect(result[1].count).toBe(0); // 1 day ago
    expect(result[2].count).toBe(2); // today
  });

  it('returns zero buckets when no transfers', () => {
    const result = dailyCounts([], NOW, 5);
    expect(result.map((b) => b.count)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('dailyVolume', () => {
  it('sums amountUsd per day, rounded to cents', () => {
    const t = [
      makeTransfer({ id: 'a', amountUsd: 100, createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'b', amountUsd: 250.5, createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'c', amountUsd: 75, createdAt: new Date(NOW - 1 * DAY_MS).toISOString() }),
    ];
    const result = dailyVolume(t, NOW, 2);
    expect(result[0].volumeUsd).toBe(75);
    expect(result[1].volumeUsd).toBe(350.5);
  });
});

describe('dailyCommission', () => {
  it('only counts feeUsd of paid/delivered transfers', () => {
    const t = [
      makeTransfer({ id: 'a', feeUsd: 3, status: 'delivered', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'b', feeUsd: 2, status: 'paid', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'c', feeUsd: 9, status: 'cancelled', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'd', feeUsd: 9, status: 'awaiting_payment', createdAt: new Date(NOW).toISOString() }),
    ];
    const result = dailyCommission(t, NOW, 1);
    expect(result[0].commissionUsd).toBe(5);
  });
});

describe('statusDistribution', () => {
  it('groups by status sorted by count desc', () => {
    const t = [
      makeTransfer({ id: '1', status: 'delivered' }),
      makeTransfer({ id: '2', status: 'delivered' }),
      makeTransfer({ id: '3', status: 'paid' }),
      makeTransfer({ id: '4', status: 'cancelled' }),
    ];
    expect(statusDistribution(t)).toEqual([
      { status: 'delivered', count: 2 },
      { status: 'paid', count: 1 },
      { status: 'cancelled', count: 1 },
    ]);
  });

  it('returns empty array for no transfers', () => {
    expect(statusDistribution([])).toEqual([]);
  });
});

describe('complianceDistribution', () => {
  it('groups by complianceStatus sorted by count desc', () => {
    const t = [
      makeTransfer({ id: '1', complianceStatus: 'cleared' }),
      makeTransfer({ id: '2', complianceStatus: 'cleared' }),
      makeTransfer({ id: '3', complianceStatus: 'flagged' }),
    ];
    expect(complianceDistribution(t)).toEqual([
      { status: 'cleared', count: 2 },
      { status: 'flagged', count: 1 },
    ]);
  });
});

describe('fundingMethodMix', () => {
  it('groups by funding method sorted by count desc', () => {
    const t = [
      makeTransfer({ id: '1', fundingMethod: 'bank_transfer' }),
      makeTransfer({ id: '2', fundingMethod: 'bank_transfer' }),
      makeTransfer({ id: '3', fundingMethod: 'credit_card' }),
    ];
    expect(fundingMethodMix(t)).toEqual([
      { method: 'bank_transfer', count: 2 },
      { method: 'credit_card', count: 1 },
    ]);
  });
});

describe('topRecipientsByCount', () => {
  it('returns top N by count, sorted desc with name tiebreaker', () => {
    const t = [
      makeTransfer({ id: '1', recipientName: 'A' }),
      makeTransfer({ id: '2', recipientName: 'A' }),
      makeTransfer({ id: '3', recipientName: 'B' }),
      makeTransfer({ id: '4', recipientName: 'C' }),
    ];
    expect(topRecipientsByCount(t, 2)).toEqual([
      { name: 'A', count: 2 },
      { name: 'B', count: 1 },
    ]);
  });
});
