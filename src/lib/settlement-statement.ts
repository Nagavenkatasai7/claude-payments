import type {
  ComplianceStatus,
  CountryCode,
  CurrencyCode,
  PayoutMethod,
  RefundStatus,
  TransferStatus,
} from './types';

// settlement-statement — Program-Fix 31 PR A (rail-11). The pure half of the
// partner settlements statement (GET /api/partner/v1/settlements): query
// parsing, the row projection, page totals and CSV. The repo query lives in
// transfer-repo.listSettledPage; the service in partner-api-service.
//
// SmartRemit is non-custodial: a statement row is the INSTRUCTION ledger (what
// was paid / sent to a rail), never a record of funds held.
//
// Two invariants this file carries:
// • The projection is an ALLOW-LIST. settlementPartnerId (types.ts: "NEVER
//   customer/partner-API visible"), payout destinations and recipient
//   identity never appear, even if a caller passes a full Transfer.
// • The cursor carries paid_at as the POSTGRES TEXT value (µs precision) and is
//   never turned into a JS Date (ms), which would duplicate or skip rows that
//   share a millisecond at a page edge. The SQL compares
//   (paid_at, id) > ($text::timestamptz, $id); this file only VALIDATES the
//   text shape so a malformed cursor is a 400, never a cast error.

export const STATEMENT_DEFAULT_LIMIT = 100;
export const STATEMENT_MAX_LIMIT = 500;
export const STATEMENT_MAX_WINDOW_DAYS = 31;
const DAY_MS = 86_400_000;

/** The source a statement row is projected from (the repo selects only these columns). */
export interface SettledTransfer {
  id: string;
  status: TransferStatus;
  complianceStatus: ComplianceStatus;
  refundStatus?: RefundStatus;
  amountSource: number;
  sourceCurrency: CurrencyCode;
  feeSource: number;
  totalChargeSource: number;
  fxRate: number;
  amountInr: number; // the DESTINATION amount (name kept for back-compat)
  destinationCurrency?: CurrencyCode;
  destinationCountry: CountryCode;
  payoutMethod: PayoutMethod;
  paymentProviderRef?: string;
  fundingRef?: string;
  refundRef?: string;
  createdAt: string;
  paidAt?: string;
  deliveredAt?: string;
  refundedAt?: string;
}

export const STATEMENT_COLUMNS = [
  'reference',
  'status',
  'compliance_status',
  'refund_status',
  'amount_source',
  'source_currency',
  'fee_source',
  'total_charge_source',
  'fx_rate',
  'amount_destination',
  'destination_currency',
  'destination_country',
  'payout_rail',
  'provider_ref',
  'funding_ref',
  'refund_ref',
  'created_at',
  'paid_at',
  'delivered_at',
  'refunded_at',
] as const;

export type StatementColumn = (typeof STATEMENT_COLUMNS)[number];
export type StatementRow = Record<StatementColumn, string | number | null>;

export interface StatementCursor {
  /** paid_at exactly as Postgres printed it (`paid_at::text`) — µs intact. */
  paidAtText: string;
  id: string;
}

export interface StatementQuery {
  from: Date;
  to: Date;
  limit: number;
  cursor: StatementCursor | null;
  format: 'json' | 'csv';
}

export type ParseResult = { ok: true; query: StatementQuery } | { ok: false; error: string };

// ── dates ─────────────────────────────────────────────────────────────────

// YYYY-MM-DD, optionally THH:MM[:SS[.fff…]] and an optional zone (Z / ±HH:MM).
// No zone ⇒ UTC.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function validHms(h: number, mi: number, s: number): boolean {
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59;
}

function validOffset(z: string | undefined): boolean {
  if (!z || z === 'Z') return true;
  const [hh, mm] = z.slice(1).split(':').map(Number);
  return hh <= 14 && (mm === undefined || mm <= 59);
}

