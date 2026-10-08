// csv-parse — Batch B2. A small RFC 4180 CSV reader for the payment-link bulk
// upload (no new package). Pure: no I/O, no Date.
//
//  • quoted fields keep commas, line breaks and doubled quotes ("");
//  • CRLF, LF and a lone CR all end a row; a UTF-8 BOM is dropped;
//  • blank lines and rows of only empty cells are skipped;
//  • a quote in the middle of an unquoted field, or a closing quote followed by
//    anything but a comma or a line end, is an error — never a guess;
//  • caps: CSV_MAX_BYTES of text, `maxRows` data rows (default 500), 50 columns.
// Values are returned exactly as written (no trimming): the caller decides.

export const CSV_MAX_BYTES = 512 * 1024;
export const CSV_MAX_ROWS = 500;
export const CSV_MAX_COLUMNS = 50;

export type CsvError =
  | 'empty'
  | 'no_rows'
  | 'too_many_rows'
  | 'too_large'
  | 'too_many_columns'
  | 'unterminated_quote'
  | 'bad_quote';

export type CsvResult =
  | {
      ok: true;
      header: string[];
      rows: string[][];
      /** The 1-based line where each data row starts (for the row-by-row report). */
      lines: number[];
    }
  | { ok: false; error: CsvError };

/**
 * One CSV cell for a file a partner opens in a spreadsheet: a cell that would
 * run as a formula (= + - @, tab, CR first) gets a leading apostrophe, and a
 * cell with a comma, quote or line break is quoted with doubled quotes.
 */
export function csvCell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows → CSV text (CRLF line ends, a trailing CRLF). */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function parseCsv(text: string, opts: { maxRows?: number } = {}): CsvResult {
  const maxRows = opts.maxRows ?? CSV_MAX_ROWS;
  if (text.length > CSV_MAX_BYTES) return { ok: false, error: 'too_large' };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: Array<{ cells: string[]; line: number }> = [];
  let cells: string[] = [];
  let field = '';
  let line = 1;
  let rowStart = 1;
  let i = 0;
  let quoted = false; // the current field started with a quote
  let afterQuote = false; // the closing quote of a quoted field was read

  const endField = () => {
    cells.push(field);
    field = '';
    quoted = false;
    afterQuote = false;
  };
  const endRow = (): CsvError | null => {
    endField();
    if (cells.some((c) => c.trim() !== '')) {
      if (cells.length > CSV_MAX_COLUMNS) return 'too_many_columns';
      records.push({ cells, line: rowStart });
      // header + maxRows data rows; one more is already too many
      if (records.length > maxRows + 1) return 'too_many_rows';
    }
    cells = [];
    return null;
  };

  while (i < src.length) {
    const ch = src[i];
    if (quoted && !afterQuote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        afterQuote = true;
        i += 1;
        continue;
      }
      if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      const err = endRow();
      if (err) return { ok: false, error: err };
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line += 1;
      rowStart = line;
      continue;
    }
    if (afterQuote) return { ok: false, error: 'bad_quote' };
    if (ch === '"') {
      if (field !== '') return { ok: false, error: 'bad_quote' };
      quoted = true;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted && !afterQuote) return { ok: false, error: 'unterminated_quote' };
  const err = endRow();
  if (err) return { ok: false, error: err };

  if (records.length === 0) return { ok: false, error: 'empty' };
  const [head, ...data] = records;
  if (data.length === 0) return { ok: false, error: 'no_rows' };
  return { ok: true, header: head.cells, rows: data.map((r) => r.cells), lines: data.map((r) => r.line) };
}
