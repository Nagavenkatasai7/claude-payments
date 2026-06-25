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

// ── Regression: bug-hunt fix #2 ─────────────────────────────────────────────
describe('buildDateBuckets (via dailyCounts) — DST spring-forward must not skip a day', () => {
  // 2026-03-09T04:00:00Z = midnight ET on March 9, the first full EDT day after
  // spring-forward. With the old fixed-ms loop, now - 1*86_400_000 lands at
  // 2026-03-08T04:00:00Z = 11 PM ET on March 7 (because March 8 is 23 h long),
  // so easternDate() returns '3/7/2026', not '3/8/2026'. That makes the bucket
  // list skip March 8 entirely and silently drop any transactions on that date.
  it('produces 7 consecutive calendar days including the DST spring-forward day (3/8/2026)', () => {
    // now = midnight EDT on March 9 (just after spring-forward)
    const now = Date.parse('2026-03-09T04:00:00Z');
    const result = dailyCounts([], now, 7);
    const dates = result.map((b) => b.date);
    expect(dates).toHaveLength(7);
    // Before the fix: 3/8 was skipped entirely.
    // After the fix: all 7 days 3/3–3/9 are present (3/7 and 3/8 both appear).
    expect(dates).toContain('3/8/2026');  // the skipped day before the fix
    expect(dates).toContain('3/7/2026');  // correctly present (2 days before March 9)
    // All 7 dates must be distinct
    expect(new Set(dates).size).toBe(7);
    // Confirm the expected contiguous range
    expect(dates).toEqual(['3/3/2026','3/4/2026','3/5/2026','3/6/2026','3/7/2026','3/8/2026','3/9/2026']);
  });

  it('last bucket date matches today for the DST reference point', () => {
    const now = Date.parse('2026-03-09T04:00:00Z');
    const result = dailyCounts([], now, 7);
    const lastDate = result[result.length - 1].date;
    expect(lastDate).toBe('3/9/2026');
  });

  it('a transfer on the spring-forward day is counted in its bucket', () => {
    const now = Date.parse('2026-03-09T04:00:00Z');
    // 2026-03-08T12:00:00-05:00 = noon ET on March 8 (DST transition day)
    const t = [makeTransfer({ id: 'dst', createdAt: '2026-03-08T17:00:00Z' })]; // noon ET March 8
    const result = dailyCounts(t, now, 7);
    const march8 = result.find((b) => b.date === '3/8/2026');
    expect(march8).toBeDefined();
    expect(march8!.count).toBe(1);
  });

  it('fall-back (DST end, 25-hour day) does not duplicate a day', () => {
    // 2026-11-02T04:00:00Z = midnight EST on Nov 2, the first full EST day after fall-back
    const now = Date.parse('2026-11-02T05:00:00Z');
    const result = dailyCounts([], now, 7);
    const dates = result.map((b) => b.date);
    expect(new Set(dates).size).toBe(7);
    expect(dates).toContain('11/1/2026');
  });
});
