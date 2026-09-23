import { describe, it, expect } from 'vitest';
import { easternDate, easternDayOfMonth, easternDayOfWeek, easternDayStart, easternMonth, easternMonthStart } from '@/lib/dates';

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

describe('easternDayOfWeek — invalid epochMs must throw (regression)', () => {
  // Bug: NaN/Infinity produced "Invalid Date" from toLocaleString which indexOf returned -1 for.
  // Callers in schedule.ts comparing -1 === dayOfWeek would silently never fire schedules.
  it('throws RangeError for NaN (e.g. Date.parse of a corrupt string)', () => {
    expect(() => easternDayOfWeek(NaN)).toThrow(RangeError);
  });

  it('throws RangeError for Infinity', () => {
    expect(() => easternDayOfWeek(Infinity)).toThrow(RangeError);
  });

  it('throws RangeError for -Infinity', () => {
    expect(() => easternDayOfWeek(-Infinity)).toThrow(RangeError);
  });

  it('throws RangeError for an out-of-range epochMs (> JS Date max)', () => {
    expect(() => easternDayOfWeek(8.64e15 + 1)).toThrow(RangeError);
  });

  it('error message includes the offending value', () => {
    expect(() => easternDayOfWeek(NaN)).toThrow(/easternDayOfWeek/);
  });
});

describe('easternDayOfMonth — invalid epochMs must throw (regression)', () => {
  // easternDayOfWeek already throws for invalid dates; easternDayOfMonth was missing the same guard.
  // When a corrupt DB field yields NaN the monthly-schedule comparison (dayOfMonth === NaN) is
  // always false, silently preventing the schedule from firing.
  it('throws RangeError for NaN', () => {
    expect(() => easternDayOfMonth(NaN)).toThrow(RangeError);
  });
  it('throws RangeError for Infinity', () => {
    expect(() => easternDayOfMonth(Infinity)).toThrow(RangeError);
  });
  it('throws RangeError for -Infinity', () => {
    expect(() => easternDayOfMonth(-Infinity)).toThrow(RangeError);
  });
  it('throws RangeError for an out-of-range epochMs (> 8.64e15)', () => {
    expect(() => easternDayOfMonth(8.64e15 + 1)).toThrow(RangeError);
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

// Program fix 16 (Task 10, test 4): the ledger cap totals are a plain
// created_at range, bounded by ET midnight / the first of the ET month. Both
// helpers must be right on the DST edge days (2026-03-08 spring forward,
// 2026-11-01 fall back) and late in the ET evening.
describe('easternDayStart / easternMonthStart (fix 16)', () => {
  const cases: Array<{ label: string; at: string; dayStart: string; monthStart: string }> = [
    // 23:30 EST on 2026-03-07 = 04:30Z 03-08; ET midnight of 03-07 is 05:00Z 03-07.
    { label: '23:30 ET the night before spring-forward', at: '2026-03-08T04:30:00.000Z', dayStart: '2026-03-07T05:00:00.000Z', monthStart: '2026-03-01T05:00:00.000Z' },
    // 23:30 EDT on 2026-03-08 = 03:30Z 03-09; ET midnight of 03-08 was still EST (05:00Z).
    { label: '23:30 ET on spring-forward day', at: '2026-03-09T03:30:00.000Z', dayStart: '2026-03-08T05:00:00.000Z', monthStart: '2026-03-01T05:00:00.000Z' },
    // 23:30 EST on 2026-11-01 = 04:30Z 11-02; ET midnight of 11-01 was still EDT (04:00Z).
    { label: '23:30 ET on fall-back day', at: '2026-11-02T04:30:00.000Z', dayStart: '2026-11-01T04:00:00.000Z', monthStart: '2026-11-01T04:00:00.000Z' },
    // 23:30 EDT on 2026-10-31 = 03:30Z 11-01; month start = 11-01 00:00 EDT? No: still October.
    { label: '23:30 ET on Halloween (the night before fall-back)', at: '2026-11-01T03:30:00.000Z', dayStart: '2026-10-31T04:00:00.000Z', monthStart: '2026-10-01T04:00:00.000Z' },
    // A plain summer noon.
    { label: 'noon EDT', at: '2026-05-21T16:00:00.000Z', dayStart: '2026-05-21T04:00:00.000Z', monthStart: '2026-05-01T04:00:00.000Z' },
    // 00:30 EST on Jan 1 (UTC is already Jan 1 05:30).
    { label: '00:30 ET on New Year', at: '2026-01-01T05:30:00.000Z', dayStart: '2026-01-01T05:00:00.000Z', monthStart: '2026-01-01T05:00:00.000Z' },
    // 23:30 EST on Dec 31 2025 = 04:30Z Jan 1 2026 — still December in ET.
    { label: '23:30 ET on New Year\'s Eve', at: '2026-01-01T04:30:00.000Z', dayStart: '2025-12-31T05:00:00.000Z', monthStart: '2025-12-01T05:00:00.000Z' },
  ];

  for (const c of cases) {
    it(`${c.label}: both helpers return ET midnight`, () => {
      const at = Date.parse(c.at);
      expect(easternDayStart(at).toISOString()).toBe(c.dayStart);
      expect(easternMonthStart(at).toISOString()).toBe(c.monthStart);
      // The instant before the day start belongs to the previous ET date.
      const before = easternDayStart(at).getTime() - 1;
      expect(easternDate(before)).not.toBe(easternDate(at));
      expect(easternDayStart(before).getTime()).toBeLessThan(easternDayStart(at).getTime());
      // And the start itself is on the same ET date as `at`.
      expect(easternDate(easternDayStart(at).getTime())).toBe(easternDate(at));
      expect(easternMonth(easternMonthStart(at).getTime())).toBe(easternMonth(at));
    });
  }

  it('accepts a Date as well as epoch ms and rejects an invalid instant', () => {
    const d = new Date('2026-05-21T16:00:00.000Z');
    expect(easternDayStart(d).toISOString()).toBe('2026-05-21T04:00:00.000Z');
    expect(easternMonthStart(d).toISOString()).toBe('2026-05-01T04:00:00.000Z');
    expect(() => easternDayStart(NaN)).toThrow(RangeError);
    expect(() => easternMonthStart(Infinity)).toThrow(RangeError);
  });
});
