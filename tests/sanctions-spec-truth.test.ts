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
//  - (review S5) the S5 line, the no-refund alerts quoted in section 6 (each
//    in src/), the exact no-state blocks of Money copy and the section 9 gap;
//  - (review S6) the S6 line, the railfail: (partner-funded) and
//    cancelcharged: quotes, the instructsenderhold texts and the section 9
//    list of the alerts that follow the rule;
//  - the ops-alert table names every new dedupe key of the pack, every key it
//    names exists in src/, and every literal piece of each quoted alert text
//    (the parts between <placeholders>) is in the code.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_RESCREEN_REFUSALS, RESCREEN_RELEASE_REFUSAL } from '@/lib/dashboard-ops';
import {
  SANCTIONS_FUNDS_RULE,
  SANCTIONS_FUNDS_SENTENCE,
  SANCTIONS_NO_PAYOUT_RULE,
  SANCTIONS_NO_PAYOUT_SENTENCE,
} from '@/lib/sanctions/notices';

const ROOT = join(__dirname, '..');
const spec = readFileSync(join(ROOT, 'docs/compliance/sanctions-screening-spec.md'), 'utf8');

// Review S5: the one phrasing of the no-refund rule lives in exported
// constants (src/lib/sanctions/notices.ts); a text that interpolates one is
// read with the constant's value in its place.
const RULE_CONSTANTS: Record<string, string> = {
  SANCTIONS_FUNDS_RULE,
  SANCTIONS_FUNDS_SENTENCE,
  SANCTIONS_NO_PAYOUT_RULE,
  SANCTIONS_NO_PAYOUT_SENTENCE,
};

/**
 * Every .ts / .tsx file under src/, concatenated, with string concatenations
 * across lines joined and the no-refund rule constants expanded.
 */
