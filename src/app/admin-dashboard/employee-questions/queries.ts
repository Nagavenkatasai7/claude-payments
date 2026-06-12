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
  const isAdmin = staff.role === 'admin';
  const tickets = await createTicketRepo(getDb()).listTickets({
    kind: 'internal',
    ...(staff.partnerId ? { partnerId: staff.partnerId } : {}),
    ...(status ? { status } : {}),
    // The repo has no openedBy filter, so a support staffer's own questions
    // are picked out of the scoped list in memory — fetch a deeper page so a
    // busy tenant's queue can't starve their list off the default 100.
    ...(isAdmin ? {} : { limit: 500 }),
  });
  if (isAdmin) return tickets;
  return tickets.filter((t) => t.openedBy === staff.username);
}

/**
 * The scoped ticket-only read (no thread) — what the mutation actions use to
 * authorize a target. Null when missing / not internal / out of scope.
 */
export async function getScopedQuestionTicket(
  staff: Staff,
  ticketId: string,
): Promise<Ticket | null> {
  if (!ticketId) return null;
  const ticket = await createTicketRepo(getDb()).getTicket(ticketId);
  if (!ticket || ticket.kind !== 'internal') return null;
  const allowed =
    staff.role === 'admin'
      ? canSee(scopeOf(staff), ticket.partnerId)
      : ticket.openedBy === staff.username;
  return allowed ? ticket : null;
}

/**
 * One question + its full thread (the thread page read). Threads here are
 * internal-only people, so includeInternal is true.
 */
export async function getEmployeeQuestion(
  staff: Staff,
  ticketId: string,
): Promise<{ ticket: Ticket; messages: TicketMessage[] } | null> {
  const ticket = await getScopedQuestionTicket(staff, ticketId);
  if (!ticket) return null;
  const messages = await createTicketRepo(getDb()).listMessages(ticket.id, {
    includeInternal: true,
  });
  return { ticket, messages };
}
