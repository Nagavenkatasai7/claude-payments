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

describe('buildDateBuckets DST spring-forward (regression: off-by-one on 2026-03-09)', () => {
  // 2026-03-08 is the spring-forward day: clocks jump from 02:00 to 03:00 ET,
  // making the ET day only 23 hours long.  Subtracting multiples of DAY_MS (24h)
  // in UTC-ms can land in the wrong calendar day around that boundary.
  //
  // Test: call dailyCounts with now = 2026-03-09T04:30:00Z (00:30 AM ET,
  // the morning after spring-forward). The 7-bucket list must include 3/8/2026
  // (spring-forward day) and must NOT reach back to 3/2/2026.
  it('includes the spring-forward day (3/8/2026) and does not skip it', () => {
    // 04:30 UTC on 2026-03-09 = 00:30 AM ET (spring forward happened at 07:00 UTC = 02:00 ET→03:00 ET)
    const springForwardMorning = Date.parse('2026-03-09T04:30:00Z');
    const result = dailyCounts([], springForwardMorning, 7);
    const dates = result.map((b) => b.date);
    expect(dates).toContain('3/8/2026');  // spring-forward day must be present
    expect(dates).not.toContain('3/2/2026'); // window must not extend back an extra day
    expect(dates).toHaveLength(7);
    // The last bucket must be today in ET
    expect(dates[dates.length - 1]).toBe('3/9/2026');
    // The first bucket must be exactly 6 days before today
    expect(dates[0]).toBe('3/3/2026');
  });

  it('includes the fall-back day (2025-11-02) correctly (non-regression, 25-hour day)', () => {
    // 2025-11-02 is fall-back day. 05:00 UTC = 00:00 AM ET. A 7-bucket window
    // starting here must include 11/2/2025 and reach back to 10/27/2025.
    const fallbackMorning = Date.parse('2025-11-02T05:30:00Z'); // 00:30 AM ET post-fallback
    const result = dailyCounts([], fallbackMorning, 7);
    const dates = result.map((b) => b.date);
    expect(dates).toContain('11/2/2025');
    expect(dates).not.toContain('10/26/2025'); // must not reach back 8 days
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('10/27/2025');
    expect(dates[dates.length - 1]).toBe('11/2/2025');
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
