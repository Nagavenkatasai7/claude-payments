import type { Transfer } from './types';
import type { RegClass } from './reg-clocks';
import { refundDisposition } from './refund-policy';
import { addBusinessDays } from './remittance-disclosure';

/**
 * Fix pack 8 (R44, P5): what a customer's report about a transfer opens.
 *
 * - A report is NEVER refused and never answered "recovery is no longer
 *   possible": a consumer row always opens a regulatory case of a class; a B2B
 *   or sandbox row keeps today's untimed recall ticket (`not_consumer`).
 * - Inside the cancel window the case is an error notice marked `cancellable`
 *   so the caller ALSO offers the existing cancel path (DP13: there is no
 *   sender_cancel route; a customer who then does not cancel keeps the case).
 * - The notice window is 180 calendar days from the disclosed availability
 *   date, computed in the customer's favour: the LATER of the delivery time and
 *   the promised date (paid + delivery business days, the receipt's rule).
 * - `complianceStatus` is in the input shape but is never read: a held row
 *   routes exactly like any other (no tipping off).
 *
 * Pure and client-safe: runtime imports only refund-policy and
 * remittance-disclosure. It must NOT import partner-config (node:crypto via
 * disclosure-hash); NOTICE_DEFAULT_DELIVERY_DAYS is pinned equal to its
 * DEFAULT_DELIVERY_BUSINESS_DAYS by tests/error-notice.test.ts.
 */

export const REPORT_CODES = Object.freeze([
  'wrong_recipient',
  'wrong_amount',
  'not_received',
  'unauthorized',
  'other',
  'complaint',
  'cancellation',
] as const);
export type ReportCode = (typeof REPORT_CODES)[number];

/** Closed check: strings of the tuple only ('__proto__', 'toString' and non-strings -> false). */
export function isReportCode(v: unknown): v is ReportCode {
  return typeof v === 'string' && (REPORT_CODES as readonly string[]).includes(v);
}

export const NOTICE_WINDOW_DAYS = 180;
/** Equal to partner-config's DEFAULT_DELIVERY_BUSINESS_DAYS (pinned by a test; not imported, see header). */
export const NOTICE_DEFAULT_DELIVERY_DAYS = 1;

const DAY_MS = 86_400_000;
/** The fixed subject prefix of a transfer-bound case (DP6: the code lives in the subject). */
const CASE_SUBJECT_PREFIX = 'Recall request: ';

export type ReportTransfer = Pick<
  Transfer,
  'status' | 'transferType' | 'refundStatus' | 'paidAt' | 'deliveredAt' | 'deliveryBusinessDays' | 'environment' | 'complianceStatus'
>;

export interface ReportFacts {
  transfer: ReportTransfer;
  /** The acknowledged snapshot's delivery days; read only when the row has none. */
  snapshotDays: number | null;
  /** The charge time (stage1 outbox row) in ms; null falls back to paidAt (a hint only). */
  chargedAt: number | null;
  code: ReportCode;
  now: number;
}

/** DP13: no 'sender_cancel' kind and no refusal arm. */
export type ReportRoute =
  | { kind: 'case'; regClass: RegClass; refundPossible: boolean; cancellable: boolean }
  | { kind: 'not_consumer' };

function parseMs(v: string | undefined | null): number | null {
  if (!v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** The disclosed availability date: the later of delivered and paid + days; null when neither time is known. */
export function disclosedAvailableAt(t: ReportTransfer, snapshotDays: number | null): number | null {
  const days = t.deliveryBusinessDays ?? snapshotDays ?? NOTICE_DEFAULT_DELIVERY_DAYS;
  const paidMs = parseMs(t.paidAt);
  const promised = paidMs === null ? null : addBusinessDays(paidMs, days).getTime();
  const delivered = parseMs(t.deliveredAt);
  if (promised === null) return delivered;
  if (delivered === null) return promised;
  return Math.max(promised, delivered);
}

export function insideNoticeWindow(t: ReportTransfer, snapshotDays: number | null, now: number): boolean {
  const disclosed = disclosedAvailableAt(t, snapshotDays);
  return disclosed !== null && now <= disclosed + NOTICE_WINDOW_DAYS * DAY_MS;
}

const ERROR_NOTICE_REFUNDS = new Set(['none', 'requested', 'pending', 'failed']);

/** First match wins (P5 table). */
export function routeReport(f: ReportFacts): ReportRoute {
  const t = f.transfer;
  if (t.transferType === 'b2b' || t.environment === 'test') return { kind: 'not_consumer' };

  const chargedAtIso = f.chargedAt === null ? undefined : new Date(f.chargedAt).toISOString();
  const disposition = refundDisposition(t, f.now, chargedAtIso).kind;

  if (f.code === 'unauthorized') {
    return {
      kind: 'case',
      regClass: 'fraud_report',
      refundPossible: disposition === 'refundable',
      cancellable: disposition === 'cancellable',
    };
  }

  if (disposition === 'cancellable') {
    return { kind: 'case', regClass: 'error_notice', refundPossible: false, cancellable: true };
  }

  const refund = t.refundStatus ?? 'none';
  const errorNoticeState =
    (t.status === 'paid' && ERROR_NOTICE_REFUNDS.has(refund)) || t.status === 'in_review' || t.status === 'delivered';
  if (errorNoticeState && insideNoticeWindow(t, f.snapshotDays, f.now)) {
    return { kind: 'case', regClass: 'error_notice', refundPossible: disposition === 'refundable', cancellable: false };
  }

  return { kind: 'case', regClass: 'complaint', refundPossible: false, cancellable: false };
}

/** The report code of a case (closed; unknown -> 'other'). The fixed subject wins, then the class. */
export function reportCodeOf(ticket: { regClass: RegClass | null | undefined; subject: string }): ReportCode {
  if (ticket.subject.startsWith(CASE_SUBJECT_PREFIX)) {
    const rest = ticket.subject.slice(CASE_SUBJECT_PREFIX.length);
    if (isReportCode(rest)) return rest;
  }
  switch (ticket.regClass) {
    case 'cancellation':
      return 'cancellation';
    case 'complaint':
      return 'complaint';
    case 'fraud_report':
      return 'unauthorized';
    default:
      return 'other';
  }
}
