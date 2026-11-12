import { describe, it, expect } from 'vitest';
import { hashEntries } from '@/lib/sanctions/ofac-sdn-loader';
import {
  MHA_MAX_ALIASES,
  MHA_MAX_BYTES,
  MHA_MAX_ROWS,
  MHA_MIN_ENTRIES,
  MHA_NAME_MAX,
  MHA_SOURCE,
  parseInMhaCsv,
} from '@/lib/sanctions/in-mha-list';

// Fix pack 5 T31 (R08, P28): the India MHA (UAPA) curated CSV. Pure. Every name below is
// INVENTED (no real designation is used in a test).

const HEADER = 'id,type,name,aliases,weak_aliases,program,reference';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const row = (id: string, o: Partial<Record<'type' | 'name' | 'aliases' | 'weak' | 'program' | 'ref', string>> = {}) =>
  [id, o.type ?? 'Entity', o.name ?? `Invented Org ${id}`, o.aliases ?? '', o.weak ?? '', o.program ?? 'UAPA-1', o.ref ?? `SO ${id}`].join(',');

function errorsOf(text: string) {
  const r = parseInMhaCsv(text);
  if (r.ok) throw new Error('expected a refusal');
  return r.errors;
}

describe('in-mha-list constants (P28)', () => {
  it('the bounds are the contract values', () => {
    expect(MHA_SOURCE).toBe('in-mha-uapa');
    expect(MHA_MAX_BYTES).toBe(256 * 1024);
    expect(MHA_MAX_ROWS).toBe(2000);
    expect(MHA_MIN_ENTRIES).toBe(20);
    expect(MHA_NAME_MAX).toBe(200);
    expect(MHA_MAX_ALIASES).toBe(20);
  });
});

describe('parseInMhaCsv: header', () => {
  it('header exactly id,type,name,aliases,weak_aliases,program,reference (case-insensitive, trimmed)', () => {
    expect(parseInMhaCsv(' ID , Type,NAME,aliases,Weak_Aliases,program , reference\n' + row('a1')).ok).toBe(true);
  });
  it('anything else -> bad_header on row 1', () => {
    for (const h of ['id,type,name,aliases,program,reference', 'type,id,name,aliases,weak_aliases,program,reference', 'id,type,name,aliases,weak_aliases,program,reference,extra', '']) {
      expect(errorsOf(h + '\n' + row('a1'))).toEqual([{ row: 1, code: 'bad_header' }]);
    }
    expect(errorsOf('')).toEqual([{ row: 1, code: 'bad_header' }]);
  });
});

