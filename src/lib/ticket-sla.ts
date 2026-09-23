import type { Ticket, TicketMessage, TicketPriority, TicketStatus } from './types';

// ticket-sla — the INTERNAL first-response target for customer support tickets
// (Program-Fix 49C, tickets-01). Staff-facing only: the queue's Age / SLA pill
// and one daily ops digest. It is NEVER shown to customers — fix 34 decided the
// product makes no customer-facing response-time promise.
//
// The first response is DERIVED (no schema column): the earliest ticket message
// with actor_type 'staff' that is not an internal note. A system line or an
// internal note is not a response, and neither is the customer's own message.

export const FIRST_RESPONSE_DUE_HOURS: Readonly<Record<TicketPriority, number>> = {
  urgent: 4,
  normal: 24,
  low: 72,
};

/** Statuses on which the first-response clock runs. */
export const SLA_ACTIVE_STATUSES: readonly TicketStatus[] = ['open', 'pending', 'waiting_admin'];

/** An unanswered ticket is "due soon" in the last quarter of its window. */
const DUE_SOON_FRACTION = 0.25;

const HOUR_MS = 3_600_000;

export type SlaState =
  | 'ok'        // unanswered, inside the window
  | 'due_soon'  // unanswered, in the last quarter of the window
  | 'breached'  // unanswered, past the target
  | 'met'       // answered within the target
  | 'late'      // answered, but after the target
  | 'inactive'; // unanswered, but resolved/closed (no clock)

export interface SlaInfo {
  state: SlaState;
  dueAt: Date;
  ageMs: number;
}

/** Earliest public staff message (ISO), or null when staff have not replied. */
export function firstResponseAt(
  messages: ReadonlyArray<Pick<TicketMessage, 'actorType' | 'internal' | 'createdAt'>>,
): string | null {
  let best: string | null = null;
  for (const m of messages) {
    if (m.actorType !== 'staff' || m.internal) continue;
    if (best === null || new Date(m.createdAt).getTime() < new Date(best).getTime()) best = m.createdAt;
  }
  return best;
}

export function slaState(
  ticket: Pick<Ticket, 'priority' | 'status' | 'createdAt'>,
  firstResponse: string | null,
  now: Date,
): SlaInfo {
  const created = new Date(ticket.createdAt).getTime();
  const windowMs = (FIRST_RESPONSE_DUE_HOURS[ticket.priority] ?? FIRST_RESPONSE_DUE_HOURS.normal) * HOUR_MS;
  const dueAt = new Date(created + windowMs);
  const ageMs = Math.max(0, now.getTime() - created);
  if (firstResponse !== null) {
    return { state: new Date(firstResponse).getTime() <= dueAt.getTime() ? 'met' : 'late', dueAt, ageMs };
  }
  if (!SLA_ACTIVE_STATUSES.includes(ticket.status)) return { state: 'inactive', dueAt, ageMs };
  const remaining = dueAt.getTime() - now.getTime();
  if (remaining < 0) return { state: 'breached', dueAt, ageMs };
  if (remaining <= windowMs * DUE_SOON_FRACTION) return { state: 'due_soon', dueAt, ageMs };
  return { state: 'ok', dueAt, ageMs };
}

/** One ops digest per UTC day. */
export function slaDigestKey(now: Date): string {
  return `ticketsla:${now.toISOString().slice(0, 10)}`;
}

/** Compact duration for the staff pill: 45m, 5h, 3d. */
export function formatSlaDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
