import { describe, it, expect } from 'vitest';
import { isScheduleDueToday } from '@/lib/schedule';
import type { Schedule } from '@/lib/types';

// 2026-05-21T16:00:00Z = Thursday May 21, 2026 (day-of-month 21, weekday 4).
const NOW = Date.parse('2026-05-21T16:00:00.000Z');

function sched(overrides: Partial<Schedule>): Schedule {
  return {
    id: 's', phone: 'p', amountUsd: 100,
    recipientName: 'R', recipientPhone: '91999',
    payoutMethod: 'upi', payoutDestination: 'r@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 21, status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    partnerId: 'default',
    ...overrides,
  };
}

describe('isScheduleDueToday', () => {
  it('monthly: due when dayOfMonth matches today', () => {
    expect(isScheduleDueToday(sched({ dayOfMonth: 21 }), NOW)).toBe(true);
  });
  it('monthly: not due on a different day', () => {
    expect(isScheduleDueToday(sched({ dayOfMonth: 5 }), NOW)).toBe(false);
  });
  it('weekly: due when dayOfWeek matches today', () => {
    expect(isScheduleDueToday(
      sched({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 4 }), NOW,
    )).toBe(true);
  });
  it('weekly: not due on a different weekday', () => {
    expect(isScheduleDueToday(
      sched({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 1 }), NOW,
    )).toBe(false);
  });
  it('cancelled schedules are never due', () => {
    expect(isScheduleDueToday(sched({ status: 'cancelled' }), NOW)).toBe(false);
  });
  it('not due again if it already ran today', () => {
    expect(isScheduleDueToday(
      sched({ lastRunAt: new Date(NOW).toISOString() }), NOW,
    )).toBe(false);
  });
});
