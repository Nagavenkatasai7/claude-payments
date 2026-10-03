import type { MessageKey } from './i18n';
import type { Staff, StaffRole } from './types';

// partner-staff-view — UI redesign M3-8. Pure display helpers for /partner/staff.

export type Label = { key: MessageKey; vars?: Record<string, number> };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A member's last sign-in, relative to `now`. Missing or unparseable → "Never"; future (skew) → "Just now". */
export function lastLoginLabel(iso: string | undefined, now: Date): Label {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return { key: 'partner.staff.never' };
  const d = now.getTime() - at;
  if (d < MIN) return { key: 'partner.staff.justNow' };
  if (d < HOUR) return { key: 'partner.staff.minutesAgo', vars: { n: Math.floor(d / MIN) } };
  if (d < DAY) return { key: 'partner.staff.hoursAgo', vars: { n: Math.floor(d / HOUR) } };
  return { key: 'partner.staff.daysAgo', vars: { n: Math.floor(d / DAY) } };
}

export type RosterRow = Pick<Staff, 'name' | 'username' | 'role'>;

/**
 * Lost-features A13: the rows a role may see on /partner/staff. An admin manages the team and gets
 * every member; an agent gets a read-only roster of ACTIVE members, projected to name, username and
 * role (no MFA state, last sign-in or permissions). Any other role gets nothing (the page gate
 * already refuses support and finance).
 */
export function rosterRows(members: readonly Staff[], role: StaffRole): RosterRow[] {
  if (role === 'admin') return [...members];
  if (role !== 'agent') return [];
  return members.filter((m) => m.status !== 'suspended').map((m) => ({ name: m.name, username: m.username, role: m.role }));
}
