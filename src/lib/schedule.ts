import { easternDate, easternDayOfMonth, easternDayOfWeek, easternDayStart } from './dates';
import type { Schedule } from './types';

export function isScheduleDueToday(schedule: Schedule, now: number): boolean {
  if (schedule.status !== 'active') return false;
  if (
    schedule.lastRunAt &&
    easternDate(Date.parse(schedule.lastRunAt)) === easternDate(now)
  ) {
    return false;
  }
  if (schedule.frequency === 'monthly') {
    return schedule.dayOfMonth === easternDayOfMonth(now);
  }
  return schedule.dayOfWeek === easternDayOfWeek(now);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOON_MS = 12 * 60 * 60 * 1000;

/**
 * The first run an active schedule has due 1..`days` Eastern days AFTER today,
 * as the instant of Eastern noon on that day, or null. Today is never
 * "upcoming" (isScheduleDueToday owns it). An endDate before that day means no
 * run. Stepping from today's Eastern noon keeps a DST change (±1h) from moving
 * the date.
 */
export function upcomingDueDay(schedule: Schedule, now: number, days: number): number | null {
  if (schedule.status !== 'active') return null;
  const endTs = schedule.endDate ? Date.parse(schedule.endDate) : Number.NaN;
  const noonToday = easternDayStart(now).getTime() + NOON_MS;
  for (let k = 1; k <= days; k++) {
    const at = noonToday + k * DAY_MS;
    const due =
      schedule.frequency === 'monthly'
        ? schedule.dayOfMonth === easternDayOfMonth(at)
        : schedule.dayOfWeek === easternDayOfWeek(at);
    if (!due) continue;
    if (!Number.isNaN(endTs) && easternDayStart(at).getTime() > endTs) return null;
    return at;
  }
  return null;
}
