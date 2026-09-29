import { isLegacyDashboardStaff } from './legacy-dashboard-staff';
import { canSee, scopeOf } from './staff-scope';
import type { PartnerId, Staff } from './types';

/**
 * Who the legacy ticket-detail dropdown may offer as an assignee: an active member of a
 * ticket-capable legacy role (support, admin, agent; UI redesign M3-6 keeps finance out, since it
 * cannot open the ticket) whose scope can see the ticket's tenant. assignTicketAction re-validates
 * the same rules server-side; hiding an option is never the guard.
 */
export function isTicketAssignable(s: Staff, ticketPartnerId: PartnerId): boolean {
  return s.status !== 'suspended' && isLegacyDashboardStaff(s) && canSee(scopeOf(s), ticketPartnerId);
}
