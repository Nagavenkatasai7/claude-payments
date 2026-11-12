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

  it('review round 2 GE1: the PR6 paragraph has a roll-forward step that re-saves the AML switch of every corridor switched while the older build served, with the query and the audit action that list them; the code agrees', () => {
    const p = paragraph(ROLLBACK, PR6);
    expect(p).toContain('After the roll-forward');
    expect(p).toContain('re-save the AML holds switch on `/admin-dashboard/compliance`');
    expect(p).toContain("SELECT partner_id, meta->>'country' AS country, at FROM audit_events WHERE action = 'aml.holds_set' AND at > '<rollback time>'");
    expect(p).toContain('`amlHolds` next to an empty `amlHoldRules` holds nothing');
    expect(p).toContain('go-live default');
    // The two builds differ as the step says: the pack 6 switch drops an empty list on ON and deletes both keys on OFF.
    const actions = read('src/app/admin-dashboard/compliance/actions.ts');
    expect(actions).toContain("action: 'aml.holds_set'");
    expect(actions).toContain('delete entry.amlHoldRules;');
    expect(read('src/lib/transfer-create.ts')).toContain('amlHolds: p.rules.amlHolds && p.rules.amlHoldRules.length > 0');
  });

  it('review round 2 GE2: RECORDS-RETENTION.md names the E-SIGN consent and the AML and risk hold evidence pack 6 adds', () => {
    const doc = read('docs/RECORDS-RETENTION.md');
    const rows = doc.split('\n').filter((l) => l.startsWith('| '));
    const consent = rows.find((l) => l.startsWith('| E-SIGN consent'));
    expect(consent, 'E-SIGN consent row').toBeDefined();
    for (const x of ['`esign_consent_version`', '`esign_consented_at`', '`esign_withdrawn_at`', '`customer.consent.esign`', 'counsel to set']) {
      expect(consent!, x).toContain(x);
    }
    const holds = rows.find((l) => l.startsWith('| AML and risk hold evidence'));
    expect(holds, 'AML and risk hold evidence row').toBeDefined();
    for (const x of ['`aml.hold`', '`risk.signals`', '`aml.hold_rules_set`', '`risk_signals.set`', 'ids and enum values only', '5 years']) {
      expect(holds!, x).toContain(x);
    }
    // Same column count as the table header.
    const cols = (l: string) => l.split(' | ').length;
    expect(cols(consent!)).toBe(cols(rows[0]));
    expect(cols(holds!)).toBe(cols(rows[0]));
  });

  it('review round 2 GE3: the changelog names the two limits (ACH debit and bill payments are not asked; payment-link payments get no receipt link)', () => {
    const nov = section(CHANGELOG, '## 2026-11');
    expect(nov).toContain('before they pay by card or bank transfer (ACH debit and bill payments are not asked)');
    expect(nov).toContain('The WhatsApp payment message of a transfer paid on its pay page links the receipt (payment-link payments do not get the link)');
    expect(nov).not.toContain('The WhatsApp payment message links the receipt');
    // The code agrees: ACH debit is exempt on the transfer pay route; a payment-link transfer gets no receipt link.
    expect(read('src/app/api/pay/[transferId]/route.ts')).toContain("exempt: payMethod === 'ach_pull'");
    expect(read('src/lib/settlement.ts')).toContain('isPaymentLinkTransfer(t.id)) ? null : payUrlFor(t.id)');
  });

  it('review round 2 GE4: the spec says a value that is not a list gives all three rules and a list with no known rule name holds nothing', () => {
    const rules = paragraph(specPack6(), '- **The rules.**');
    expect(rules).not.toContain('(or a malformed one)');
    expect(rules).toContain('a stored value that is not a list');
    expect(rules).toContain('an empty list, or a list with no known rule name, means no rule holds');
    const cfg = read('src/lib/compliance-config.ts');
    expect(cfg).toContain('if (!Array.isArray(stored)) return AML_HOLD_RULES;');
    expect(cfg).toContain('AML_HOLD_RULES.filter((r) => list.includes(r))');
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

  it('review round 1 RG3/RD2: the spec Writers bullet says the go-live default skips India (IN), that corridor rules never apply to an India source, and that a corridor added later gets the same default; the code agrees', () => {
    const w = paragraph(specPack6(), '- **Writers.**');
    expect(w).toMatch(/except India \(IN\)/);
    expect(w).toContain('Corridor rules, AML holds included, never apply to a transfer whose source country is India');
    expect(w).toContain("reason: 'corridor_added_default'");
    expect(w).toContain('`updatePartnerAction`');
    const helper = read('src/lib/aml-hold-defaults.ts');
    expect(helper).toContain("c === 'IN'");
    expect(helper).toContain("'corridor_added_default'");
    expect(read('src/app/admin-dashboard/partners/actions.ts')).toContain("'corridor_added_default'");
  });

  it('review round 1 RG3/RD2: go-live.mdx says the default does not apply to India (IN) and also covers a corridor added later', () => {
    const p = paragraph(section(GO_LIVE, '### Live money on your own rail'), 'When SmartRemit turns on live money');
    expect(p).toMatch(/except India \(IN\)/);
    // Final check U7: a partner cannot add a corridor; only SmartRemit's partner save writes the countries.
    expect(p).toContain('A corridor SmartRemit adds to your account later gets the same default when it is added.');
    expect(p).not.toContain('A corridor you add later');
  });

  it('final check T1: the PR6 paragraph says what this build does serving without 0040 (503 at the E-SIGN gate, before the code); the code agrees', () => {
    const p = paragraph(ROLLBACK, PR6);
    expect(p).toContain('serving without 0040');
    expect(p).toContain('`MIGRATE_ON_BUILD_SKIP=1`');
    expect(p).toContain('503');
    expect(p).toContain('ACH debit');
    expect(p).toContain('Prod migrations behind');
    // The gate turns a failed consent read into 503, ACH debit is exempt on the transfer route only,
    // and the gate runs before the code is checked on both routes.
    expect(read('src/lib/pay-esign-gate.ts')).toContain("return { kind: 'unavailable' };");
    for (const [file, gate] of [
      ['src/app/api/pay/[transferId]/route.ts', "exempt: payMethod === 'ach_pull'"],
      ['src/app/api/pay/l/[token]/route.ts', 'exempt: false'],
    ] as const) {
      const src = read(file);
      const at = src.indexOf(gate);
      expect(at, file).toBeGreaterThan(0);
      expect(src.indexOf("if (esign.kind === 'unavailable') return payTemporarilyUnavailable();", at), file).toBeGreaterThan(at);
      expect(src.indexOf('.verify(', at), file).toBeGreaterThan(at);
    }
  });

  it('final check U6: the roll-forward step covers a country a certified partner gained while the older build served', () => {
    const p = paragraph(ROLLBACK, PR6);
    expect(p).toContain('gained a country while the older build served');
    // The added-corridor default runs only inside the platform partner save (never after the fact).
    expect(read('src/app/admin-dashboard/partners/actions.ts')).toContain("'corridor_added_default'");
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
