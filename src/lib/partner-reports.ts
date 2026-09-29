import { PARTNER_MONEY_READ, PARTNER_REPORTS, type PartnerPolicy } from '@/lib/partner-access';
import { csvCell, STATEMENT_MAX_WINDOW_DAYS } from '@/lib/settlement-statement';
import { maskRecipientName, TRANSFER_STATUSES, type TransferEnv } from '@/lib/partner-transfers';
import type { Transfer, TransferStatus } from '@/lib/types';

// partner-reports (UI redesign M3-16): the PURE half of partner Reports. No I/O.
//
// A report is an async job (partner_report_jobs + an outbox 'partner.report' row written in ONE
// transaction). The worker builds a MASKED CSV from tenant-scoped, masked ledger reads, seals it
// with field-crypto (bound to the job's tenant and id), and the download route serves it once the
// job is ready, audited, for 7 days. This file owns the request parsing, the per-kind access
// policy, the allow-list projections and the limits.

export const REPORT_KINDS = ['settlements', 'transfers', 'fees_monthly'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const isReportKind = (v: unknown): v is ReportKind => typeof v === 'string' && (REPORT_KINDS as readonly string[]).includes(v);

/**
 * The row cap. Measured on PGlite (tests/partner-report-build-bench, see the PR): a 10k-row
 * transfers build stays well inside the 15 s wall box. Start at 10k, not 50k (plan review R4).
 */
export const MAX_REPORT_ROWS = 10_000;
/**
 * Bytes of CSV. The download is ONE non-streamed Response, and a Vercel Function's response body
 * is capped at 4.5 MB (vercel.com/docs/functions/limitations, "Request body size": "The maximum
 * payload size for the request body or the response body of a Vercel Function is 4.5 MB").
 */
export const MAX_REPORT_BYTES = 4_000_000;
/** Wall-time box for one build: a report never holds the worker (which also drains money rows) longer. */
export const REPORT_WALL_MS = 15_000;
/** A job STARTS only when at least this much of the worker invocation's budget remains. */
export const REPORT_MIN_BUDGET_MS = 20_000;
/** Owner default O7: a ready report is downloadable for 7 days, then its content is nulled. */
export const REPORT_TTL_MS = 7 * 86_400_000;
/** Per-tenant concurrency cap: queued + running jobs created within ACTIVE_JOB_WINDOW_MS. */
export const MAX_ACTIVE_JOBS = 3;
/**
 * Only jobs younger than this count as active. A job whose outbox row died stays 'queued' forever;
 * counting it without a bound would lock the tenant out of Reports for good.
 */
export const ACTIVE_JOB_WINDOW_MS = 60 * 60_000;
/** Per-tenant rate limit: at most this many report requests per rolling 24 h. */
export const DAILY_JOB_CAP = 20;
/** How many jobs the Reports page lists. */
export const REPORT_LIST_LIMIT = 25;

/**
 * ONE per-kind access rule, used by the request action, the list AND the download route
 * (plan review R4): a transfers export is a money read (admin, agent, finance); settlements and
 * monthly fees are finance reports (admin, finance).
 */
export function reportPolicy(kind: ReportKind): PartnerPolicy {
  return kind === 'transfers' ? PARTNER_MONEY_READ : PARTNER_REPORTS;
}

export function reportAllows(kind: ReportKind, role: string): boolean {
  return (reportPolicy(kind).roles as readonly string[]).includes(role);
}

// ── Request parsing ─────────────────────────────────────────────────────────

export interface WindowParams {
  /** ISO instant, inclusive (UTC midnight). */
  from: string;
  /** ISO instant, exclusive (UTC midnight after the last day). */
  to: string;
}
export type TransfersParams = WindowParams & { status?: TransferStatus; environment: TransferEnv };
export interface FeesParams {
  month: string;
}
export type ReportParams = WindowParams | TransfersParams | FeesParams;

export type ReportRequestError = 'kind' | 'date' | 'window' | 'future';
export type ParsedReportRequest =
  | { ok: true; kind: 'settlements'; params: WindowParams }
  | { ok: true; kind: 'transfers'; params: TransfersParams }
  | { ok: true; kind: 'fees_monthly'; params: FeesParams }
  | { ok: false; error: ReportRequestError };

const DAY_MS = 86_400_000;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM = /^(\d{4})-(\d{2})$/;
const MIN_YEAR = 2000;

function field(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim().slice(0, 32) : '';
}

/** A calendar date as its UTC midnight, or null (malformed or impossible, e.g. 2026-02-30). */
function parseYmd(raw: string): Date | null {
  const m = YMD.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || mo < 1 || mo > 12 || d < 1) return null;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t : null;
}

const utcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

function parseWindow(form: FormData, now: Date): { ok: true; params: WindowParams } | { ok: false; error: ReportRequestError } {
  const rawFrom = field(form, 'from');
  const rawTo = field(form, 'to');
  const tomorrow = new Date(utcDay(now).getTime() + DAY_MS);
  if (!rawFrom && !rawTo) {
    // The default window: the last 31 days, today included.
    const from = new Date(tomorrow.getTime() - STATEMENT_MAX_WINDOW_DAYS * DAY_MS);
    return { ok: true, params: { from: from.toISOString(), to: tomorrow.toISOString() } };
  }
  const from = parseYmd(rawFrom);
  const last = parseYmd(rawTo);
  if (!from || !last) return { ok: false, error: 'date' };
  const to = new Date(last.getTime() + DAY_MS); // the chosen last day is included
  if (to.getTime() > tomorrow.getTime()) return { ok: false, error: 'future' };
  if (to.getTime() <= from.getTime()) return { ok: false, error: 'window' };
  if (to.getTime() - from.getTime() > STATEMENT_MAX_WINDOW_DAYS * DAY_MS) return { ok: false, error: 'window' };
  return { ok: true, params: { from: from.toISOString(), to: to.toISOString() } };
}

/**
 * Parse a report request form into closed sets. Reads ONLY kind, from, to, month, status and
 * environment: any partnerId / partner / id field is ignored (the tenant is the session's).
 */
export function parseReportRequest(form: FormData, now: Date): ParsedReportRequest {
  const kind = field(form, 'kind');
  if (!isReportKind(kind)) return { ok: false, error: 'kind' };
  if (kind === 'fees_monthly') {
    const m = YM.exec(field(form, 'month'));
    if (!m) return { ok: false, error: 'date' };
    const [y, mo] = [Number(m[1]), Number(m[2])];
    if (y < MIN_YEAR || mo < 1 || mo > 12) return { ok: false, error: 'date' };
    if (Date.UTC(y, mo - 1, 1) > Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) return { ok: false, error: 'future' };
    return { ok: true, kind, params: { month: `${m[1]}-${m[2]}` } };
  }
  const w = parseWindow(form, now);
  if (!w.ok) return w;
  if (kind === 'settlements') return { ok: true, kind, params: w.params };
  const statusRaw = field(form, 'status');
  const status = (TRANSFER_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as TransferStatus) : undefined;
  const environment: TransferEnv = field(form, 'environment') === 'test' ? 'test' : 'live';
  return { ok: true, kind, params: { ...w.params, ...(status ? { status } : {}), environment } };
}

/** The [start, end) instants of a fees month (UTC). */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [y, mo] = month.split('-').map(Number);
  return { start: new Date(Date.UTC(y, mo - 1, 1)), end: new Date(Date.UTC(y, mo, 1)) };
}

// ── Projections ─────────────────────────────────────────────────────────────

export const TRANSFER_EXPORT_COLUMNS = [
  'reference',
  'created_at',
  'status',
  'compliance_status',
  'refund_status',
  'environment',
  'amount_source',
  'source_currency',
  'fee_source',
  'total_charge_source',
  'fx_rate',
  'amount_destination',
  'destination_currency',
  'destination_country',
  'payout_method',
  'sender_phone',
  'recipient',
  'payout_destination',
  'paid_at',
  'delivered_at',
] as const;
export type TransferExportColumn = (typeof TRANSFER_EXPORT_COLUMNS)[number];
export type CsvValue = string | number | null;
export type TransferExportRow = Record<TransferExportColumn, CsvValue>;