describe('parseInMhaCsv: a valid file', () => {
  it('source in-mha-uapa, ids inmha:<id>, names [name, ...aliases], weakNames only when present, programs [program], hash = hashEntries', () => {
    const r = parseInMhaCsv(
      csv(
        row('a1', { type: 'Individual', name: 'Ravindar Fictus', aliases: 'Ravi Fictus|R Fictus Kumar', weak: 'Fictoo', program: 'UAPA First Schedule' }),
        row('b-2.x_3', { name: 'Invented Front Org' }),
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.list.source).toBe('in-mha-uapa');
    expect(r.list.entries).toEqual([
      { id: 'inmha:a1', type: 'Individual', names: ['Ravindar Fictus', 'Ravi Fictus', 'R Fictus Kumar'], weakNames: ['Fictoo'], programs: ['UAPA First Schedule'] },
      { id: 'inmha:b-2.x_3', type: 'Entity', names: ['Invented Front Org'], programs: ['UAPA-1'] },
    ]);
    expect(r.list.entries[1]).not.toHaveProperty('weakNames');
    expect(r.list.hash).toBe(hashEntries(r.list.entries));
  });

  it('the version is NOT taken from the file (the action supplies it)', () => {
    const r = parseInMhaCsv(csv(row('a1', { ref: '2026-01-01' })));
    expect(r.ok && r.list.version).toBe('');
  });

  it('RFC 4180 quoting: a quoted field with a comma and a doubled quote parses', () => {
    const r = parseInMhaCsv(csv('q1,Entity,"Invented, ""Quoted"" Org",,,UAPA-1,"SO 1, item 2"'));
    expect(r.ok && r.list.entries[0].names).toEqual(['Invented, "Quoted" Org']);
  });

  it('CRLF and LF both work; a trailing newline is fine; a BOM is stripped', () => {
    const lf = parseInMhaCsv(csv(row('a1'), row('a2')) + '\n');
    const crlf = parseInMhaCsv('﻿' + [HEADER, row('a1'), row('a2')].join('\r\n') + '\r\n');
    expect(lf.ok && crlf.ok).toBe(true);
    if (!lf.ok || !crlf.ok) return;
    expect(crlf.list.entries).toEqual(lf.list.entries);
    expect(crlf.list.hash).toBe(lf.list.hash);
  });
});

describe('parseInMhaCsv: name_too_short (P11 finding)', () => {
  it('a name or alias with fewer than 3 letters after normalizeName -> that row errors', () => {
    expect(errorsOf(csv(row('a1'), row('a2', { aliases: 'Al|X' })))).toEqual([{ row: 3, code: 'name_too_short' }]);
    expect(errorsOf(csv(row('a1', { name: 'A. B.' })))).toEqual([{ row: 2, code: 'name_too_short' }]);
    expect(errorsOf(csv(row('a1', { name: '12 34 56' })))).toEqual([{ row: 2, code: 'name_too_short' }]);
  });
  it("'Ali' (3 letters) is fine", () => {
    expect(parseInMhaCsv(csv(row('a1', { name: 'Ali', aliases: 'Ali' }))).ok).toBe(true);
  });
  it('a weak alias follows the same rule', () => {
    expect(errorsOf(csv(row('a1', { weak: 'XY' })))).toEqual([{ row: 2, code: 'name_too_short' }]);
  });
});

describe('parseInMhaCsv: row errors carry row numbers and codes only', () => {
  const cases: Array<[string, string]> = [
    [row('a1', { name: '' }), 'empty_name'],
    [row('a1', { name: 'N'.repeat(201) }), 'name_too_long'],
    [row('a1', { aliases: 'Q'.repeat(201) }), 'name_too_long'],
    [row('a1', { aliases: Array.from({ length: 21 }, (_, i) => `Alias Number ${i}`).join('|') }), 'too_many_aliases'],
    [row('a1', { type: 'Vessel' }), 'bad_type'],
    [row('a1', { type: 'individual' }), 'bad_type'],
    [row('a b'), 'bad_id'],
    [row(''), 'bad_id'],
    [row('x'.repeat(41)), 'bad_id'],
    ['a1,Entity,Invented Org,,,UAPA-1', 'bad_columns'],
    ['a1,Entity,Invented Org,,,UAPA-1,ref,extra', 'bad_columns'],
    [row('a1', { name: 'Invented\u0007Org' }), 'bad_text'],
    ['a1,Entity,"Invented\nOrg",,,UAPA-1,ref', 'bad_text'],
    [row('a1', { ref: 'SO​1' }), 'bad_text'],
    // Pack 5 review LD1: U+FFFD is what a lossy decode leaves for a byte that is not UTF-8.
    [row('a1', { name: 'M�ller Invented' }), 'bad_text'],
    [row('a1', { aliases: 'Invented �lias' }), 'bad_text'],
    [row('a1', { ref: 'SO �1' }), 'bad_text'],
  ];
  for (const [r, code] of cases) {
    it(`${code}: ${JSON.stringify(r).slice(0, 40)}`, () => {
      expect(errorsOf(csv(row('ok1'), r))).toEqual([{ row: 3, code }]);
    });
  }

  it('exactly 20 aliases (strong and weak together) is fine', () => {
    const aliases = Array.from({ length: 15 }, (_, i) => `Alias Number ${i}`).join('|');
    const weak = Array.from({ length: 5 }, (_, i) => `Weak Alias ${i}`).join('|');
    expect(parseInMhaCsv(csv(row('a1', { aliases, weak }))).ok).toBe(true);
    expect(errorsOf(csv(row('a1', { aliases, weak: weak + '|One More' })))).toEqual([{ row: 2, code: 'too_many_aliases' }]);
  });

  it('duplicate_id on the second occurrence', () => {
    expect(errorsOf(csv(row('a1'), row('a2'), row('a1')))).toEqual([{ row: 4, code: 'duplicate_id' }]);
  });

  it('ONE bad row -> ok false and no list (all or none)', () => {
    const r = parseInMhaCsv(csv(...Array.from({ length: 30 }, (_, i) => row(`r${i}`)), row('bad', { type: 'Ship' })));
    expect(r).toEqual({ ok: false, errors: [{ row: 32, code: 'bad_type' }] });
    expect(r).not.toHaveProperty('list');
  });

  it('several bad rows are all reported, in order', () => {
    expect(errorsOf(csv(row('a1', { type: 'Ship' }), row('a2'), row('a 3', { name: '' })))).toEqual([
      { row: 2, code: 'bad_type' },
      { row: 4, code: 'bad_id' },
      { row: 4, code: 'empty_name' },
    ]);
  });

  it('more than 2,000 data rows -> too_many_rows; exactly 2,000 parse', () => {
    const rows = Array.from({ length: MHA_MAX_ROWS }, (_, i) => row(`r${i}`));
    expect(parseInMhaCsv(csv(...rows)).ok).toBe(true);
    expect(errorsOf(csv(...rows, row('one-more')))).toEqual([{ row: MHA_MAX_ROWS + 2, code: 'too_many_rows' }]);
  });

  it('zero rows -> no_rows', () => {
    expect(errorsOf(HEADER)).toEqual([{ row: 2, code: 'no_rows' }]);
    expect(errorsOf(HEADER + '\n\n')).toEqual([{ row: 2, code: 'no_rows' }]);
  });

  it('an unterminated quote -> bad_columns on its row', () => {
    expect(errorsOf(csv(row('a1'), 'a2,Entity,"Invented Org,,,UAPA-1,ref'))).toEqual([{ row: 3, code: 'bad_columns' }]);
  });

  it('no thrown error or error object contains a name from the input', () => {
    const secret = 'Zorvandel Quixotica';
    const bad = [
      row('a1', { name: secret, type: 'Ship' }),
      row('a 2', { name: secret }),
      row('a3', { name: `${secret}\u0007` }),
      row('a4', { aliases: `${secret}|Q` }),
      row('a5', { name: secret.repeat(20) }),
      `a6,Entity,${secret}`,
      `"${secret}`,
    ];
    for (const b of bad) {
      let out: unknown;
      expect(() => {
        out = parseInMhaCsv(csv(b));
      }).not.toThrow();
      expect(JSON.stringify(out)).not.toMatch(/Zorvandel|Quixotica/);
    }
    expect(JSON.stringify(parseInMhaCsv(`${secret},type\n` + row('a1')))).not.toMatch(/Zorvandel/);
  });
});
