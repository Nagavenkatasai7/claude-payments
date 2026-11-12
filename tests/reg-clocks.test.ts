import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REG_CLASSES,
  REG_CLOCKS,
  REG_CLOCKS_VERSION,
  REG_DAY_OFFSETS_HOURS,
  addRegBusinessDays,
  earlierDue,
  isRegClass,
  regDueAt,
  type RegClass,
} from '@/lib/reg-clocks';
import { addBusinessDays } from '@/lib/remittance-disclosure';

// Fix pack 8 T2 (P4): pure clock module. Every start is built from Date.now()
// (CLAUDE.md: never hardcode dates that interact with time windows).

const DAY = 86_400_000;

/** The next UTC date at or after now whose weekday is `dow`, at hourUtc:07:00.000. */
function nextWeekday(dow: number, hourUtc = 15): number {
  const d = new Date(Date.now());
  d.setUTCHours(hourUtc, 7, 0, 0);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

const SUN = 0, MON = 1, WED = 3, FRI = 5, SAT = 6;

/** Independent expectation: step one UTC day at a time, count Mon-Fri. */
function countBusiness(fromMs: number, n: number): number {
  let t = fromMs;
  let left = n;
  while (left > 0) {
    t += DAY;
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return t;
}

const wholeDays = (a: number, b: number) => Math.round((b - a) / DAY);

describe('reg-clocks (P4)', () => {
  it('REG_CLASSES is the frozen closed tuple of four', () => {
    expect(REG_CLASSES).toEqual(['error_notice', 'cancellation', 'complaint', 'fraud_report']);
    expect(Object.isFrozen(REG_CLASSES)).toBe(true);
    for (const c of REG_CLASSES) expect(isRegClass(c)).toBe(true);
    for (const v of ['error-notice', '', 'COMPLAINT', '__proto__', 'toString', 1, null, undefined]) {
      expect(isRegClass(v)).toBe(false);
    }
  });

  it('REG_CLOCKS holds the draft lengths', () => {
    expect(REG_CLOCKS).toEqual({
      error_notice: { unit: 'calendar', days: 90 },
      cancellation: { unit: 'business', days: 3 },
      complaint: { unit: 'calendar', days: 15 },
      fraud_report: { unit: 'business', days: 10 },
    });
    expect(Object.isFrozen(REG_CLOCKS)).toBe(true);
    for (const c of REG_CLASSES) expect(Object.isFrozen(REG_CLOCKS[c])).toBe(true);
    expect(REG_CLOCKS_VERSION.endsWith('-draft')).toBe(true);
  });

  it('addRegBusinessDays counts Mon-Fri only, from the next day', () => {
    const cases: Array<[number, number, number, number]> = [
      // [start weekday, n, expected weekday, expected whole days later]
      [WED, 3, MON, 5],
      [FRI, 3, WED, 5],
      [SAT, 3, WED, 4],
      [SUN, 3, WED, 3],
      [FRI, 1, MON, 3],
      [SAT, 1, MON, 2],
      [WED, 10, WED, 14],
    ];
    for (const [dow, n, wantDow, wantDays] of cases) {
      const s = nextWeekday(dow);
      const r = addRegBusinessDays(s, n);
      expect(new Date(r).getUTCDay()).toBe(wantDow);
      expect(wholeDays(s, r)).toBe(wantDays);
    }
  });

  it('keeps the time of day', () => {
    for (const dow of [SUN, MON, WED, FRI, SAT]) {
      const s = nextWeekday(dow, 23);
      expect(addRegBusinessDays(s, 7) % DAY).toBe(s % DAY);
    }
  });

  it('n = 0 returns the start; garbage throws RangeError', () => {
    const s = nextWeekday(SAT);
    expect(addRegBusinessDays(s, 0)).toBe(s);
    for (const n of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => addRegBusinessDays(s, n)).toThrow(RangeError);
    }
    expect(() => addRegBusinessDays(Number.NaN, 1)).toThrow(RangeError);
    expect(() => regDueAt('complaint', Number.NaN)).toThrow(RangeError);
    expect(() => regDueAt('cancellation', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('regDueAt: calendar classes add whole days', () => {
    for (const dow of [FRI, SAT, WED]) {
      const s = nextWeekday(dow);
      expect(regDueAt('error_notice', s)).toBe(s + 90 * DAY);
      expect(regDueAt('complaint', s)).toBe(s + 15 * DAY);
    }
  });

  it('regDueAt: business classes skip weekends', () => {
    const fri = nextWeekday(FRI), sat = nextWeekday(SAT), wed = nextWeekday(WED);
    expect(new Date(regDueAt('cancellation', fri)).getUTCDay()).toBe(WED);
    expect(new Date(regDueAt('cancellation', sat)).getUTCDay()).toBe(WED);
    expect(new Date(regDueAt('cancellation', wed)).getUTCDay()).toBe(MON);
    for (const s of [fri, sat, wed]) {
      expect(regDueAt('cancellation', s)).toBe(countBusiness(s, 3));
      expect(regDueAt('fraud_report', s)).toBe(countBusiness(s, 10));
    }
    expect(new Date(regDueAt('fraud_report', fri)).getUTCDay()).toBe(FRI);
    expect(wholeDays(fri, regDueAt('fraud_report', fri))).toBe(14);
    expect(new Date(regDueAt('fraud_report', sat)).getUTCDay()).toBe(FRI);
    expect(wholeDays(sat, regDueAt('fraud_report', sat))).toBe(13);
    expect(new Date(regDueAt('fraud_report', wed)).getUTCDay()).toBe(WED);
    expect(wholeDays(wed, regDueAt('fraud_report', wed))).toBe(14);
  });

  it('never earlier than the notice and never later than the calendar bound', () => {
    for (const cls of REG_CLASSES as readonly RegClass[]) {
      for (let dow = 0; dow < 7; dow++) {
        const s = nextWeekday(dow);
        const due = regDueAt(cls, s);
        expect(due).toBeGreaterThanOrEqual(s);
        if (REG_CLOCKS[cls].unit === 'business') {
          expect(due).toBeLessThanOrEqual(s + REG_CLOCKS[cls].days * 2 * DAY);
        }
      }
    }
  });

  it('earlierDue never moves a due date later', () => {
    const b = nextWeekday(WED);
    expect(earlierDue(null, b)).toBe(b);
    expect(earlierDue(b - DAY, b)).toBe(b - DAY);
    expect(earlierDue(b + DAY, b)).toBe(b);
    expect(earlierDue(b, b)).toBe(b);
  });

  it('differs from the disclosure helper only on a weekend start', () => {
    const wed = nextWeekday(WED);
    expect(addRegBusinessDays(wed, 1)).toBe(addBusinessDays(wed, 1).getTime());
    const sat = nextWeekday(SAT);
    const reg = addRegBusinessDays(sat, 1);
    const disclosure = addBusinessDays(sat, 1).getTime();
    expect(reg).toBeLessThan(disclosure);
    expect(new Date(reg).getUTCDay()).toBe(MON);
    expect(new Date(disclosure).getUTCDay()).toBe(2);
  });

  it('the module has no runtime import', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/reg-clocks.ts'), 'utf8');
    const runtime = src
      .split('\n')
      .filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s+type\s/.test(l));
    expect(runtime).toEqual([]);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/^\s*export\s+[^\n]*\bfrom\s+['"]/m);
  });
});

// Fix pack 8 F3 (early review FB1): the business-day count is the EARLIEST of
// the counts on UTC days and on the days of every US state time zone. These
// inputs go into a PURE function (no clock read, no time window), so literal
// UTC instants are right here.
describe('reg-clocks: earliest count over UTC and the US state offsets (F3)', () => {
  const HOUR = 3_600_000;
  /** Independent counter: Mon-Fri on the calendar shifted by `h` hours, counting from the next day. */
  function daysOnCalendar(fromMs: number, n: number, h: number): number {
    let k = 0;
    let left = n;
    while (left > 0) {
      k += 1;
      const dow = new Date(fromMs + k * DAY + h * HOUR).getUTCDay();
      if (dow !== 0 && dow !== 6) left -= 1;
    }
    return k;
  }
  const OFFSETS = [0, -4, -5, -6, -7, -8, -9, -10];

  it('REG_DAY_OFFSETS_HOURS is frozen and holds UTC and every US state offset', () => {
    expect(REG_DAY_OFFSETS_HOURS).toEqual([0, -4, -5, -6, -7, -8, -9, -10]);
    expect(Object.isFrozen(REG_DAY_OFFSETS_HOURS)).toBe(true);
  });

  it('a Tuesday 20:30 Eastern cancellation is due Friday 20:30 Eastern, not Sunday', () => {
    expect(regDueAt('cancellation', Date.parse('2026-11-18T01:30:00Z'))).toBe(Date.parse('2026-11-21T01:30:00Z'));
  });

  it('a Sunday 21:00 Eastern fraud report is due Friday 27 Nov 21:00 Eastern', () => {
    expect(regDueAt('fraud_report', Date.parse('2026-11-16T02:00:00Z'))).toBe(Date.parse('2026-11-28T02:00:00Z'));
  });

  it('a Friday 21:00 Eastern notice keeps the earlier UTC count', () => {
    const from = Date.parse('2026-11-21T02:00:00Z');
    expect(addRegBusinessDays(from, 3)).toBe(Date.parse('2026-11-25T02:00:00Z'));
    expect(addRegBusinessDays(from, 3)).toBeLessThanOrEqual(countBusiness(from, 3));
  });

  it('equals the minimum of the independent counts for every hour of 14 days', () => {
    const start = Date.parse('2026-11-02T00:00:00Z');
    for (let i = 0; i < 14 * 24; i++) {
      const from = start + i * HOUR;
      for (const n of [0, 1, 3, 10]) {
        const counts = OFFSETS.map((h) => from + daysOnCalendar(from, n, h) * DAY);
        const r = addRegBusinessDays(from, n);
        expect(r).toBe(Math.min(...counts));
        for (const c of counts) expect(r).toBeLessThanOrEqual(c);
        expect((r - from) % DAY).toBe(0);
        expect(r).toBeGreaterThanOrEqual(from + n * DAY);
      }
    }
  });
});
