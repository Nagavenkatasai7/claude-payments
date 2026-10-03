import { MFA_RECOVERY_CATEGORY } from './ticket-category';
import type { Ticket } from './types';

/**
 * customer-mfa-recovery-rules: the pure, client-safe half of the lost-authenticator recovery
 * (lost-features p4 B4). The fixed ticket text, the closed check and decline-reason lists, the
 * approval rules and the staff copy helpers. No server import, so the staff card's client forms
 * and the ticket pages can use it. The writes live in customer-mfa-recovery.ts.
 */

export const MFA_RECOVERY_SUBJECT = 'Lost authenticator app: turn off two-step verification';
export const MFA_RECOVERY_BODY =
  'I lost access to my authenticator app. Please turn off two-step verification for my account after checking it is me.';

/** What staff may record they checked. At least one STRONG check is required. */
export const RECOVERY_CHECKS = ['id_document', 'recent_transfer', 'kyc_name', 'callback'] as const;
export type RecoveryCheck = (typeof RECOVERY_CHECKS)[number];
const STRONG_CHECKS: readonly RecoveryCheck[] = ['id_document', 'recent_transfer'];

export const RECOVERY_DECLINE_REASONS = ['not_verified', 'no_response', 'duplicate'] as const;
export type RecoveryDeclineReason = (typeof RECOVERY_DECLINE_REASONS)[number];

/** Without an ID document check, approval waits this long after the request. */
export const RECOVERY_COOL_OFF_MS = 24 * 60 * 60 * 1000;
/** New requests per (partner, phone) per UTC day. */
export const RECOVERY_DAILY_CAP = 3;

/**
 * The /admin-dashboard refusal for an ordinary reply / resolve / close on a recovery ticket (that
 * surface has no catalogue). /partner uses partner.support.mfaRecovery.locked.
 */
export const RECOVERY_LOCKED_MESSAGE = 'This is a two-step recovery request. Approve or decline it in the recovery card.';

// ── Pure rules ───────────────────────────────────────────────────────────────

/** A two-step recovery request: only the dedicated approve and decline actions may move it. */
export function isRecoveryTicket(ticket: Pick<Ticket, 'kind' | 'category'>): boolean {
  return ticket.kind === 'customer' && ticket.category === MFA_RECOVERY_CATEGORY;
}

/** An OPEN request this module opened: the category, the fixed subject and a customer phone. */
export function isOpenRecoveryRequest(ticket: Ticket): boolean {
  return (
    isRecoveryTicket(ticket) &&
    ticket.subject === MFA_RECOVERY_SUBJECT &&
    typeof ticket.customerPhone === 'string' &&
    ticket.customerPhone.length > 0 &&
    ticket.status !== 'resolved' &&
    ticket.status !== 'closed'
  );
}

/** The checks from a form: known values once each, in RECOVERY_CHECKS order; null without a strong one. */
export function parseRecoveryChecks(values: readonly unknown[]): RecoveryCheck[] | null {
  const picked = RECOVERY_CHECKS.filter((c) => values.includes(c));
  return picked.some((c) => STRONG_CHECKS.includes(c)) ? picked : null;
}

export function parseDeclineReason(v: unknown): RecoveryDeclineReason | null {
  return typeof v === 'string' && (RECOVERY_DECLINE_REASONS as readonly string[]).includes(v) ? (v as RecoveryDeclineReason) : null;
}

/** When a request made at `requestedAt` may be approved with these checks (epoch ms). */
export function recoveryApprovableAt(requestedAt: string, checks: readonly RecoveryCheck[]): number {
  const at = Date.parse(requestedAt);
  return checks.includes('id_document') ? at : at + RECOVERY_COOL_OFF_MS;
}

/** A fixed UTC label for the end of the wait (the action's refusal and the staff card agree). */
export function recoveryTimeLabel(ms: number): string {
  const when = new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  // Some ICU versions put a narrow no-break space before AM/PM: one plain space everywhere.
  return `${when.replace(/\s+/g, ' ')} UTC`;
}

/** What the approve / decline actions on both dashboards return (`error` is fixed copy). */
export type RecoveryActionResult = { ok: true; outcome: 'approved' | 'already_off' | 'declined' } | { ok: false; error: string };
