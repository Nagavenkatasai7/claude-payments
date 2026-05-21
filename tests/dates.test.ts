import { describe, it, expect } from 'vitest';
import { easternDate, easternDayOfMonth, easternDayOfWeek } from '@/lib/dates';

// 2026-05-21T16:00:00Z is noon Eastern on Thu May 21, 2026.
const NOON_ET = Date.parse('2026-05-21T16:00:00.000Z');

describe('dates', () => {
  it('easternDate returns a stable date string', () => {
    const a = easternDate(NOON_ET);
    const b = easternDate(NOON_ET + 60_000);
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
  });

  it('easternDayOfMonth returns the day number', () => {
    expect(easternDayOfMonth(NOON_ET)).toBe(21);
  });

  it('easternDayOfWeek returns 0-6 (Thursday = 4)', () => {
    expect(easternDayOfWeek(NOON_ET)).toBe(4);
  });
});
