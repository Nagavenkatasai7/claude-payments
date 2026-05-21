import { easternDate, easternDayOfMonth, easternDayOfWeek } from './dates';
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
