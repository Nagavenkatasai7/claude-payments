import type { MessageKey } from './i18n';

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