function srcText(): string {
  const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  const all = files.map((f) => readFileSync(join(ROOT, 'src', f), 'utf8')).join('\n');
  // 'a ' +\n   'b' (any mix of ' and `) => 'a b'
  return all
    .replace(/['`]\s*\+\s*\n\s*['`]/g, '')
    .replace(/\$\{(SANCTIONS_(?:FUNDS|NO_PAYOUT)_(?:RULE|SENTENCE))\}/g, (_, name: string) => RULE_CONSTANTS[name]);
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

  // Review S5 (W1, W2, W4): the S5 line, the alerts that use the no-refund
  // sentence (quoted in section 6, each piece in src/), the exact no-state
  // blocks in Money copy, and section 9 says what is true now.
  it('S5: section 10 has one S5 line after the last-check lines', () => {
    const s10 = section('## 10.');
    const last = s10.slice(s10.indexOf('### Changes after the last check'));
    expect(last.split('\n').filter((l) => l.startsWith('- **S5**'))).toHaveLength(1);
  });

  it('S5: section 6 quotes every no-refund alert added by S5, each text is in the code, and none tells anyone to refund', () => {
    const s6 = section('## 6.');
    const start = s6.indexOf('- **No refund on a match**');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = s6.slice(start, s6.indexOf('\nWho is told:', start));
    const src = srcText();
    for (const key of ['fundblocked:', 'stripechargedmoved:', 'instructnotlive:', 'review:', 'instructsenderhold:', 'recon:', 'railamount:', 'railfail:', 'cancelcharged:', 'regecancel:', 'sendercancelfunds:']) {
      expect(block, key).toContain(`\`${key}<id>\``);
    }
    const quoted = [...block.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
    // 11 from S5, plus railfail: (partner-funded) and cancelcharged: (S6).
    expect(quoted.length).toBe(13);
    for (const text of quoted) {
      expect(text).toContain(SANCTIONS_FUNDS_RULE);
      expect(text).not.toMatch(/refund it|refund at|retry it from Refunds|cancel\/refund/i);
      for (const piece of text.split(/<[^>]+>/).map((p) => p.trim()).filter((p) => p.length >= 8)) {
        expect(src, `section 6 piece "${piece}"`).toContain(piece);
      }
    }
  });

  it('S5 W4: Money copy names the payment-link PAYEE screen (stage payee) as a no-state block, and the stage pay re-screens of a minted row as passing the state', () => {
    const money = /^- \*\*Money copy\*\*(.*)$/m.exec(section('## 6.'))?.[1] ?? '';
    expect(money).toContain('Stage `pay` covers the pay page and the payment-link retry of an already minted transfer');
    expect(money).toContain('the payment-link payee screen, stage `payee`');
    expect(money).toContain('a row bound to a payment-provider intent with no charge reference yet');
    expect(money).not.toContain('(card, mint, payment links, payee, seller)');
    const table = section('## 11.').split('\n');
    for (const key of ['sanctionsblock:', 'sanctionsblockmail:']) {
      const row = table.find((l) => l.startsWith(`| \`${key}`))!;
      expect(row, key).toContain('the payment-link payee screen, stage `payee`');
      expect(row, key).not.toContain('payment links,');
    }
  });

  it('S5: the instructnotlive match text and the instructsenderhold text never say to refund', () => {
    const table = section('## 11.').split('\n');
    const inl = [...table.find((l) => l.startsWith('| `instructnotlive:'))!.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
    const match = inl.find((t) => t.includes('Last screen was a sanctions match.'))!;
    expect(match).toContain('No automatic re-screen follows.');
    expect(match).not.toMatch(/refund it/);
    const sh = [...table.find((l) => l.startsWith('| `instructsenderhold:'))!.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
    expect(sh[0]).toContain('A platform person must review the sender screening hold.');
    expect(sh[0]).not.toMatch(/or refund the transfer/);
  });

  it('S5/S6: section 9 names the alerts that follow the no-refund rule, says static labels do not, and names the rail-failure auto refund', () => {
    const gap = /^- \*\*Reject and Refund on a blocked transfer\*\*(.*)$/m.exec(section('## 9.'))?.[1] ?? '';
    expect(gap).toContain('none of these texts tells anyone to refund (review S5, S6)');
    for (const key of ['fundblocked:', 'stripechargedmoved:', 'instructnotlive:', 'review:', 'instructsenderhold:', 'recon:', 'railamount:', 'railfail:', 'cancelcharged:', 'regecancel:', 'sendercancelfunds:', 'paidmatch:', 'listrescreenblock:']) {
      expect(gap, key).toContain(`\`${key}\``);
    }
    expect(gap).toContain('Static dashboard labels and buttons do not follow the rule');
    expect(gap).toContain('"release or refund on the Compliance page"');
    expect(gap).not.toMatch(/Every ops alert and partner notice that can fire/);
    expect(gap).toContain('`failPaidFromRail`');
    expect(gap).not.toContain('The alerts tell them not to before');
  });

  // Review S6 (Y1, Y2, Y3).
  it('S6: section 10 has one S6 line after the S5 line', () => {
    const s10 = section('## 10.');
    const last = s10.slice(s10.indexOf('### Changes after the last check')).split('\n');
    const s5 = last.findIndex((l) => l.startsWith('- **S5**'));
    const s6 = last.findIndex((l) => l.startsWith('- **S6**'));
    expect(last.filter((l) => l.startsWith('- **S6**'))).toHaveLength(1);
    expect(s6).toBeGreaterThan(s5);
  });

  it('S6: instructsenderhold speaks about THIS instruction, and its partner-pulled text never says "nothing was charged"', () => {
    const row = section('## 11.').split('\n').find((l) => l.startsWith('| `instructsenderhold:'))!;
    const texts = [...row.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
    const full = texts.filter((t) => t.startsWith('⚠️'));
    expect(full).toHaveLength(2);
    for (const t of full) {
      expect(t).toContain('but this instruction was not sent to the rail:');
      expect(t).not.toContain('nothing was sent to the rail');
    }
    const pulled = full.find((t) => t.includes("The partner's rail pulls the sender's funds only on an instruction"))!;
    expect(pulled).toContain("the rail may have pulled the sender's funds: check with the rail.");
    expect(pulled).not.toMatch(/nothing was charged/);
    expect(texts).not.toContain('nothing was charged');
    expect(section('## 4.')).not.toContain('nothing was sent to the rail');
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
