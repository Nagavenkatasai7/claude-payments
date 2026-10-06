import { describe, it, expect } from 'vitest';
import {
  fixingLagBusinessDays,
  FIXING_ALERT_LAG,
  FIXING_REFUSE_LAG,
  isFixingRefused,
} from '@/lib/fx-fixing';

// Step 0 FX-1: the fixing-date gate. Pure: UTC only, no holiday table.
//   ALERT  rule: a weekday d is due at d 17:00 UTC.
//   REFUSE rule: a weekday d is due at (d+1) 06:00 UTC.
// The lag counts Mon–Fri dates in (asOf, latest due date]. Walk-throughs from
// step0-rate-fixes.md §3.1 and verify2-step0-fx.md (A).
const at = (iso: string) => Date.parse(iso);
const lags = (asOf: string, now: string) => [
  fixingLagBusinessDays(asOf, at(now), 'refuse'),
  fixingLagBusinessDays(asOf, at(now), 'alert'),
];

describe('fixingLagBusinessDays — walk-throughs (REFUSE / ALERT)', () => {
  it('Sunday with the Friday fixing: 0 / 0', () => {
    expect(lags('2026-10-02', '2026-10-04T10:00:00Z')).toEqual([0, 0]);
  });
  it('Monday 10:00 UTC, Friday fixing: 0 / 0 (Monday not due yet)', () => {
    expect(lags('2026-10-02', '2026-10-05T10:00:00Z')).toEqual([0, 0]);
  });
  it('Monday 17:30 UTC with no update: 0 / 1; with the normal update: 0 / 0', () => {
    expect(lags('2026-10-02', '2026-10-05T17:30:00Z')).toEqual([0, 1]);
    expect(lags('2026-10-05', '2026-10-05T17:30:00Z')).toEqual([0, 0]);
  });
  it('Easter Tuesday 2027-03-30 10:00 (Good Friday + Easter Monday closed): 2 / 2', () => {
    expect(lags('2027-03-25', '2027-03-30T10:00:00Z')).toEqual([2, 2]);
  });
  it('Easter Tuesday 18:00, Tuesday fixing late: 2 / 3 — alerts, never refuses', () => {
    expect(lags('2027-03-25', '2027-03-30T18:00:00Z')).toEqual([2, 3]);
  });
  it('Wednesday 06:00 with still no Tuesday fixing: refuse lag 3', () => {
    expect(fixingLagBusinessDays('2027-03-25', at('2027-03-31T06:00:00Z'), 'refuse')).toBe(3);
  });
  it('Wed 2028-12-27 18:00 (Mon 25 + Tue 26 Dec closed), fixing late: 2 / 3', () => {
    expect(lags('2028-12-22', '2028-12-27T18:00:00Z')).toEqual([2, 3]);
  });
  it('Sun 2026-12-27 after the Christmas Friday: 1', () => {
    expect(fixingLagBusinessDays('2026-12-24', at('2026-12-27T12:00:00Z'), 'refuse')).toBe(1);
    expect(fixingLagBusinessDays('2026-12-24', at('2026-12-27T12:00:00Z'), 'alert')).toBe(1);
  });
  it('Fri 2026-01-02 (1 Jan closed): 1, and 2 after 17:00 if late', () => {
    expect(fixingLagBusinessDays('2025-12-31', at('2026-01-02T12:00:00Z'), 'alert')).toBe(1);
    expect(fixingLagBusinessDays('2025-12-31', at('2026-01-02T17:00:00Z'), 'alert')).toBe(2);
  });
  it('Sat 2027-01-02 (1 Jan 2027 Friday closed): 1', () => {
    expect(fixingLagBusinessDays('2026-12-31', at('2027-01-02T10:00:00Z'), 'refuse')).toBe(1);
  });
});

describe('fixingLagBusinessDays — boundaries', () => {
  it('ALERT: one second before 17:00 UTC is not due; 17:00:00 is', () => {
    expect(fixingLagBusinessDays('2026-10-02', at('2026-10-05T16:59:59Z'), 'alert')).toBe(0);
    expect(fixingLagBusinessDays('2026-10-02', at('2026-10-05T17:00:00Z'), 'alert')).toBe(1);
  });
  it('REFUSE: one second before next-day 06:00 UTC is not due; 06:00:00 is', () => {
    expect(fixingLagBusinessDays('2026-10-02', at('2026-10-06T05:59:59Z'), 'refuse')).toBe(0);
    expect(fixingLagBusinessDays('2026-10-02', at('2026-10-06T06:00:00Z'), 'refuse')).toBe(1);
  });
  it('a Friday is due for REFUSE at Saturday 06:00 (weekend days never count)', () => {
    expect(fixingLagBusinessDays('2026-10-01', at('2026-10-03T06:00:00Z'), 'refuse')).toBe(1);
    expect(fixingLagBusinessDays('2026-10-01', at('2026-10-05T05:00:00Z'), 'refuse')).toBe(1);
  });
});

describe('fixingLagBusinessDays — bad input', () => {
  it('clock skew (asOf after now) returns 0', () => {
    expect(fixingLagBusinessDays('2026-10-09', at('2026-10-05T12:00:00Z'), 'refuse')).toBe(0);
    expect(fixingLagBusinessDays('2026-10-09', at('2026-10-05T12:00:00Z'), 'alert')).toBe(0);
  });
  it('a non-ISO value returns null', () => {
    for (const bad of ['', '2026-10-2', '02/10/2026', '2026-13-01', '2026-02-30', 'yesterday', '2026-10-02T00:00:00Z']) {
      expect(fixingLagBusinessDays(bad, at('2026-10-05T12:00:00Z'), 'refuse')).toBeNull();
    }
  });
  it('a very old fixing is counted without looping forever', () => {
    const lag = fixingLagBusinessDays('2016-01-01', at('2026-10-05T12:00:00Z'), 'refuse');
    expect(lag).toBeGreaterThan(2000);
  });
});

describe('thresholds', () => {
  it('alert at ALERT-lag >= 1, refuse at REFUSE-lag >= 3', () => {
    expect(FIXING_ALERT_LAG).toBe(1);
    expect(FIXING_REFUSE_LAG).toBe(3);
  });
  it('isFixingRefused: true only at REFUSE-lag >= 3; unknown / non-ISO asOf never refuses', () => {
    expect(isFixingRefused('2027-03-25', at('2027-03-30T18:00:00Z'))).toBe(false);
    expect(isFixingRefused('2027-03-25', at('2027-03-31T06:00:00Z'))).toBe(true);
    expect(isFixingRefused(undefined, at('2027-03-31T06:00:00Z'))).toBe(false);
    expect(isFixingRefused('junk', at('2027-03-31T06:00:00Z'))).toBe(false);
  });
});
