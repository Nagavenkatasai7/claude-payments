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
    amountSource: 100,
    feeSource: 5,
    totalChargeSource: 105,
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

describe('dailyCounts — DST spring-forward regression (bug-hunt)', () => {
  it('does NOT skip 3/8/2026 when now is the first hour of 3/9/2026 after spring-forward', () => {
    // 2026-03-09T04:30:00Z = 00:30 EDT (first half-hour after DST spring-forward)
    // The old buildDateBuckets subtracted 6*DAY_MS from now, landing at 2026-03-03T04:30Z
    // which is STILL 2026-03-02 in ET (00:30 EDT - 25h DST offset issue).
    // net effect: '3/8/2026' was absent, '3/9/2026' replaced it.
    const dstNow = Date.parse('2026-03-09T04:30:00Z');
    const transfer = makeTransfer({
      id: 'dst-transfer',
      createdAt: '2026-03-08T19:00:00.000Z', // 2 PM ET on 3/8 — clearly in the window
    });

    const result = dailyCounts([transfer], dstNow, 7);
    const dates = result.map((b) => b.date);
    // Must include 3/8 and NOT skip a day
    expect(dates).toContain('3/8/2026');
    // Must produce exactly 7 distinct buckets
    expect(new Set(dates).size).toBe(7);
    // The transfer must be counted
    const marchEighthBucket = result.find((b) => b.date === '3/8/2026');
    expect(marchEighthBucket?.count).toBe(1);
    // Total count must equal 1 (transfer not silently dropped)
    expect(result.reduce((s, b) => s + b.count, 0)).toBe(1);
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
