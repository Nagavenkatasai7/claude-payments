import { CSV_MAX_ROWS, parseCsv, toCsv, type CsvError } from './csv-parse';
import { LINK_STATUS_LABELS, linkDisplayStatus, parseLinkInput, type LinkField, type LinkInput, type LinkStatus } from './payment-links';
import type { TransferStatus } from './types';

// payment-link-bulk — Batch B2. The row-by-row check of a CSV upload (columns:
// name, phone, amount, reference, purpose). Pure: the action passes in the
// partner's references that already exist and the current rate; nothing is
// saved here. The partner sees this report BEFORE anything is created, then
// confirms; the create action runs this SAME function again on the same text
// (the client's copy of the report is never trusted).

export const BULK_COLUMNS = ['name', 'phone', 'amount', 'reference', 'purpose'] as const satisfies readonly LinkField[];

export const BULK_TEMPLATE_CSV =
  'name,phone,amount,reference,purpose\n' +
  'Asha Patel,14155550100,25000,INV-2026-001,education\n';

export interface BulkRow {
  /** The file line where the row starts. */
  line: number;
  /** The raw cells, trimmed and cut to 80 characters (display only; React escapes them). */
  cells: Record<LinkField, string>;
  ok: boolean;
  errors: string[];
  warnings: string[];
  value?: LinkInput;
}

export type BulkReport =
  | { ok: true; rows: BulkRow[]; valid: number; invalid: number; warned: number }
  | { ok: false; error: string };

const FILE_ERRORS: Readonly<Record<CsvError, string>> = {
  empty: 'The file is empty.',
  no_rows: 'The file has a header but no rows.',
  too_many_rows: `The file has more than ${CSV_MAX_ROWS} rows. Split it into smaller files.`,
  too_large: 'The file is too large. Split it into smaller files.',
  too_many_columns: 'The file has too many columns.',
  unterminated_quote: 'The file has a quote (") that is never closed. Check it and export it again.',
  bad_quote: 'The file has a stray quote (") inside a cell. Check it and export it again.',
};

const FIELD_LABEL: Readonly<Record<LinkField, string>> = {
  name: 'Name',
  phone: 'Phone',
  amount: 'Amount',
  reference: 'Reference',
  purpose: 'Purpose',
};

export function buildBulkReport(
  text: string,
  ctx: { existingReferences: ReadonlySet<string>; usdPerInr?: number },
): BulkReport {
  const csv = parseCsv(text);
  if (!csv.ok) return { ok: false, error: FILE_ERRORS[csv.error] };

  const index = new Map<string, number>();
  csv.header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (!index.has(key)) index.set(key, i);
  });
  const missing = BULK_COLUMNS.filter((c) => !index.has(c));
  if (missing.length > 0) {
    return { ok: false, error: `The file is missing the column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` };
  }

  const seen = new Set<string>();
  const rows: BulkRow[] = csv.rows.map((cellsIn, r) => {
    const cell = (c: LinkField) => (cellsIn[index.get(c)!] ?? '').trim();
    const cells = Object.fromEntries(BULK_COLUMNS.map((c) => [c, cell(c).slice(0, 80)])) as Record<LinkField, string>;
    const parsed = parseLinkInput(
      { name: cell('name'), phone: cell('phone'), amount: cell('amount'), reference: cell('reference'), purpose: cell('purpose') },
      { usdPerInr: ctx.usdPerInr },
    );
    const errors = parsed.ok
      ? []
      : BULK_COLUMNS.filter((c) => parsed.errors[c]).map((c) => `${FIELD_LABEL[c]}: ${parsed.errors[c]}`);
    if (parsed.ok) {
      const ref = parsed.value.reference;
      if (seen.has(ref)) errors.push('Reference: this reference is in the file twice; only the first row is used.');
      else if (ctx.existingReferences.has(ref)) errors.push('Reference: a link with this reference already exists.');
      seen.add(ref);
    }
    const ok = errors.length === 0;
    return {
      line: csv.lines[r],
      cells,
      ok,
      errors,
      warnings: parsed.warnings,
      ...(ok && parsed.ok ? { value: parsed.value } : {}),
    };
  });

  return {
    ok: true,
    rows,
    valid: rows.filter((r) => r.ok).length,
    invalid: rows.filter((r) => !r.ok).length,
    warned: rows.filter((r) => r.ok && r.warnings.length > 0).length,
  };
}

/** One row of the partner's link export (the repo's list row, narrowed to what the file shows). */
export interface ExportLink {
  reference: string;
  customerName: string;
  customerPhone: string;
  amountInr: number;
  purpose: string;
  payeeName: string;
  status: LinkStatus;
  expiresAt: Date;
  token: string;
  transferId: string | null;
  transferStatus: TransferStatus | null;
}

export const EXPORT_COLUMNS = [
  'reference', 'customer_name', 'customer_phone', 'amount_inr', 'purpose', 'company', 'status', 'expires_at', 'link', 'transfer_id',
] as const;

/**
 * The "Download all links" CSV. Every cell goes through csvCell (formula cells neutralised, so a
 * name typed by hand that starts with = + - @ never runs in the partner's spreadsheet). The link
 * column is filled only while the link can still be paid.
 */
export function linksExportCsv(links: readonly ExportLink[], urlFor: (token: string) => string, now: Date = new Date()): string {
  return toCsv([
    [...EXPORT_COLUMNS],
    ...links.map((l) => {
      const status = linkDisplayStatus(l, l.transferStatus, now);
      return [
        l.reference,
        l.customerName,
        l.customerPhone,
        l.amountInr.toFixed(2),
        l.purpose,
        l.payeeName,
        LINK_STATUS_LABELS[status],
        l.expiresAt.toISOString(),
        status === 'open' ? urlFor(l.token) : '',
        l.transferId ?? '',
      ];
    }),
  ]);
}
