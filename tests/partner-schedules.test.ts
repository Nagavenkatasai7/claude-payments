import { describe, it, expect } from 'vitest';
import {
  parseScheduleFilter,
  parseScheduleOp,
  partnerSchedulesDueSoon,
  scheduleControls,
  toPartnerScheduleRow,
  visiblePartnerSchedules,
  type PartnerScheduleRecord,
} from '@/lib/partner-schedules';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';
import type { ScheduleStatus } from '@/lib/types';

// Merge plan 2a: the /partner Schedules page's pure helpers. Controls are derived from the ONE
// transition table (decideScheduleAction) and are admin-only (owner decision D1); the row view
// carries masked values only.

const DAY = 86_400_000;

function rec(o: Partial<PartnerScheduleRecord> = {}): PartnerScheduleRecord {
  return {
    id: 'sch_1',
    phone: '15550001234',
    amountSource: 150,
    sourceCurrency: 'USD',
    recipientName: 'Firstname Lastname',
    payoutMethod: 'bank',
    payoutDestinationLast4: '9876',
    frequency: 'monthly',
    dayOfMonth: 5,
    status: 'active',
    createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
    ...o,
  };
}

describe('parseScheduleOp', () => {
  it('accepts exactly pause, resume and cancel', () => {
    expect(parseScheduleOp('pause')).toBe('pause');
    expect(parseScheduleOp('resume')).toBe('resume');
    expect(parseScheduleOp('cancel')).toBe('cancel');
  });
  it('refuses anything else (no trimming, no case folding, no non-strings)', () => {
    for (const v of ['', 'Pause', ' pause', 'delete', 'create', 'activate', null, undefined, 1, {}, ['pause']]) {
      expect(parseScheduleOp(v)).toBeNull();
    }
  });
});

describe('scheduleControls', () => {
  it('admin: active → pause + cancel; paused → resume + cancel; cancelled → nothing', () => {
    expect(scheduleControls('active', 'admin')).toEqual({ pause: true, resume: false, cancel: true });
    expect(scheduleControls('paused', 'admin')).toEqual({ pause: false, resume: true, cancel: true });
    expect(scheduleControls('cancelled', 'admin')).toEqual({ pause: false, resume: false, cancel: false });
  });
  it('D1: every non-admin role gets no control in any state', () => {
    for (const role of KNOWN_PARTNER_ROLES.filter((r) => r !== 'admin')) {
      for (const s of ['active', 'paused', 'cancelled'] as ScheduleStatus[]) {
        expect(scheduleControls(s, role)).toEqual({ pause: false, resume: false, cancel: false });
      }
    }
  });
  it('an unknown status or role offers nothing (fails closed)', () => {
    expect(scheduleControls('weird' as ScheduleStatus, 'admin')).toEqual({ pause: false, resume: false, cancel: false });
    expect(scheduleControls('active', 'root' as never)).toEqual({ pause: false, resume: false, cancel: false });
  });
});

describe('parseScheduleFilter / visiblePartnerSchedules', () => {
  it('defaults to open (active + paused); only the exact "all" shows cancelled too', () => {
    expect(parseScheduleFilter(undefined)).toBe('open');
    expect(parseScheduleFilter('ALL')).toBe('open');
    expect(parseScheduleFilter(['all'])).toBe('open');
    expect(parseScheduleFilter('all')).toBe('all');
    const list = [rec({ id: 'a' }), rec({ id: 'p', status: 'paused' }), rec({ id: 'c', status: 'cancelled' })];
    expect(visiblePartnerSchedules(list, 'open').map((s) => s.id)).toEqual(['a', 'p']);
    expect(visiblePartnerSchedules(list, 'all').map((s) => s.id)).toEqual(['a', 'p', 'c']);
  });
});

describe('toPartnerScheduleRow', () => {
  it('carries masked values only: sender last 4, recipient first word + initial, destination ****last4', () => {
    const row = toPartnerScheduleRow(rec(), 'admin');
    expect(row).toMatchObject({
      id: 'sch_1',
      sender: '••••1234',
      recipient: 'Firstname L.',
      destination: '****9876',
      amount: 150,
      currency: 'USD',
      status: 'active',
      controls: { pause: true, resume: false, cancel: true },
    });
    const json = JSON.stringify(row);
    expect(json).not.toContain('15550001234');
    expect(json).not.toContain('Lastname');
  });
  it('the cadence line reuses describeSchedule (monthly day / weekday)', () => {
    expect(toPartnerScheduleRow(rec(), 'admin').cadence).toEqual({ key: 'portal.schedules.monthlyOn', vars: { day: 5 } });
    const weekly = toPartnerScheduleRow(rec({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 1 }), 'admin');
    expect(weekly.cadence.key).toBe('portal.schedules.weeklyOn');
  });
  it('no stored last 4 → a bare mask, never an empty or raw value', () => {
    expect(toPartnerScheduleRow(rec({ payoutDestinationLast4: '' }), 'admin').destination).toBe('****');
  });
  it('flags a missing sender name on active schedules only', () => {
    expect(toPartnerScheduleRow(rec({ needsSenderName: true }), 'agent').needsSenderName).toBe(true);
    expect(toPartnerScheduleRow(rec({ needsSenderName: false }), 'agent').needsSenderName).toBe(false);
    expect(toPartnerScheduleRow(rec(), 'agent').needsSenderName).toBe(false);
    expect(toPartnerScheduleRow(rec({ needsSenderName: true, status: 'paused' }), 'agent').needsSenderName).toBe(false);
    expect(toPartnerScheduleRow(rec({ needsSenderName: true, status: 'cancelled' }), 'agent').needsSenderName).toBe(false);
  });
  it('a non-admin row has no controls', () => {
    expect(toPartnerScheduleRow(rec(), 'agent').controls).toEqual({ pause: false, resume: false, cancel: false });
  });
});

describe('partnerSchedulesDueSoon', () => {
  it('lists only ACTIVE schedules due within the window, soonest first (relative dates)', () => {
    const now = Date.now();
    const today = new Date(now);
    const inDays = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n).getDay();
    const list = [
      rec({ id: 'w3', frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: inDays(3) }),
      rec({ id: 'w1', frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: inDays(1) }),
      rec({ id: 'paused', status: 'paused', frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: inDays(1) }),
      rec({ id: 'cancelled', status: 'cancelled', frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: inDays(2) }),
    ];
    expect(partnerSchedulesDueSoon(list, now, 7).map((s) => s.id)).toEqual(['w1', 'w3']);
    expect(partnerSchedulesDueSoon(list, now, 2).map((s) => s.id)).toEqual(['w1']);
  });
});
