import { describe, it, expect } from 'vitest';
import {
  isAbandoned,
  summarize,
  needsAttention,
  ABANDONED_THRESHOLD_MS,
} from '@/lib/dashboard';
import type { Transfer } from '@/lib/types';

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    id: overrides.id,
    phone: '15551234567',
    amountUsd: 100,
    feeUsd: 2.5,
    totalChargeUsd: 102.5,
    fxRate: 85,
    amountInr: 8500,
    recipientName: 'Test User',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'test@upi',
    fundingMethod: 'credit_card',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// Use a fixed "now" in Eastern time so tests are timezone-independent.
// 2026-05-21T14:00:00Z is 10:00 AM Eastern (UTC-4, EDT)
const NOW = Date.parse('2026-05-21T14:00:00.000Z');
// createdAt "today" in Eastern time: 2026-05-21T12:00:00Z → 8 AM EDT
const TODAY_ISO = '2026-05-21T12:00:00.000Z';
// createdAt "yesterday" in Eastern time: 2026-05-20T12:00:00Z
const YESTERDAY_ISO = '2026-05-20T12:00:00.000Z';

describe('isAbandoned', () => {
  it('returns true when awaiting_payment and past threshold', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({ id: 'a1', createdAt: new Date(old).toISOString() });
    expect(isAbandoned(t, NOW)).toBe(true);
  });

  it('returns false when awaiting_payment but within threshold', () => {
    const recent = NOW - ABANDONED_THRESHOLD_MS + 1000;
    const t = makeTransfer({
      id: 'a2',
      createdAt: new Date(recent).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });

  it('returns false for paid status even if old', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({
      id: 'a3',
      status: 'paid',
      createdAt: new Date(old).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });

  it('returns false for delivered status even if old', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({
      id: 'a4',
      status: 'delivered',
      createdAt: new Date(old).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });

  it('returns false for cancelled status even if old', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({
      id: 'a5',
      status: 'cancelled',
      createdAt: new Date(old).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });
});

describe('summarize', () => {
  it('counts only today transfers for countToday', () => {
    const transfers = [
      makeTransfer({ id: 's1', createdAt: TODAY_ISO }),
      makeTransfer({ id: 's2', createdAt: TODAY_ISO }),
      makeTransfer({ id: 's3', createdAt: YESTERDAY_ISO }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.countToday).toBe(2);
  });

  it('sums volumeToday for all of today regardless of status', () => {
    const transfers = [
      makeTransfer({ id: 'v1', createdAt: TODAY_ISO, amountUsd: 100 }),
      makeTransfer({ id: 'v2', createdAt: TODAY_ISO, amountUsd: 200, status: 'paid' }),
      makeTransfer({ id: 'v3', createdAt: YESTERDAY_ISO, amountUsd: 50 }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.volumeToday).toBe(300);
  });

  it('sums commissionToday only for paid/delivered transfers today', () => {
    const transfers = [
      // awaiting — should NOT count
      makeTransfer({ id: 'c1', createdAt: TODAY_ISO, feeUsd: 1.0, status: 'awaiting_payment' }),
      // paid today — should count
      makeTransfer({ id: 'c2', createdAt: TODAY_ISO, feeUsd: 2.5, status: 'paid' }),
      // delivered today — should count
      makeTransfer({ id: 'c3', createdAt: TODAY_ISO, feeUsd: 3.0, status: 'delivered' }),
      // cancelled today — should NOT count
      makeTransfer({ id: 'c4', createdAt: TODAY_ISO, feeUsd: 5.0, status: 'cancelled' }),
      // paid yesterday — should NOT count for today
      makeTransfer({ id: 'c5', createdAt: YESTERDAY_ISO, feeUsd: 10.0, status: 'paid' }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.commissionToday).toBe(5.5);
  });

  it('sums commissionAllTime for paid/delivered across all days', () => {
    const transfers = [
      makeTransfer({ id: 'at1', createdAt: TODAY_ISO, feeUsd: 2.5, status: 'paid' }),
      makeTransfer({ id: 'at2', createdAt: YESTERDAY_ISO, feeUsd: 10.0, status: 'delivered' }),
      makeTransfer({ id: 'at3', createdAt: YESTERDAY_ISO, feeUsd: 5.0, status: 'awaiting_payment' }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.commissionAllTime).toBe(12.5);
  });

  it('counts needsAttention as abandoned awaiting_payment transfers', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const recent = NOW - ABANDONED_THRESHOLD_MS + 1000;
    const transfers = [
      // old and awaiting — should count
      makeTransfer({ id: 'n1', createdAt: new Date(old).toISOString(), status: 'awaiting_payment' }),
      // old and awaiting — should count
      makeTransfer({ id: 'n2', createdAt: new Date(old).toISOString(), status: 'awaiting_payment' }),
      // recent and awaiting — should NOT count
      makeTransfer({ id: 'n3', createdAt: new Date(recent).toISOString(), status: 'awaiting_payment' }),
      // old but paid — should NOT count
      makeTransfer({ id: 'n4', createdAt: new Date(old).toISOString(), status: 'paid' }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.needsAttention).toBe(2);
  });

  it('rounds money to 2 decimal places', () => {
    const transfers = [
      makeTransfer({ id: 'r1', createdAt: TODAY_ISO, feeUsd: 1.005, status: 'paid' }),
      makeTransfer({ id: 'r2', createdAt: TODAY_ISO, feeUsd: 1.004, status: 'paid' }),
    ];
    const summary = summarize(transfers, NOW);
    // 1.005 + 1.004 = 2.009 → Math.round(200.9) / 100 = 2.01
    expect(summary.commissionToday).toBe(2.01);
  });

  it('returns zeros for empty transfers list', () => {
    const summary = summarize([], NOW);
    expect(summary.commissionToday).toBe(0);
    expect(summary.volumeToday).toBe(0);
    expect(summary.countToday).toBe(0);
    expect(summary.needsAttention).toBe(0);
    expect(summary.commissionAllTime).toBe(0);
  });

  it('returns a numeric flaggedToday field', () => {
    const transfers = [
      makeTransfer({ id: 'f1', createdAt: TODAY_ISO, complianceStatus: 'flagged' }),
      makeTransfer({ id: 'f2', createdAt: TODAY_ISO, complianceStatus: 'blocked', status: 'blocked' }),
      makeTransfer({ id: 'f3', createdAt: TODAY_ISO, complianceStatus: 'cleared' }),
      makeTransfer({ id: 'f4', createdAt: YESTERDAY_ISO, complianceStatus: 'flagged' }),
    ];
    const summary = summarize(transfers, NOW);
    expect(typeof summary.flaggedToday).toBe('number');
    expect(summary.flaggedToday).toBe(2);
  });
});

describe('needsAttention', () => {
  const baseNow = Date.parse('2026-05-21T16:00:00.000Z');
  function t(overrides: Partial<Transfer>): Transfer {
    return {
      id: 'x', phone: 'p', amountUsd: 100, feeUsd: 0, totalChargeUsd: 100,
      fxRate: 85, amountInr: 8500, recipientName: 'R', recipientPhone: '91999',
      payoutMethod: 'upi', payoutDestination: 'r@upi', fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared', complianceReasons: [],
      status: 'awaiting_payment', createdAt: new Date(baseNow).toISOString(),
      ...overrides,
    };
  }

  it('is false for a fresh cleared transfer', () => {
    expect(needsAttention(t({}), baseNow)).toBe(false);
  });
  it('is true for a flagged transfer', () => {
    expect(needsAttention(t({ complianceStatus: 'flagged' }), baseNow)).toBe(true);
  });
  it('is true for a blocked transfer', () => {
    expect(needsAttention(t({ complianceStatus: 'blocked', status: 'blocked' }), baseNow)).toBe(true);
  });
  it('is true for an abandoned (old awaiting_payment) transfer', () => {
    const old = baseNow - 60 * 60 * 1000;
    expect(needsAttention(t({ createdAt: new Date(old).toISOString() }), baseNow)).toBe(true);
  });
});

import {
  nextDueAt,
  schedulesDueInRange,
  topVelocityToday,
} from '@/lib/dashboard';
import type { Schedule } from '@/lib/types';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's',
    phone: 'p',
    amountUsd: 100,
    recipientName: 'R',
    recipientPhone: '91999',
    payoutMethod: 'upi',
    payoutDestination: 'r@upi',
    fundingMethod: 'bank_transfer',
    frequency: 'monthly',
    dayOfMonth: 5,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('nextDueAt', () => {
  // Pick a fixed moment: Friday May 22, 2026 17:00 UTC (~ noon ET, weekday 5 = Fri)
  const NOW = Date.parse('2026-05-22T17:00:00.000Z');

  it('monthly: next due is this month if day is today or later', () => {
    expect(nextDueAt(makeSchedule({ dayOfMonth: 28 }), NOW))
      .toBe(new Date(2026, 4, 28).getTime());
  });

  it('monthly: jumps to next month if day already passed', () => {
    expect(nextDueAt(makeSchedule({ dayOfMonth: 2 }), NOW))
      .toBe(new Date(2026, 5, 2).getTime());
  });

  it('weekly: due today when dayOfWeek matches today', () => {
    const s = makeSchedule({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 5 });
    const start = new Date(NOW);
    start.setHours(0, 0, 0, 0);
    expect(nextDueAt(s, NOW)).toBe(start.getTime());
  });

  it('weekly: due next occurrence when later in week', () => {
    const s = makeSchedule({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 1 });
    // From Fri (5), next Mon (1) is 3 days away
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    const expected = new Date(today); expected.setDate(today.getDate() + 3);
    expect(nextDueAt(s, NOW)).toBe(expected.getTime());
  });

  it('weekly: pushes to next week when lastRunAt is today', () => {
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    const s = makeSchedule({
      frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 5,
      lastRunAt: today.toISOString(),
    });
    expect(nextDueAt(s, NOW)).toBe(today.getTime() + 7 * 86400000);
  });
});

describe('schedulesDueInRange', () => {
  const NOW = Date.parse('2026-05-22T17:00:00.000Z');

  it('returns only active schedules whose next due is within N days, sorted soonest first', () => {
    const a = makeSchedule({ id: 'a', dayOfMonth: 23 }); // tomorrow
    const b = makeSchedule({ id: 'b', dayOfMonth: 28 }); // 6 days
    const c = makeSchedule({ id: 'c', dayOfMonth: 1 });  // next month → 10 days
    const cancelled = makeSchedule({ id: 'd', dayOfMonth: 23, status: 'cancelled' });
    const result = schedulesDueInRange([cancelled, c, b, a], NOW, 7).map((s) => s.id);
    expect(result).toEqual(['a', 'b']); // c is out of range; cancelled excluded
  });

  it('returns empty when nothing is due in the window', () => {
    const farOff = makeSchedule({ dayOfMonth: 1 }); // ~10 days
    expect(schedulesDueInRange([farOff], NOW, 3)).toEqual([]);
  });
});

describe('topVelocityToday', () => {
  // Use the test-environment timezone; build createdAt from start-of-today.
  const NOW = Date.now();
  const todayIso = new Date(NOW).toISOString();
  const yesterdayIso = new Date(NOW - 36 * 60 * 60 * 1000).toISOString();

  function t(id: string, phone: string, createdAt: string): import('@/lib/types').Transfer {
    return {
      id, phone, amountUsd: 100, feeUsd: 0, totalChargeUsd: 100,
      fxRate: 85, amountInr: 8500,
      recipientName: 'r', recipientPhone: '91999',
      payoutMethod: 'upi', payoutDestination: 'r@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared', complianceReasons: [],
      status: 'awaiting_payment', createdAt,
    };
  }

  it('groups today transfers by phone and returns top N', () => {
    const transfers = [
      t('1', 'pA', todayIso),
      t('2', 'pA', todayIso),
      t('3', 'pA', todayIso),
      t('4', 'pB', todayIso),
      t('5', 'pB', todayIso),
      t('6', 'pC', todayIso),
      t('7', 'pD', yesterdayIso), // excluded — not today
    ];
    expect(topVelocityToday(transfers, NOW, 10)).toEqual([
      { phone: 'pA', count: 3 },
      { phone: 'pB', count: 2 },
      { phone: 'pC', count: 1 },
    ]);
  });

  it('respects the limit', () => {
    const transfers = [
      t('1', 'pA', todayIso),
      t('2', 'pB', todayIso),
      t('3', 'pC', todayIso),
    ];
    expect(topVelocityToday(transfers, NOW, 2)).toHaveLength(2);
  });

  it('returns empty array when no transfers today', () => {
    expect(topVelocityToday([t('1', 'pA', yesterdayIso)], NOW, 5)).toEqual([]);
  });
});
