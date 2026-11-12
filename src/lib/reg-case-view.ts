/**
 * Fix pack 8 (R44, P14): the staff and partner view of a regulatory case: the
 * class label, the overdue state and the due date. Pure, client-safe: type
 * imports and date maths only (a ROOT of tests/client-import-chain.test.ts).
 * The regulatory display keys on `regClass`, never on `dueAt` alone (rowToTicket
 * keeps a due date when the stored class is unknown).
 */
import type { RegClass } from './reg-clocks';
import type { Ticket } from './types';

export const REG_CLASS_LABEL: Readonly<Record<RegClass, string>> = Object.freeze({
  error_notice: 'error notice',
  cancellation: 'cancellation',
  complaint: 'complaint',
  fraud_report: 'fraud report',
});

const OPEN_CASE_STATUSES: readonly Ticket['status'][] = ['open', 'pending', 'waiting_admin'];

/** An open classed case whose due date has passed. */
export function regCaseOverdue(t: Pick<Ticket, 'regClass' | 'dueAt' | 'status'>, now: number): boolean {
  if (!t.regClass || !t.dueAt) return false;
  if (!OPEN_CASE_STATUSES.includes(t.status)) return false;
  const due = Date.parse(t.dueAt);
  return Number.isFinite(due) && due < now;
}

const DUE_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/** A due date as staff read it: 'en-US', medium, on the UTC calendar. */
export function formatDueDate(iso: string): string {
  return DUE_FORMAT.format(new Date(iso));
}

/**
 * The keys a status audit row (`ticket.resolve` / `ticket.close` / `ticket.status`) adds on a
 * classed ticket (critic R6, P33): the class, the due date and whether the change came before it.
 * Undefined for an unclassed ticket, so its row stays byte-identical.
 */
export function regCaseStatusMeta(
  t: Pick<Ticket, 'regClass' | 'dueAt'>,
  now: number,
): { regClass: RegClass; dueAt: string; beforeDue: boolean } | undefined {
  if (!t.regClass || !t.dueAt) return undefined;
  return { regClass: t.regClass, dueAt: t.dueAt, beforeDue: now < Date.parse(t.dueAt) };
}

/** The refusal of applyTriageAction on a classed ticket (the SQL guard of setTriage is the real control). */
export const REG_CASE_TRIAGE_REFUSAL = 'A regulatory case keeps its priority and category.';
