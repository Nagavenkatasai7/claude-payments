import { getDb } from '@/db/client';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { canSee, scopeOf } from '@/lib/staff-scope';
import type { Staff, Ticket, TicketMessage, TicketStatus } from '@/lib/types';

// queries — the read side of the employee-questions surface, shared by the
// queue page, the thread page, and the actions' target checks. Callers pass
// the ALREADY-AUTHENTICATED staff (pages gate via requireSupportOrAdmin);
// every scoping rule lives here, in one place:
//   • only kind 'internal' — customer tickets NEVER surface on this page;
//   • partner-scoped staff are PINNED to their tenant (partnerId in the WHERE);
//   • admins see the queue (platform: all partners; partner-admin: their own);
//   • support staff see ONLY their own questions (openedBy filter, applied
//     in memory after the tenant-scoped list);
//   • misses and out-of-scope ids collapse to the same null (404-never-403).

/** The questions visible to this staff member, newest activity first. */
export async function listEmployeeQuestions(
  staff: Staff,
  status?: TicketStatus,
): Promise<Ticket[]> {
  const tickets = await createTicketRepo(getDb()).listTickets({
    kind: 'internal',
    ...(staff.partnerId ? { partnerId: staff.partnerId } : {}),
    ...(status ? { status } : {}),
  });
  if (staff.role === 'admin') return tickets;
  return tickets.filter((t) => t.openedBy === staff.username);
}

/**
 * One question + its full thread, or null when missing / not internal / out of
 * scope. Threads here are internal-only people, so includeInternal is true.
 */
export async function getEmployeeQuestion(
  staff: Staff,
  ticketId: string,
): Promise<{ ticket: Ticket; messages: TicketMessage[] } | null> {
  if (!ticketId) return null;
  const repo = createTicketRepo(getDb());
  const ticket = await repo.getTicket(ticketId);
  if (!ticket || ticket.kind !== 'internal') return null;
  const allowed =
    staff.role === 'admin'
      ? canSee(scopeOf(staff), ticket.partnerId)
      : ticket.openedBy === staff.username;
  if (!allowed) return null;
  const messages = await repo.listMessages(ticketId, { includeInternal: true });
  return { ticket, messages };
}
