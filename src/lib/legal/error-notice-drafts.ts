/**
 * Pack 8 (R44, P10): the fixed customer reply when a regulatory case opens, plus
 * the fixed staff strings of a case (subject, "Also reported" note, notice line,
 * internal class note), so the case writers, the bot, the receipt and portal forms
 * and the support forms never spell them twice.
 *
 * DRAFTS for counsel (ERROR_NOTICE_TEXT_VERSION ends in -draft). Pure and
 * client-safe: type imports only, no clock read, no Node built-in. The customer
 * text never states an outcome or a refund, never names a case class or a check,
 * and names the provider only through the provider line of pack 4 that the caller
 * passes in (a demo tenant has none, so the text never claims a provider).
 * Staff strings carry enum codes only, never the customer's words.
 */
import type { RegClass } from '../reg-clocks';
import type { ReportCode } from '../error-notice';

export const ERROR_NOTICE_TEXT_VERSION = 'error-notice-2026-11-draft'; // counsel confirms (R19)

export const CASE_ADD_INFO_HINT_CHAT = 'You can add information by replying here or in your case in your account.';
export const CASE_ADD_INFO_HINT_PAGE = 'You can add information in your case in your account.';

/** Equals PROVIDER_LINE_MAX of provider-line.ts (server-only, so not imported; pinned by test). */
export const CASE_REPLY_PROVIDER_MAX = 200;

const CASE_DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });

/** The long en-US date of an ISO timestamp, in UTC. RangeError on an unparseable value. */
export function formatCaseDate(dueAtIso: string): string {
  const d = new Date(dueAtIso);
  if (Number.isNaN(d.getTime())) throw new RangeError('bad case date');
  return CASE_DATE.format(d);
}

function providerSentence(line: string | null): string | null {
  if (typeof line !== 'string') return null;
  const flat = line.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const cut = Array.from(flat).slice(0, CASE_REPLY_PROVIDER_MAX).join('').trimEnd();
  return cut.endsWith('.') ? cut : `${cut}.`;
}

/** The customer's "case opened" reply (P10). One paragraph, fixed sentence order. */
export function caseOpenedReply(i: {
  caseId: string;
  dueAt: string;
  providerLine: string | null;
  reused: boolean;
  surface: 'chat' | 'page';
}): string {
  const parts = [
    i.reused ? 'We have added this to your open case.' : 'We have recorded your report.',
    `Your case reference is ${i.caseId}.`,
    `We will tell you the result by ${formatCaseDate(i.dueAt)}.`,
  ];
  const provider = providerSentence(i.providerLine);
  if (provider) parts.push(provider);
  parts.push(i.surface === 'chat' ? CASE_ADD_INFO_HINT_CHAT : CASE_ADD_INFO_HINT_PAGE);
  return parts.join(' ');
}

// Staff-side fixed strings (enum codes only).

/** Kept so a pack 7 build's findOpenRecallForTransfer still dedupes after a rollback (P8). */
export const CASE_SUBJECT_PREFIX = 'Recall request: ';

export function caseSubject(code: ReportCode): string {
  return `${CASE_SUBJECT_PREFIX}${code}`;
}

/** A transfer-less complaint from a support form (T15). */
export const COMPLAINT_CASE_SUBJECT = 'Complaint';

/** Exact text: help-case's ALSO_REPORTED and P8 step 2 dedupe on it. */
export function alsoReportedNote(code: ReportCode): string {
  return `Also reported: ${code}.`;
}

/** The customer-visible notice line of a case (P8): no class word. */
export function caseNoticeLine(i: { code: ReportCode; dueAt: string | null }): string {
  return `The customer reported a problem with this transfer (${i.code}). Due: ${i.dueAt ? formatCaseDate(i.dueAt) : 'none'}.`;
}

/** INTERNAL staff note only (never shown to the customer). */
export function caseClassNote(regClass: RegClass): string {
  return `Class: ${regClass}.`;
}
