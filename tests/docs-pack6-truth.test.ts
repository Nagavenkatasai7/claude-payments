// Fix pack 6 T29 (P25): the documents that state pack 6's rules say what the
// built code does. Read from disk, like tests/docs-pack4-truth.test.ts and
// tests/docs-pack5-truth.test.ts (same `paragraph`, `section`, `claudeLine`
// helpers). A disk-reading guard: `vitest --changed` never selects it, so every
// later commit runs it by name (P0 rule 2).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AML_HOLD_RULES } from '@/lib/aml-hold';
import { AML_HOLD_REASON } from '@/lib/compliance-config';
import { ESIGN_CONSENT_LABEL } from '@/lib/legal/esign-consent';
import { RISK_ACK_LABEL } from '@/lib/legal/risk-warning';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** The paragraph of `text` that starts with `start` (up to the next blank line). */
function paragraph(text: string, start: string): string {
  const at = text.indexOf(start);
  expect(at, `paragraph "${start}"`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n\n', at);
  return text.slice(at, end === -1 ? undefined : end);
}

/** The section of `text` that starts with `title` (up to the next heading of the same or a higher level). */
function section(text: string, title: string): string {
  const start = text.indexOf(title);
  expect(start, `section "${title}"`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(title)![0];
  const stops = [...text.slice(start + title.length).matchAll(/\n(#+) /g)].filter((m) => m[1].length <= level.length);
  return stops.length ? text.slice(start, start + title.length + stops[0].index!) : text.slice(start);
}

const claudeLine = (prefix: string): string => {
  const line = read('CLAUDE.md').split('\n').find((l) => l.startsWith(prefix));
  expect(line, prefix).toBeDefined();
  return line!;
};

const ROLLBACK = read('docs/ROLLBACK.md');
const SPEC = read('docs/compliance/sanctions-screening-spec.md');
const GO_LIVE = read('src/content/docs/go-live.mdx');
const CHANGELOG = read('src/content/docs/changelog.mdx');
const PR5 = 'PR5 (signed instructions and the rail record) adds migration 0039, which is additive:';
const PR6 = 'PR6 (pay-step customer protection and AML holds before payout) adds migration 0040, which is additive:';
const SPEC_TITLE = '. Fix pack 6: AML holds before payout';

/** The pack 6 spec section: `## <n>. Fix pack 6: ...`, <n> one more than every other section number. */
function specPack6(): string {
  const heads = [...SPEC.matchAll(/^## (\d+)\. (.*)$/gm)];
  const mine = heads.find((m) => `. ${m[2]}` === SPEC_TITLE);
  expect(mine, SPEC_TITLE).toBeDefined();
  const n = Number(mine![1]);
  for (const h of heads) if (h !== mine) expect(Number(h[1]), h[0]).toBeLessThan(n);
  expect(n).toBe(Math.max(...heads.map((h) => Number(h[1]))));
  return section(SPEC, `## ${n}${SPEC_TITLE}`);
}

describe('pack 6 documents say what the code does', () => {
  it('ROLLBACK.md PR6 paragraph names 0040, the three columns, the ignored keys and audit actions, held rows, reload and What to check first; the migration file names the columns', () => {
    const p = paragraph(ROLLBACK, PR6);
    for (const s of [
      '0040',
      '`customers.esign_consent_version`',
      '`customers.esign_consented_at`',
      '`customers.esign_withdrawn_at`',
      '`draft.riskSignals`',
      '`amlHoldRules`',
      '`riskSignals`',
      '`customer.consent.esign`',
      '`aml.hold`',
      '`risk.signals`',
      'stay held',
      'reload',
      'What to check first',
      `\`${AML_HOLD_REASON}\``,
      "meta->'rules' ? 'check_failed'",
      '/admin-dashboard/compliance',
    ]) {
      expect(p, s).toContain(s);
    }
    const file = 'drizzle/0040_customer_esign_consent.sql';
    expect(existsSync(join(ROOT, file)), file).toBe(true);
    const sql = read(file);
    for (const c of ['esign_consent_version', 'esign_consented_at', 'esign_withdrawn_at']) expect(sql, c).toContain(`"${c}"`);
  });

  it('the PR6 paragraph sits after every PR5 paragraph and before "## Data"', () => {
    const pr5At = ROLLBACK.indexOf(PR5);
    const pr6At = ROLLBACK.indexOf(PR6);
    expect(pr5At).toBeGreaterThanOrEqual(0);
    expect(pr6At).toBeGreaterThan(pr5At);
    // No PR5 paragraph after the PR6 one, and a blank line between the last PR5 paragraph and PR6.
    expect(ROLLBACK.indexOf('\nPR5 ', pr6At)).toBe(-1);
    const before = ROLLBACK.slice(0, pr6At);
    expect(before.endsWith('\n\n')).toBe(true);
    expect(paragraph(ROLLBACK, PR5)).not.toContain('0040');
    const dataAt = ROLLBACK.indexOf('## Data');
    expect(dataAt).toBeGreaterThan(pr6At + paragraph(ROLLBACK, PR6).length);
  });

  it('sanctions spec pack 6 section names the gate, every rule, check_failed, the alert, the prior-send rule, addHoldReason, the writers, the go-live default, risk.signals and the reason; the code agrees', () => {
    const s = specPack6();
    for (const x of [
      '`p.realMoney`',
      '`amlHolds`',
      '`check_failed`',
      '`aml-hold-check:<partnerId>:<hour>`',
      'HELD',
      '`paid`',
      '`delivered`',
      '`addHoldReason`',
      '`aml_rule.save`',
      '`aml.hold_rules_set`',
      'go-live default',
      '`risk.signals`',
      '`mintLocked`',
      '`setAmlHoldRulesAction`',
      '`aml.hold`',
      `«\`${AML_HOLD_REASON}\`»`,
    ]) {
      expect(s, x).toContain(x);
    }
    for (const r of AML_HOLD_RULES) expect(s, r).toContain(`\`${r}\``);
    // The quoted alert text: every literal piece of 8+ characters is in store.ts.
    const store = read('src/lib/store.ts');
    expect(store).toContain('are being HELD for review');
    const quotes = [...s.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]).filter((q) => q.includes('AML hold check failed'));
    expect(quotes).toHaveLength(1);
    const joined = store.replace(/['`]\s*\+\s*\n\s*['`]/g, '');
    for (const piece of quotes[0].split(/<[^>]+>/).map((x) => x.trim()).filter((x) => x.length >= 8)) {
      expect(joined, piece).toContain(piece);
    }
    expect(store).toContain('aml-hold-check:${partnerId}:${hour}');
    expect(read('src/lib/aml-hold.ts')).toContain('export function addHoldReason');
    expect(read('src/lib/compliance-config.ts')).toContain(`'${AML_HOLD_REASON}'`);
  });

  it('the hold-reason registry table is unchanged: exactly one AML_HOLD_REASON row (no new reason: owner Q15, Q21)', () => {
    const rows = SPEC.split('\n').filter((l) => l.startsWith('| `AML_HOLD_REASON` |'));
    expect(rows).toEqual(['| `AML_HOLD_REASON` | aml | platform | hold |']);
  });

  it('go-live.mdx names AML holds before payout, the three rules in plain words and the Settings page with two-step verification; the pack 3 sentences stay', () => {
    const s = section(GO_LIVE, '### Live money on your own rail');
    for (const x of ['AML holds before payout', 'structuring', 'a first transfer', 'a first transfer to a new recipient', 'Settings page', 'two-step verification', 'waits for review before payout']) {
      expect(s, x).toContain(x);
    }
    expect(s).not.toMatch(/\bcertified\b/i);
    // pack 3 pins (tests/docs-pack3-truth.test.ts), re-asserted.
    expect(s).toContain('Going live with your own settlement rail needs a second SmartRemit approval after go-live.');
    expect(s).toContain('two of your team are named as compliance users, each with two-step verification;');
  });

  it('changelog.mdx has a 2026-11 section first, naming the electronic records consent, the receipt and AML holds before payout', () => {
    expect(CHANGELOG.startsWith('## 2026-11\n')).toBe(true);
    expect(CHANGELOG.match(/^## 2026-11$/gm)).toHaveLength(1);
    const nov = section(CHANGELOG, '## 2026-11');
    for (const x of ['receive records electronically', 'withdrawn', 'receipt', 'printable receipt', 'AML holds before payout', 'Settings page', '`compliance_status` `flagged`', 'Partner API']) {
      expect(nov, x).toContain(x);
    }
    expect(nov).not.toMatch(/\bcertified\b/i);
  });

  it('CLAUDE.md money-paths bullet names the E-SIGN consent written in the evidence transaction and the in-mint AML holds that fail closed; the pack 4 strings stay', () => {
    const line = claudeLine('- **Money paths are transactional**');
    for (const x of ['`customers.esign_consent_version`', 'E-SIGN consent', '`commitPaymentEvidence`', '`mintLocked`', 'fail closed', `\`${AML_HOLD_REASON}\``]) {
      expect(line, x).toContain(x);
    }
    expect(line).toContain('**authorise, then capture**');
    expect(line).toContain('Minting is **claim-first**');
  });

  it('e2e text checks: expectNoPack6Text has the esign-consent and risk-ack absent checks with the exact labels and is called in the four dead-link tests; the synthetic transfer uses a sr_test_ key', () => {
    const spec = read('tests/e2e/pay-page-smoke.spec.ts');
    const at = spec.indexOf('async function expectNoPack6Text(page: Page): Promise<void> {');
    expect(at).toBeGreaterThanOrEqual(0);
    const fn = spec.slice(at, spec.indexOf('\n}\n', at));
    expect(fn).toContain("page.getByTestId('esign-consent')");
    expect(fn).toContain("page.getByTestId('risk-ack')");
    expect(fn).toContain(`page.getByText('${ESIGN_CONSENT_LABEL}')`);
    expect(fn).toContain(`page.getByText('${RISK_ACK_LABEL}')`);
    expect(spec.match(/await expectNoPack6Text\(page\);/g)).toHaveLength(4);
    expect(read('tests/e2e/synthetic-transfer.spec.ts')).toContain("KEY.startsWith('sr_test_')");
  });

  it('no published doc says a partner is certified', () => {
    const dir = join(ROOT, 'src/content/docs');
    const files = readdirSync(dir).filter((f) => f.endsWith('.mdx'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\bcertified\b/i);
  });
});
