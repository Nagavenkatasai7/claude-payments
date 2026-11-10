// Pack 2 review R5 (J3 and the ops-alert table): the screening spec
// (docs/compliance/sanctions-screening-spec.md) goes to partners and counsel,
// so a few of its sentences are pinned against the code here:
//  - the section 10 A1 line states the instruct gate's pre-pack pass-through;
//  - section 10 lists every round 2 finding id, one line each, and (review
//    round 3) every round 3 finding id fixed;
//  - the instructnotlive row says the heal does not follow a match (M8) and
//    that the generic recon: and dead: alerts still do (P3);
//  - (after the last check) the N1/P1, P3 and refund wording lines, and no
//    match text in the table tells anyone to refund;
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

  // Review round 3: the round 3 list sits next to the round 2 list, one line per fixed finding.
  it('section 10 lists every round 3 finding, one line each, after the round 2 list', () => {
    const s10 = section('## 10.');
    const r2 = s10.indexOf('### Changes after review round 2');
    const r3 = s10.indexOf('### Changes after review round 3');
    expect(r3).toBeGreaterThan(r2);
    const round3 = s10.slice(r3);
    for (const id of ['K1', 'K2', 'K3', 'L1', 'M1', 'M2', 'M3', 'M5', 'M6', 'M7', 'M8']) {
      expect(round3.split('\n').filter((l) => l.startsWith(`- **${id}**`)), id).toHaveLength(1);
    }
  });

  // Review round 3 (M8): the heal follows a not-live or too-old refusal only.
  // After the last check (P3): after a match no HEAL alert follows, but the
  // generic recon: and dead: alerts still fire; no refund before the compliance
  // officer decides (refund wording).
  it('the instructnotlive row names the match case separately (M8, P3)', () => {
    const row = section('## 11.').split('\n').find((l) => l.startsWith('| `instructnotlive:'))!;
    const meaning = row.split(' | ').at(-1)!;
    expect(meaning).toContain('Only for "not on a live list" and "older than the list age limit": once the list is live the stuck-paid heal re-screens it');
    expect(meaning).toContain(
      'For "a sanctions match" the heal does not re-screen it, so no heal alert follows (`instructrescreen:`, `paidmatch:`, `paidmatchinstructed:`); ' +
        'the generic `recon:<id>` alert of the stuck-paid sweep and, once the instruct is dead-lettered, the `dead:` alert still fire',
    );
    expect(meaning).toContain(
      "A person must not pay it out and must not refund or return the funds until the licensed partner's compliance officer decides whether they must be blocked (frozen) or can be returned",
    );
    expect(spec).not.toContain('no further alert follows');
    expect(meaning).not.toContain('block and refund the transfer');
    expect(meaning).not.toMatch(/Once the list is live the stuck-paid heal re-screens it: a clear sends it; otherwise `instructrescreen:` or `paidmatch:` follows\./);
  });

  // Review round 3 (K2): rule 3a quotes the release refusals exactly as the code has them.
  it('rule 3a quotes the partner refusal and the three platform refusals verbatim (K2)', () => {
    for (const text of [RESCREEN_RELEASE_REFUSAL, ...Object.values(PLATFORM_RESCREEN_REFUSALS)]) {
      expect(spec, text).toContain(`"${text}"`);
    }
    expect(spec).not.toContain('releases it if that screen clears it');
  });

  // Review round 3 (M6), after the last check (N1/P1): the listrescreenblock
  // row quotes the charged, the partner-collected and the uncharged text.
  it('the listrescreenblock row quotes the three money texts (M6, N1/P1)', () => {
    const row = section('## 11.').split('\n').find((l) => l.startsWith('| `listrescreenblock:'))!;
    const texts = [...row.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('and the sender was charged. Leave the transfer as it is: do not pay it out');
    expect(texts[0]).toContain('(Reject refunds the sender).');
    expect(texts[1]).toContain("and the partner confirmed that it collected the sender's funds. Leave the transfer as it is");
    expect(texts[2]).toContain('Nothing was charged or paid out; reject it.');
    for (const t of texts.slice(0, 2)) expect(t).not.toMatch(/reject it|refund it/);
  });

  // After the last check: one line each, after the round 3 list; no match
  // text quoted in section 11 tells anyone to refund (refund wording).
  it('section 10 lists the last check (N1/P1, P3, refund wording) after round 3, and no match text says to refund', () => {
    const s10 = section('## 10.');
    const r3 = s10.indexOf('### Changes after review round 3');
    const last = s10.indexOf('### Changes after the last check');
    expect(last).toBeGreaterThan(r3);
    const lines = s10.slice(last).split('\n');
    for (const id of ['N1/P1', 'P3', 'refund wording']) expect(lines.filter((l) => l.startsWith(`- **${id}**`)), id).toHaveLength(1);
    const table = section('## 11.').split('\n');
    for (const key of ['sanctionsblock:', 'sanctionsblockmail:', 'paidmatch:', 'paidmatchinstructed:', 'listrescreenblock:']) {
      const row = table.find((l) => l.startsWith(`| \`${key}`))!;
      for (const [, text] of row.matchAll(/«`([^`]+)`»/g)) {
        expect(text, key).not.toMatch(/refund it|refund procedure|before any refund|reject and refund/i);
      }
    }
    const rescreen = table.find((l) => l.startsWith('| `instructrescreen:'))!;
    expect(rescreen).toContain('review it on the compliance page before any refund.');
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
