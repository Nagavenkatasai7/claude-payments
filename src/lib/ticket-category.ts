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

/**
 * A customer's request to turn off two-step verification after losing the authenticator app. Set
 * only by the code that opens the request; triage never overwrites it (keepsCategoryOnTriage), and
 * only the dedicated approve / decline actions move the ticket.
 */
export const MFA_RECOVERY_CATEGORY = 'mfa_recovery';

/**
 * An internal ("Contact") thread addressed to the partner's own admins rather than to SmartRemit.
 * Internal threads with no category keep their original meaning: addressed to SmartRemit.
 */
export const TEAM_QUESTION_CATEGORY = 'team_question';

const LABELS: Readonly<Record<string, string>> = {
  [HUMAN_HELP_CATEGORY]: 'Human help',
  [MFA_RECOVERY_CATEGORY]: 'Two-step recovery',
  [TEAM_QUESTION_CATEGORY]: 'Team question',
};

/** Categories the creating code sets on purpose: AI or staff triage sets only the priority on these. */
const TRIAGE_KEPT: ReadonlySet<string> = new Set([HUMAN_HELP_CATEGORY, MFA_RECOVERY_CATEGORY]);

export function keepsCategoryOnTriage(category: string | null | undefined): boolean {
  return typeof category === 'string' && TRIAGE_KEPT.has(category);
}

/** The staff-facing label for a ticket category. Unknown values render as-is; none renders as a dash. */
export function ticketCategoryLabel(category: string | null | undefined): string {
  if (!category) return '—';
  return LABELS[category] ?? category;
}
