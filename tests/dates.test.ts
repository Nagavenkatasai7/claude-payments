import { describe, it, expect } from 'vitest';
import { easternDate, easternDayOfMonth, easternDayOfWeek, easternMonth } from '@/lib/dates';

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

describe('easternMonth', () => {
  it('returns YYYY-MM in Eastern time', () => {
    // 2026-05-24 18:00Z = 2pm ET → May 2026
    expect(easternMonth(Date.parse('2026-05-24T18:00:00Z'))).toBe('2026-05');
  });
  it('uses the Eastern calendar boundary, not UTC', () => {
    // 2026-06-01 03:00Z = 2026-05-31 23:00 ET → still May in ET
    expect(easternMonth(Date.parse('2026-06-01T03:00:00Z'))).toBe('2026-05');
  });
  it('zero-pads single-digit months', () => {
    expect(easternMonth(Date.parse('2026-01-15T18:00:00Z'))).toBe('2026-01');
  });
});