/** Parse a statement bound; null when malformed or impossible (2026-02-30). */
export function parseStatementDate(raw: string): Date | null {
  const m = ISO_RE.exec(raw);
  if (!m) return null;
  const [, ys, ms, ds, hs, mis, ss, frac, zone] = m;
  const y = Number(ys);
  const mo = Number(ms);
  const d = Number(ds);
  if (!validYmd(y, mo, d)) return null;
  if (hs === undefined) return new Date(Date.UTC(y, mo - 1, d));
  const h = Number(hs);
  const mi = Number(mis);
  const s = Number(ss ?? '0');
  if (!validHms(h, mi, s) || !validOffset(zone)) return null;
  const msPart = frac ? `.${frac.slice(0, 3).padEnd(3, '0')}` : '';
  const iso = `${ys}-${ms}-${ds}T${hs}:${mis}:${ss ?? '00'}${msPart}${zone ?? 'Z'}`;
  const t = new Date(iso);
  return isNaN(t.getTime()) ? null : t;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ── cursor ────────────────────────────────────────────────────────────────

// EXACTLY the shape transfer-repo.listSettledPage emits: fixed UTC text with
// all six µs digits and a '+00' offset. Anything else (another offset, which
// Postgres may reject at the ::timestamptz cast) is refused here as a 400.
const PG_TS_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.\d{6}\+00$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_MAX = 200; // encoded length cap, checked BEFORE decoding

export function encodeStatementCursor(paidAtText: string, id: string): string {
  return Buffer.from(`${paidAtText}|${id}`, 'utf8').toString('base64url');
}

/** Null for anything that is not exactly `<pg timestamptz text>|<id>`. */
export function decodeStatementCursor(cursor: string): StatementCursor | null {
  if (!cursor || cursor.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = text.lastIndexOf('|');
  if (sep < 0) return null;
  const paidAtText = text.slice(0, sep);
  const id = text.slice(sep + 1);
  if (!ID_RE.test(id)) return null;
  const m = PG_TS_RE.exec(paidAtText);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (!validYmd(y, mo, d) || !validHms(h, mi, s)) return null;
  return { paidAtText, id };
}

// ── query ─────────────────────────────────────────────────────────────────

type RawQuery = Record<string, string | null | undefined>;

/**
 * Parse GET /settlements query params. Reads ONLY from, to, limit, cursor and
 * format — every other key (partner_id included) is ignored: the partner comes
 * from the API key. Window is half-open [from, to) on paid_at, UTC.
 */
export function parseStatementQuery(q: RawQuery, now: Date): ParseResult {
  const rawFrom = q.from?.trim() || undefined;
  const rawTo = q.to?.trim() || undefined;
  let from: Date | null = null;
  let to: Date | null = null;
  if (rawFrom !== undefined) {
    from = parseStatementDate(rawFrom);
    if (!from) return { ok: false, error: '`from` must be an ISO date (YYYY-MM-DD) or datetime.' };
  }
  if (rawTo !== undefined) {
    to = parseStatementDate(rawTo);
    if (!to) return { ok: false, error: '`to` must be an ISO date (YYYY-MM-DD) or datetime.' };
  }
  if (!from && !to) {
    to = startOfUtcDay(now);
    from = new Date(to.getTime() - DAY_MS);
  } else if (!to) {
    to = new Date(from!.getTime() + DAY_MS);
  } else if (!from) {
    from = new Date(to.getTime() - DAY_MS);
  }
  if (to!.getTime() <= from!.getTime()) return { ok: false, error: '`to` must be after `from`.' };
  if (to!.getTime() - from!.getTime() > STATEMENT_MAX_WINDOW_DAYS * DAY_MS) {
    return { ok: false, error: `The window may be at most ${STATEMENT_MAX_WINDOW_DAYS} days.` };
  }

  let limit = STATEMENT_DEFAULT_LIMIT;
  const rawLimit = q.limit?.trim();
  if (rawLimit) {
    if (!/^\d+$/.test(rawLimit)) return { ok: false, error: `\`limit\` must be an integer from 1 to ${STATEMENT_MAX_LIMIT}.` };
    limit = Number(rawLimit);
    if (limit < 1 || limit > STATEMENT_MAX_LIMIT) {
      return { ok: false, error: `\`limit\` must be an integer from 1 to ${STATEMENT_MAX_LIMIT}.` };
    }
  }

  const rawFormat = (q.format?.trim() || 'json').toLowerCase();
  if (rawFormat !== 'json' && rawFormat !== 'csv') return { ok: false, error: '`format` must be json or csv.' };

  let cursor: StatementCursor | null = null;
  const rawCursor = q.cursor?.trim();
  if (rawCursor) {
    cursor = decodeStatementCursor(rawCursor);
    if (!cursor) return { ok: false, error: 'Invalid `cursor`.' };
  }

  return { ok: true, query: { from: from!, to: to!, limit, cursor, format: rawFormat } };
}

// ── projection ────────────────────────────────────────────────────────────

/** The statement row — an explicit allow-list; nothing else is ever copied. */
export function statementRow(t: SettledTransfer): StatementRow {
  return {
    reference: t.id,
    status: t.status,
    compliance_status: t.complianceStatus,
    refund_status: t.refundStatus ?? 'none',
    amount_source: t.amountSource,
    source_currency: t.sourceCurrency,
    fee_source: t.feeSource,
    total_charge_source: t.totalChargeSource,
    fx_rate: t.fxRate,
    amount_destination: t.amountInr,
    destination_currency: t.destinationCurrency ?? 'INR',
    destination_country: t.destinationCountry,
    payout_rail: t.payoutMethod,
    provider_ref: t.paymentProviderRef ?? null,
    funding_ref: t.fundingRef ?? null,
    refund_ref: t.refundRef ?? null,
    created_at: t.createdAt,
    paid_at: t.paidAt ?? null,
    delivered_at: t.deliveredAt ?? null,
    refunded_at: t.refundedAt ?? null,
  };
}

export interface StatementTotals {
  count: number;
  amount_source_minor_by_currency: Record<string, number>;
  amount_destination_minor_by_currency: Record<string, number>;
}

// Every supported currency (types.ts CurrencyCode) has 2 minor digits, the
// same scale as the numeric(…,2) ledger columns. Each amount is converted to
// an integer FIRST, then summed — never a float sum.
const toMinor = (v: number): number => Math.round(v * 100);

/** Totals for the rows ON THIS PAGE (every listed row, cancelled included). */
export function statementTotals(rows: StatementRow[]): StatementTotals {
  const src: Record<string, number> = {};
  const dst: Record<string, number> = {};
  for (const r of rows) {
    const sc = String(r.source_currency);
    const dc = String(r.destination_currency);
    src[sc] = (src[sc] ?? 0) + toMinor(Number(r.amount_source));
    dst[dc] = (dst[dc] ?? 0) + toMinor(Number(r.amount_destination));
  }
  return { count: rows.length, amount_source_minor_by_currency: src, amount_destination_minor_by_currency: dst };
}

// ── CSV ───────────────────────────────────────────────────────────────────

// Spreadsheet formula injection: a cell beginning with one of these is
// evaluated by Excel/Sheets. Neutralised with a bare ' INSIDE the quotes.
// String cells only — a number (e.g. a negative) stays numeric.
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const guarded = FORMULA_LEAD.test(v) ? `'${v}` : v;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/** RFC 4180 CSV: header row, CRLF line endings, every string cell quoted. */
export function toCsv(rows: StatementRow[]): string {
  const lines = [STATEMENT_COLUMNS.join(',')];
  for (const r of rows) lines.push(STATEMENT_COLUMNS.map((c) => csvCell(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
