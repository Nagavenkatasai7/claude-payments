// ticket-input — the PURE validation of a customer support ticket (UI redesign M2-12, Task 12.2).
// Extracted from the legacy /account/support actions so the customer portal applies exactly the
// same rules; both import it. No I/O.

export const TICKET_SUBJECT_MIN = 3;
export const TICKET_SUBJECT_MAX = 120;
export const TICKET_BODY_MIN = 10;
export const TICKET_BODY_MAX = 2000;
export const TICKET_REPLY_MIN = 1;
/** At most this many concurrently-open requests per customer (resolved and closed don't count). */
export const MAX_OPEN_TICKETS = 5;
/** Statuses that count against the open-ticket cap. */
export const OPEN_TICKET_STATUSES: ReadonlySet<string> = new Set(['open', 'pending', 'waiting_admin']);

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export type NewTicketResult = { ok: true; subject: string; body: string } | { ok: false; error: 'subject' | 'message' };

/** A new ticket: subject 3-120 and message 10-2000 characters, both trimmed. The subject is checked first. */
export function validateNewTicket(input: { subject: unknown; message: unknown }): NewTicketResult {
  const subject = text(input.subject);
  const body = text(input.message);
  if (subject.length < TICKET_SUBJECT_MIN || subject.length > TICKET_SUBJECT_MAX) return { ok: false, error: 'subject' };
  if (body.length < TICKET_BODY_MIN || body.length > TICKET_BODY_MAX) return { ok: false, error: 'message' };
  return { ok: true, subject, body };
}

export type TicketReplyResult = { ok: true; body: string } | { ok: false; error: 'message' };

/** A reply: 1-2000 characters, trimmed. */
export function validateTicketReply(message: unknown): TicketReplyResult {
  const body = text(message);
  if (body.length < TICKET_REPLY_MIN || body.length > TICKET_BODY_MAX) return { ok: false, error: 'message' };
  return { ok: true, body };
}
