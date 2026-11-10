// Pack 2 review R5 (J3 and the ops-alert table): the screening spec
// (docs/compliance/sanctions-screening-spec.md) goes to partners and counsel,
// so a few of its sentences are pinned against the code here:
//  - the section 10 A1 line states the instruct gate's pre-pack pass-through;
//  - section 10 lists every round 2 finding id, one line each;
//  - the ops-alert table names every new dedupe key of the pack, every key it
//    names exists in src/, and every literal piece of each quoted alert text
//    (the parts between <placeholders>) is in the code.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_RESCREEN_REFUSALS, RESCREEN_RELEASE_REFUSAL } from '@/lib/dashboard-ops';

const ROOT = join(__dirname, '..');
const spec = readFileSync(join(ROOT, 'docs/compliance/sanctions-screening-spec.md'), 'utf8');

/** Every .ts / .tsx file under src/, concatenated, with string concatenations across lines joined. */
function srcText(): string {
  const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  const all = files.map((f) => readFileSync(join(ROOT, 'src', f), 'utf8')).join('\n');
  // 'a ' +\n   'b' (any mix of ' and `) => 'a b'
  return all.replace(/['`]\s*\+\s*\n\s*['`]/g, '');
}

function section(title: string): string {
  const start = spec.indexOf(title);
  expect(start, `spec section "${title}"`).toBeGreaterThanOrEqual(0);
  const next = spec.indexOf('\n## ', start + title.length);
  return spec.slice(start, next === -1 ? undefined : next);
}

const NEW_ALERT_KEYS = [
  'instructnotlive:',
  'instructsenderhold:',
  'instructrescreen:',
  'paidmatch:',
  'paidmatchinstructed:',
  'sanctionsblock:',
  'sanctionsblockmail:',
  'sanctions-block-unrecorded:',
  'sanctions-list-not-live:',
  'listrescreenblock:',
  'listsweeperror:',
  'sanctions-archive-failed:',
  'sanctions-archive-mismatch:',
  'sanctions-archive-unconfigured:',
];

describe('sanctions screening spec says what the code does', () => {
  it('section 10 A1 states that rows screened before pack 2 still pass the instruct gate (J3)', () => {
    const a1 = /^- \*\*A1\*\*:(.*)$/m.exec(section('## 10.'))?.[1] ?? '';
    expect(a1).toMatch(/no evidence, or evidence written before pack 2, still passes/);
    expect(a1).toMatch(/release re-screens unless the newest screen is live and under 36 h old/);
  });

  it('section 10 lists every round 2 finding, one line each', () => {
    const s10 = section('## 10.');
    const round2 = s10.slice(s10.indexOf('### Changes after review round 2'));
    expect(round2.startsWith('### Changes after review round 2')).toBe(true);
    for (const id of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'G1', 'G2', 'H1', 'H2', 'H3', 'J1', 'J2', 'J3', 'J4', 'J5', 'J6', 'J7']) {
      const lines = round2.split('\n').filter((l) => l.startsWith(`- **${id}**`));
      expect(lines, id).toHaveLength(1);
    }
    expect(round2).toMatch(/^- \*\*E1\*\*: refuted/m);
    expect(round2).toMatch(/^- \*\*E3\*\*: refuted/m);
  });

  // Review round 3 (K2): rule 3a quotes the release refusals exactly as the code has them.
  it('rule 3a quotes the partner refusal and the three platform refusals verbatim (K2)', () => {
    for (const text of [RESCREEN_RELEASE_REFUSAL, ...Object.values(PLATFORM_RESCREEN_REFUSALS)]) {
      expect(spec, text).toContain(`"${text}"`);
    }
    expect(spec).not.toContain('releases it if that screen clears it');
  });

  // Review round 3 (M6): the listrescreenblock row quotes the charged and the uncharged text.
  it('the listrescreenblock row quotes both texts (M6)', () => {
    const row = section('## 11.').split('\n').find((l) => l.startsWith('| `listrescreenblock:'))!;
    const texts = [...row.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('It is charged, blocked by the re-screen, not paid out; reject and refund it.');
    expect(texts[1]).toContain('Nothing was charged or paid out; reject it.');
  });

  it('the ops-alert table names every new key, and its keys and texts are in the code', () => {
    const table = section('## 11.');
    const src = srcText();
    for (const k of NEW_ALERT_KEYS) expect(table, k).toContain(`| \`${k}`);
    const rows = table.split('\n').filter((l) => /^\| `[a-z-]+:/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(NEW_ALERT_KEYS.length);
    for (const row of rows) {
      const key = /^\| `([a-z-]+:)/.exec(row)![1];
      expect(src, key).toContain(key);
      // Quoted texts are «…» code spans in the "Text" column.
      for (const [, text] of row.matchAll(/«`([^`]+)`»/g)) {
        for (const piece of text.split(/<[^>]+>/).map((p) => p.trim()).filter((p) => p.length >= 8)) {
          expect(src, `${key} text piece "${piece}"`).toContain(piece);
        }
      }
    }
  });
});
