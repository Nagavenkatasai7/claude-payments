import { describe, it, expect } from 'vitest';
import { lastLoginLabel, permissionFlags, rosterRows } from '@/lib/partner-staff-view';
import type { Staff } from '@/lib/types';

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

// Lost-features A13: an agent sees the team (active members, name, username and role) and nothing
// an admin manages: no suspended member, no MFA state, no last sign-in, no permissions.
describe('rosterRows', () => {
  const perms = { canCancel: true, canResend: false, canAssign: false, canRevealPii: true };
  const m = (o: Partial<Staff>): Staff => ({
    username: 'u', name: 'U', role: 'agent', permissions: perms, passwordHash: 'HASH', createdAt: '2026-01-01T00:00:00.000Z',
    partnerId: 'pa', lastLoginAt: '2026-09-29T11:00:00.000Z', ...o,
  });
  const members = [m({ username: 'a', name: 'Alice', role: 'admin' }), m({ username: 'b', name: 'Bob' }), m({ username: 'c', name: 'Cy', status: 'suspended' })];
  it('an admin gets every member, unchanged', () => {
    expect(rosterRows(members, 'admin')).toEqual(members);
  });
  it('an agent gets active members only, projected to name, username and role', () => {
    const rows = rosterRows(members, 'agent');
    expect(rows).toEqual([
      { name: 'Alice', username: 'a', role: 'admin' },
      { name: 'Bob', username: 'b', role: 'agent' },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/HASH|lastLoginAt|permissions|canRevealPii|suspended/);
  });
  it('any other role gets nothing', () => {
    for (const role of ['support', 'finance', 'root'] as const) expect(rosterRows(members, role as never)).toEqual([]);
  });
});

// Lost-features A13 (review 2.4): the admin view shows each member's per-staff permissions, read
// only (SmartRemit sets them). Admins hold every permission by role; other roles show what is on.
describe('permissionFlags', () => {
  const base = { username: 'u', name: 'U', passwordHash: 'x', createdAt: '2026-01-01T00:00:00.000Z', partnerId: 'pa' };
  const none = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
  it('an admin: every permission, by role', () => {
    expect(permissionFlags({ ...base, role: 'admin', permissions: none })).toEqual({ byRole: true, keys: [] });
  });
  it('an agent: the flags that are on, in a fixed order', () => {
    expect(permissionFlags({ ...base, role: 'agent', permissions: { canCancel: true, canResend: false, canAssign: true, canRevealPii: true } })).toEqual({
      byRole: false,
      keys: ['partner.staff.perm.cancel', 'partner.staff.perm.assign', 'partner.staff.perm.reveal'],
    });
    expect(permissionFlags({ ...base, role: 'agent', permissions: { canCancel: false, canResend: true, canAssign: false } })).toEqual({
      byRole: false,
      keys: ['partner.staff.perm.resend'],
    });
  });
  it('none on, and finance (which never holds legacy permissions), show none', () => {
    expect(permissionFlags({ ...base, role: 'agent', permissions: none })).toEqual({ byRole: false, keys: [] });
    expect(permissionFlags({ ...base, role: 'finance', permissions: { ...none, canCancel: true } })).toEqual({ byRole: false, keys: [] });
  });
});
