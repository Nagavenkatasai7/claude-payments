import { describe, it, expect } from 'vitest';
import { isScheduleDueToday, upcomingDueDay } from '@/lib/schedule';
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
    sourceCurrency: 'USD',
    amountSource: 100,
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
  it('paused schedules are never due (Program-Fix 36: only active fires)', () => {
    expect(isScheduleDueToday(sched({ status: 'paused' }), NOW)).toBe(false);
  });
  it('not due again if it already ran today', () => {
    expect(isScheduleDueToday(
      sched({ lastRunAt: new Date(NOW).toISOString() }), NOW,
    )).toBe(false);
  });
});

// Early sender-name warning: the first due day 1..N days AFTER today (Eastern),
// as the instant of Eastern noon on that day, or null.
describe('upcomingDueDay', () => {
  const etDay = (ms: number | null) =>
    ms === null ? null : new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  it('monthly: a run due in 2 days is found within 3', () => {
    expect(etDay(upcomingDueDay(sched({ dayOfMonth: 23 }), NOW, 3))).toBe('2026-05-23');
  });
  it('monthly: a run due in 3 days is found (inclusive)', () => {
    expect(etDay(upcomingDueDay(sched({ dayOfMonth: 24 }), NOW, 3))).toBe('2026-05-24');
  });
  it('monthly: a run due in 4 days is not found within 3', () => {
    expect(upcomingDueDay(sched({ dayOfMonth: 25 }), NOW, 3)).toBeNull();
  });
  it('today is not "upcoming" (the due-day path owns it)', () => {
    expect(upcomingDueDay(sched({ dayOfMonth: 21 }), NOW, 3)).toBeNull();
  });
  it('monthly: crosses a month end', () => {
    const may30 = Date.parse('2026-05-30T16:00:00.000Z');
    expect(etDay(upcomingDueDay(sched({ dayOfMonth: 1 }), may30, 3))).toBe('2026-06-01');
  });
  it('weekly: Thursday now, due Saturday (6)', () => {
    expect(etDay(upcomingDueDay(sched({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 6 }), NOW, 3))).toBe('2026-05-23');
  });
  it('weekly: due Monday (1) is 4 days out — not found within 3', () => {
    expect(upcomingDueDay(sched({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 1 }), NOW, 3)).toBeNull();
  });
  it('paused or cancelled schedules have no upcoming run', () => {
    expect(upcomingDueDay(sched({ dayOfMonth: 23, status: 'paused' }), NOW, 3)).toBeNull();
    expect(upcomingDueDay(sched({ dayOfMonth: 23, status: 'cancelled' }), NOW, 3)).toBeNull();
  });
  it('an end date before the due day means no upcoming run', () => {
    expect(upcomingDueDay(sched({ dayOfMonth: 23, endDate: '2026-05-22' }), NOW, 3)).toBeNull();
  });
  it('an end date on or after the due day keeps it', () => {
    expect(etDay(upcomingDueDay(sched({ dayOfMonth: 23, endDate: '2026-06-30' }), NOW, 3))).toBe('2026-05-23');
  });
  it('the day after a spring-forward DST change is found correctly', () => {
    const mar7 = Date.parse('2026-03-07T14:00:00.000Z'); // Sat Mar 7, 2026; DST starts Sun Mar 8
    expect(etDay(upcomingDueDay(sched({ dayOfMonth: 9 }), mar7, 3))).toBe('2026-03-09');
  });
});
