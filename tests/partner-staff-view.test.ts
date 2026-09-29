import { describe, it, expect } from 'vitest';
import { lastLoginLabel } from '@/lib/partner-staff-view';

// UI redesign M3-8: the Staff page's relative "last sign-in" (pure, injected clock).
const now = new Date('2026-09-29T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('lastLoginLabel', () => {
  it('never / unparseable / missing', () => {
    expect(lastLoginLabel(undefined, now)).toEqual({ key: 'partner.staff.never' });
    expect(lastLoginLabel('', now)).toEqual({ key: 'partner.staff.never' });
    expect(lastLoginLabel('not a date', now)).toEqual({ key: 'partner.staff.never' });
  });
  it('under a minute, and a clock-skewed future time, read as just now', () => {
    expect(lastLoginLabel(ago(30_000), now)).toEqual({ key: 'partner.staff.justNow' });
    expect(lastLoginLabel(ago(-5 * MIN), now)).toEqual({ key: 'partner.staff.justNow' });
  });
  it('minutes, hours, days (floored)', () => {
    expect(lastLoginLabel(ago(5 * MIN + 59_000), now)).toEqual({ key: 'partner.staff.minutesAgo', vars: { n: 5 } });
    expect(lastLoginLabel(ago(59 * MIN), now)).toEqual({ key: 'partner.staff.minutesAgo', vars: { n: 59 } });
    expect(lastLoginLabel(ago(HOUR), now)).toEqual({ key: 'partner.staff.hoursAgo', vars: { n: 1 } });
    expect(lastLoginLabel(ago(23 * HOUR + 59 * MIN), now)).toEqual({ key: 'partner.staff.hoursAgo', vars: { n: 23 } });
    expect(lastLoginLabel(ago(DAY), now)).toEqual({ key: 'partner.staff.daysAgo', vars: { n: 1 } });
    expect(lastLoginLabel(ago(400 * DAY), now)).toEqual({ key: 'partner.staff.daysAgo', vars: { n: 400 } });
  });
});
