import { isLegacyDashboardStaff } from './legacy-dashboard-staff';
import { canSee, scopeOf } from './staff-scope';
import { isTestStaff } from './ticket-balancer';
import type { PartnerId, Staff } from './types';

/** Why a staff record cannot be given a ticket, in the order the checks run. */
export type AssigneeRefusal = 'unknown' | 'inactive' | 'scope' | 'role';

/**
 * The ONE assignee rule both assign actions share (legacy assignTicketAction and /partner's
 * assignAction): the record exists, is active, its scope can see the ticket's tenant, and it is a
 * ticket-capable legacy role (support, admin, agent; UI redesign M3-6 keeps finance out, since it
 * cannot open the ticket). null = assignable. The legacy action maps each refusal to its own copy.
 */
export function ticketAssigneeRefusal(s: Staff | null, ticketPartnerId: PartnerId): AssigneeRefusal | null {
  if (!s) return 'unknown';
  if (s.status === 'suspended') return 'inactive';
  if (!canSee(scopeOf(s), ticketPartnerId)) return 'scope';
  if (!isLegacyDashboardStaff(s)) return 'role';
  return null;
}

/**
 * Who the legacy ticket-detail dropdown may offer as an assignee (ticketAssigneeRefusal is null).
 * assignTicketAction re-validates the same rules server-side; hiding an option is never the guard.
 */
export function isTicketAssignable(s: Staff, ticketPartnerId: PartnerId): boolean {
  return ticketAssigneeRefusal(s, ticketPartnerId) === null;
}

/**
 * The /partner rule (merge plan 2e): an assignee must be a MEMBER of the session tenant (the same
 * membership test tenantStaffUsernames uses), plus the shared rule above, and never an
 * auto-provisioned test account. Platform staff can see every tenant, so the legacy rule alone would
 * admit them; a tenant page never names or picks SmartRemit staff. Fails closed on an empty tenant.
 */
export function isTenantTicketAssignee(s: Staff | null, partnerId: PartnerId): boolean {
  if (!s || typeof partnerId !== 'string' || partnerId.length === 0) return false;
  if (s.partnerId !== partnerId) return false;
  return isTicketAssignable(s, partnerId) && !isTestStaff(s);
}

/** The /partner assign dropdown: the tenant's eligible staff, sorted by username. */
export function tenantTicketAssignees(all: readonly Staff[], partnerId: PartnerId): Staff[] {
  return all.filter((s) => isTenantTicketAssignee(s, partnerId)).sort((a, b) => a.username.localeCompare(b.username));
}
