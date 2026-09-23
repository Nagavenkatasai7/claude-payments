// ticket-category — the categories a ticket can carry that are NOT part of the
// copilot's closed triage list (TICKET_CATEGORIES in ticket-ai.ts).
//
// Program-Fix 34B: a case the WhatsApp bot opens because the customer asked for
// a person is filed as category 'human_help'. The category is set by the code
// that creates the case, and AI triage never overwrites it (outbox-worker.ts
// `case 'ticket.triage'` sets only the priority). TICKET_CATEGORIES is
// deliberately NOT widened: the copilot and staff triage keep their closed list.

export const HUMAN_HELP_CATEGORY = 'human_help';

/** The fixed subject of a help case. Nothing updates a ticket's subject after creation. */
export const HUMAN_HELP_SUBJECT = 'Customer asked for a person';

const LABELS: Readonly<Record<string, string>> = {
  [HUMAN_HELP_CATEGORY]: 'Human help',
};

/** The staff-facing label for a ticket category. Unknown values render as-is; none renders as a dash. */
export function ticketCategoryLabel(category: string | null | undefined): string {
  if (!category) return '—';
  return LABELS[category] ?? category;
}
