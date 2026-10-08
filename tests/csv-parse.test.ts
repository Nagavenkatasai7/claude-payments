import { describe, it, expect } from 'vitest';
import { parseCsv, CSV_MAX_BYTES } from '@/lib/csv-parse';

// Batch B2: the small CSV reader behind the payment-link bulk upload (no new
// package). RFC 4180 quoting, any line ending, a BOM, blank lines; a row cap
// and a size cap; an unterminated quote is a clear error, never a guess.

describe('parseCsv', () => {
  it('reads a header and rows', () => {
    const r = parseCsv('name,phone\nAsha,14155550100\nRavi,14155550101\n');
    expect(r).toEqual({ ok: true, header: ['name', 'phone'], rows: [['Asha', '14155550100'], ['Ravi', '14155550101']], lines: [2, 3] });
  });

  it('handles CRLF, a lone CR and no trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toMatchObject({ ok: true, rows: [['1', '2'], ['3', '4']] });
    expect(parseCsv('a,b\r1,2\r3,4\r')).toMatchObject({ ok: true, rows: [['1', '2'], ['3', '4']] });
  });

  it('strips a UTF-8 BOM (Excel "CSV UTF-8")', () => {
    expect(parseCsv('﻿name,phone\nA,1')).toMatchObject({ ok: true, header: ['name', 'phone'] });
  });

  it('quoted fields keep commas, newlines and doubled quotes', () => {
    const r = parseCsv('name,note\n"Shah, Asha","line1\nline2"\n"Say ""hi""",x\n');
    expect(r).toMatchObject({ ok: true, rows: [['Shah, Asha', 'line1\nline2'], ['Say "hi"', 'x']] });
    // The line number of a row is where it STARTS (the report points there).
    expect(r.ok && r.lines).toEqual([2, 4]);
  });

  it('skips blank lines and rows of only empty cells', () => {
    const r = parseCsv('a,b\n\n1,2\n,\n  \n3,4\n');
    expect(r).toMatchObject({ ok: true, rows: [['1', '2'], ['3', '4']] });
  });

  it('keeps short rows short (the caller reports missing cells)', () => {
    expect(parseCsv('a,b,c\n1,2\n')).toMatchObject({ ok: true, rows: [['1', '2']] });
  });

  it('an unterminated quote is an error', () => {
    expect(parseCsv('a,b\n"open,2\n')).toEqual({ ok: false, error: 'unterminated_quote' });
  });

  it('a quote inside an unquoted field is an error (not a silent guess)', () => {
    expect(parseCsv('a,b\nab"c,2\n')).toEqual({ ok: false, error: 'bad_quote' });
    expect(parseCsv('a,b\n"ab"c,2\n')).toEqual({ ok: false, error: 'bad_quote' });
  });

  it('an empty file or a header only is an error', () => {
    expect(parseCsv('')).toEqual({ ok: false, error: 'empty' });
    expect(parseCsv('\n\n')).toEqual({ ok: false, error: 'empty' });
    expect(parseCsv('a,b\n')).toEqual({ ok: false, error: 'no_rows' });
  });

  it('caps the data rows (default 500)', () => {
    const body = Array.from({ length: 500 }, (_, i) => `${i},x`).join('\n');
    expect(parseCsv(`a,b\n${body}`)).toMatchObject({ ok: true });
    expect(parseCsv(`a,b\n${body}\n501,x`)).toEqual({ ok: false, error: 'too_many_rows' });
    expect(parseCsv('a,b\n1,x\n2,x\n3,x', { maxRows: 2 })).toEqual({ ok: false, error: 'too_many_rows' });
  });

  it('caps the size before parsing', () => {
    expect(parseCsv('a\n' + 'x'.repeat(CSV_MAX_BYTES))).toEqual({ ok: false, error: 'too_large' });
  });

  it('caps the number of columns', () => {
    expect(parseCsv(`${Array.from({ length: 51 }, (_, i) => `c${i}`).join(',')}\n1`)).toEqual({ ok: false, error: 'too_many_columns' });
  });
});