/**
 * `****` + the last 4 digits. ASCII asterisks rather than maskPhoneLast4's U+2022 bullets: the
 * file opens in spreadsheets that read a BOM-less CSV as Latin-1, where a bullet is mojibake.
 * Same disclosure (at most 4 digits).
 */
export function maskPhoneForCsv(phone: string | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length > 4 ? `****${digits.slice(-4)}` : '****';
}

/** The destination exactly as a MASKED read shows it (`****last4`); anything else collapses to `****`. */
function maskedDestination(v: string | undefined): string | null {
  if (!v) return null;
  return /^\*{4}[A-Za-z0-9]{0,4}$/.test(v) ? v : '****';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The transfers export row: an explicit ALLOW-LIST. No legal name, email, date of birth, address,
 * business name, full phone, full destination, settlement partner or hold reason is ever copied,
 * even when a caller passes a fully decrypted Transfer.
 */
export function transferExportRow(t: Transfer): TransferExportRow {
  return {
    reference: t.id,
    created_at: t.createdAt ?? null,
    status: t.status,
    compliance_status: t.complianceStatus ?? null,
    refund_status: t.refundStatus ?? 'none',
    environment: t.environment ?? 'live',
    amount_source: num(t.amountSource ?? t.amountUsd),
    source_currency: t.sourceCurrency ?? 'USD',
    fee_source: num(t.feeSource ?? t.feeUsd),
    total_charge_source: num(t.totalChargeSource ?? t.totalChargeUsd),
    fx_rate: num(t.fxRate),
    amount_destination: num(t.amountInr),
    destination_currency: t.destinationCurrency ?? 'INR',
    destination_country: t.destinationCountry ?? null,
    payout_method: t.payoutMethod ?? null,
    sender_phone: maskPhoneForCsv(t.phone),
    recipient: maskRecipientName(t.recipientName ?? ''),
    payout_destination: maskedDestination(t.payoutDestination),
    paid_at: t.paidAt ?? null,
    delivered_at: t.deliveredAt ?? null,
  };
}

export const FEES_COLUMNS = ['day', 'source_currency', 'transfers', 'amount_source', 'fee_source', 'fee_usd'] as const;
export type FeesRow = Record<(typeof FEES_COLUMNS)[number], CsvValue>;

/** One (UTC day, source currency) aggregate from the fees read. */
export interface FeesDayAggregate {
  day: string;
  currency: string;
  transfers: number;
  amountSource: number;
  feeSource: number;
  feeUsd: number;
}

export function feesMonthlyRows(rows: readonly FeesDayAggregate[]): FeesRow[] {
  return rows.map((r) => ({
    day: r.day,
    source_currency: r.currency,
    transfers: r.transfers,
    amount_source: r.amountSource,
    fee_source: r.feeSource,
    fee_usd: r.feeUsd,
  }));
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** The CSV header line (with its CRLF). */
export function csvHeader(columns: readonly string[]): string {
  return `${columns.join(',')}\r\n`;
}

/** One CSV line (with its CRLF); every string cell goes through the formula-injection guard. */
export function csvLine<C extends string>(columns: readonly C[], row: Record<C, CsvValue>): string {
  return `${columns.map((c) => csvCell(row[c])).join(',')}\r\n`;
}

/** RFC 4180 CSV, CRLF line endings: the same shape settlement-statement.toCsv writes. */
export function rowsToCsv<C extends string>(columns: readonly C[], rows: readonly Record<C, CsvValue>[]): string {
  return csvHeader(columns) + rows.map((r) => csvLine(columns, r)).join('');
}

/** `smartremit-<kind>-<yyyy-mm-dd>.csv`: a fixed shape with no tenant or customer data. */
export function reportFilename(kind: ReportKind, at: Date): string {
  return `smartremit-${kind}-${at.toISOString().slice(0, 10)}.csv`;
}

/** Job ids are v4-shaped uuids; anything else is a 404 before any query (a bad uuid cast is a 500). */
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (v: unknown): v is string => typeof v === 'string' && JOB_ID_RE.test(v);
