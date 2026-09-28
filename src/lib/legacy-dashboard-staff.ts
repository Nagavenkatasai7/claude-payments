import type { Staff } from './types';

/**
 * UI redesign M3-6: may this staff record use the legacy /admin-dashboard surfaces?
 *
 * A CLOSED allowlist (admin, agent, support). 'finance' is a /partner-only role, and any role
 * outside the set (a malformed record) is refused too, so a new role is deny-by-default on every
 * legacy page, action and route. Pure (no request access), so the gate in auth.ts, the legacy API
 * routes and the assignee pickers share one definition.
 */
export function isLegacyDashboardStaff(s: Pick<Staff, 'role'>): boolean {
  return s.role === 'admin' || s.role === 'agent' || s.role === 'support';
}
