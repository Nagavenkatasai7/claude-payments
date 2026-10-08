import { describe, it, expect } from 'vitest';
import { buildBulkReport, BULK_TEMPLATE_CSV } from '@/lib/payment-link-bulk';
import { csvCell, toCsv } from '@/lib/csv-parse';

// Batch B2: the CSV bulk upload is checked row by row BEFORE anything is saved.
// Columns: name, phone, amount, reference, purpose (purpose required, owner Oct 8).

const USD_PER_INR = 1 / 85;
const HEADER = 'name,phone,amount,reference,purpose';
const report = (body: string, existing: string[] = []) =>
  buildBulkReport(`${HEADER}\n${body}`, { existingReferences: new Set(existing), usdPerInr: USD_PER_INR });

describe('buildBulkReport', () => {
  it('checks every row and keeps the good ones', () => {
    const r = report('Asha,14155550100,25000,INV-1,education\nRavi,1.41556E+10,25000,INV-2,education\nMeera,14155550102,25000,INV-3,');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => [x.line, x.ok])).toEqual([[2, true], [3, false], [4, false]]);
    expect(r.rows[1].errors.join(' ')).toMatch(/Excel/);
    expect(r.rows[2].errors.join(' ')).toMatch(/purpose/i);
    expect(r.valid).toBe(1);
    expect(r.invalid).toBe(2);
    expect(r.rows[0].value).toMatchObject({ customerPhone: '14155550100', amountInr: 25000, purpose: 'education' });
  });

  it('columns may come in any order and any case; extra columns are ignored', () => {
    const r = buildBulkReport('Purpose, Reference ,AMOUNT,phone,name,notes\nmedical,INV-9,25000,14155550100,Asha,hello', {
      existingReferences: new Set(),
      usdPerInr: USD_PER_INR,
    });
    expect(r.ok && r.rows[0]).toMatchObject({ ok: true, value: { reference: 'INV-9', purpose: 'medical' } });
  });

  it('a missing column is a file error that names it', () => {
    const r = buildBulkReport('name,phone,amount,reference\nAsha,14155550100,25000,INV-1', { existingReferences: new Set() });
    expect(r).toEqual({ ok: false, error: 'The file is missing the column: purpose.' });
  });

  it('a reference twice in the file: the second row is refused', () => {
    const r = report('Asha,14155550100,25000,INV-1,gift\nRavi,14155550101,25000,INV-1,gift');
    expect(r.ok && r.rows.map((x) => x.ok)).toEqual([true, false]);
    expect(r.ok && r.rows[1].errors.join(' ')).toMatch(/twice/);
  });

  it('a reference already used by this partner is refused (the same file twice is safe)', () => {
    const r = report('Asha,14155550100,25000,INV-1,gift', ['INV-1']);
    expect(r.ok && r.rows[0]).toMatchObject({ ok: false });
    expect(r.ok && r.rows[0].errors.join(' ')).toMatch(/already/);
  });

  it('a row above $500 is a warning, not an error', () => {
    const r = report('Asha,14155550100,50000,INV-1,gift');
    expect(r.ok && r.rows[0]).toMatchObject({ ok: true });
    expect(r.ok && r.rows[0].warnings.join(' ')).toMatch(/\$500/);
    expect(r.ok && r.warned).toBe(1);
  });

  it('formula cells are refused', () => {
    const r = report('"=HYPERLINK(""http://evil"")",14155550100,25000,INV-1,gift\n@SUM(A1),14155550101,25000,INV-2,gift');
    expect(r.ok && r.rows[0].ok).toBe(false);
    expect(r.ok && r.rows[0].errors.join(' ')).toMatch(/start with/);
    expect(r.ok && r.rows[1].ok).toBe(false);
  });

  it('a short row reports the missing cells', () => {
    const r = report('Asha,14155550100');
    expect(r.ok && r.rows[0].ok).toBe(false);
  });

  it('file errors: too many rows, bad quote, empty', () => {
    const many = Array.from({ length: 501 }, (_, i) => `A,14155550100,25000,R${i},gift`).join('\n');
    expect(report(many)).toEqual({ ok: false, error: 'The file has more than 500 rows. Split it into smaller files.' });
    expect(buildBulkReport('', { existingReferences: new Set() })).toMatchObject({ ok: false });
    expect(report('"Asha,14155550100,25000,INV-1,gift')).toMatchObject({ ok: false });
  });

  it('the template has the five columns', () => {
    expect(BULK_TEMPLATE_CSV.split('\n')[0]).toBe(HEADER);
  });
});

describe('CSV writing (download)', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('neutralises a formula-like cell', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('-2')).toBe("'-2");
  });

  it('toCsv joins rows with CRLF', () => {
    expect(toCsv([['a', 'b'], ['1', '2']])).toBe('a,b\r\n1,2\r\n');
  });
});
