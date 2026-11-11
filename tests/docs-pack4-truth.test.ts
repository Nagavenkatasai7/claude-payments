// Fix pack 4 T20 (C17, C22, C0 rule 2): the documents that state pack 4's rules
// say what the built code does. Read from disk, like tests/docs-pack3-truth.test.ts
// (same `paragraph()` helper). A disk-reading guard: `vitest --changed` never
// selects it, so every pack 4 commit runs it by name.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_LINE_TEMPLATE } from '@/lib/legal/provider-line';
import { LIST_UNAVAILABLE_REASON, RECIPIENT_IDENTITY_MISSING_REASON } from '@/lib/compliance-config';
import { RECIPIENT_IDENTITY_RELEASE_REFUSAL } from '@/lib/dashboard-ops';
import { APPROVED_PUBLIC_PHRASINGS } from '@/lib/claims-register';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** The paragraph of `text` that starts with `start` (up to the next blank line). */
function paragraph(text: string, start: string): string {
  const at = text.indexOf(start);
  expect(at, `paragraph "${start}"`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n\n', at);
  return text.slice(at, end === -1 ? undefined : end);
}

/** The spec section that starts with `title` (up to the next `## ` heading). */
function section(text: string, title: string): string {
  const start = text.indexOf(title);
  expect(start, `section "${title}"`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\n## ', start + title.length);
  return text.slice(start, next === -1 ? undefined : next);
}

const claudeLine = (prefix: string): string => {
  const line = read('CLAUDE.md').split('\n').find((l) => l.startsWith(prefix));
  expect(line, prefix).toBeDefined();
  return line!;
};

describe('pack 4 documents say what the code does', () => {
  const rollback = read('docs/ROLLBACK.md');
  const PR4 = 'PR4 (pay-step evidence and the provider line) adds migration 0038, which is additive:';
  const pr4 = (): string => paragraph(rollback, PR4);

  it("ROLLBACK.md PR4 paragraph names 0038, the three columns, otp.verified, the approval stamp re-save, NULL days, the R18 gate, 'Recipient identity missing.' and What to check first", () => {
    const p = pr4();
    for (const s of [
      '0038',
      '`transfers.disclosure_snapshot jsonb`',
      '`transfers.delivery_business_days smallint`',
      '`recipients.legal_name_enc text`',
      '`otp.verified`',
      '`remittance.disclosure_ack`',
      '`approval`',
      're-saves the block after roll-forward',
      'NULL delivery days',
      'R18 gate',
      `\`${RECIPIENT_IDENTITY_MISSING_REASON}\``,
      'release refusal',
      'atomic consume',
      'Telegram',
      'What to check first',
      "t.status = 'in_review' AND t.transfer_type = 'b2c' AND t.recipient_legal_name_enc IS NULL",
      'do not release them during the rollback',
      '`accountHolder`',
      '`disclosureHash`',
      '`txotp:ch:`',
    ]) {
      expect(p, s).toContain(s);
    }
    expect(p).toMatch(/keeps the old saved name until the next change on the new build/);
  });

  // Review R2-Q3 (L2, L4): the older build's list-hold sweep releases an untagged row by itself,
  // and query (a) leaves out the rows the new build exempts (recipientIdentityMissing in
  // src/db/repos/transfer-repo.ts: partnerApiMintedSql and paymentLinkSql).
  it('ROLLBACK.md PR4 check (a) names the older list-hold sweep, the tagging UPDATE and the two exemptions', () => {
    const p = pr4();
    expect(p).toContain('list-hold sweep');
    expect(p).toContain(`\`${LIST_UNAVAILABLE_REASON}\``);
    // The tagging step appends the exact reason the older sweep keeps held.
    expect(p).toContain(`compliance_reasons || '["${RECIPIENT_IDENTITY_MISSING_REASON}"]'::jsonb`);
    expect(p).toContain('reviewed manual `UPDATE transfers SET compliance_reasons = compliance_reasons ||');
    expect(p).toContain("NOT (compliance_reasons ? 'Recipient identity missing.')");
    // The exemptions, with the conditions the code uses.
    expect(p).toContain('Partner-API');
    expect(p).toContain('payment-link');
    expect(p).toContain("k.key LIKE 'paylink:%'");
    expect(p).toContain("NOT (k.partner_id = 'default' AND k.key LIKE 'draft:%') AND k.key NOT LIKE 'sched:%'");
    expect(p).toContain("a.action = 'transaction.create' AND a.actor_type = 'api_key'");
    const repo = read('src/db/repos/transfer-repo.ts');
    expect(repo).toContain("${idempotencyKeys.key} LIKE 'paylink:%'");
    expect(repo).toContain("${idempotencyKeys.key} LIKE 'draft:%') AND ${idempotencyKeys.key} NOT LIKE 'sched:%'");
    expect(repo).toContain("${auditEvents.action} = 'transaction.create' AND ${auditEvents.actorType} = 'api_key'");
  });

  it('the PR3 paragraph is unchanged: the PR4 paragraph starts after it, as its own paragraph', () => {
    const pr3At = rollback.indexOf('PR3 (live controls)');
    const pr4At = rollback.indexOf(PR4);
    expect(pr3At).toBeGreaterThanOrEqual(0);
    expect(pr4At).toBeGreaterThan(pr3At);
    // The PR3 paragraph ends before PR4 begins (a blank line between them), and the PR4 paragraph
    // ends before the "## Data" section.
    const pr3End = rollback.indexOf('\n\n', pr3At);
    expect(pr3End).toBeLessThan(pr4At);
    expect(rollback.slice(pr3End, pr4At)).toBe('\n\n');
    expect(paragraph(rollback, 'PR3 (live controls)')).not.toContain('0038');
    expect(rollback.indexOf('## Data')).toBeGreaterThan(pr4At + pr4().length);
  });

  it('CLAUDE.md branding paragraph names providerLineFor, partnerApproved and the exact PROVIDER_LINE_TEMPLATE text', () => {
    const line = claudeLine('**Branding (owner decision, 2026-10-04):**');
    expect(line).toContain(`\`${PROVIDER_LINE_TEMPLATE}\``);
    expect(line).toContain('`providerLineFor`');
    expect(line).toContain('`src/lib/legal/provider-line.ts`');
    expect(line).toContain('`partnerApproved`');
    expect(line).toContain('a SmartRemit save clears the approval');
    // The original sentence stays.
    expect(line).toContain('`resolvePartnerBranding` always returns SmartRemit');
  });

  it('CLAUDE.md encryption bullet names recipients.legal_name_enc', () => {
    const line = claudeLine('- **Encryption at rest**');
    expect(line).toContain('`recipients.legal_name_enc`');
    expect(line).toContain('`transfers.recipient_legal_name_enc`');
    expect(line).toContain('scripts/reencrypt-aad-v2.ts');
    expect(read('scripts/reencrypt-aad-v2.ts')).toContain("'legal_name_enc'");
  });

  it('CLAUDE.md money-paths bullet says authorise, then capture and names commitPaymentEvidence and approval_not_recorded', () => {
    const line = claudeLine('- **Money paths are transactional**');
    expect(line).toContain('**authorise, then capture**');
    expect(line).toContain('`commitPaymentEvidence`');
    expect(line).toContain('src/lib/payment-evidence.ts');
    expect(line).toContain('`approval_not_recorded`');
    expect(line).toContain('`payevidence:<hour>`');
    const src = read('src/lib/payment-evidence.ts');
    expect(src).toContain('export async function commitPaymentEvidence(');
    expect(src).toContain('payevidence:');
    // The original claim-first sentence stays.
    expect(line).toContain('Minting is **claim-first**');
  });

  const spec = read('docs/compliance/sanctions-screening-spec.md');

  it('sanctions spec section 13 names alsoRecipientNames, role recipient, the cron read, screeningRef via listScreenEvidence, RECIPIENT_IDENTITY_MISSING with both exemptions, the release rule without the reason tag, and the release refusal text', () => {
    const s13 = section(spec, "## 13. Fix pack 4: the recipient's account-holder name");
    for (const s of [
      '`alsoRecipientNames`',
      "role `'recipient'`",
      'src/lib/sanctions/evidence-read.ts',
      '`src/lib/cron-run.ts`',
      "schedule's own account",
      '`listScreenEvidence(...).at(-1)`',
      '`RECIPIENT_IDENTITY_MISSING`',
      '`settleOrHold`',
      'Partner-API-minted rows and payment-link rows are exempt',
      'whether or not the row carries the reason',
      'needs no reason tag',
      'list-hold sweep',
      'fill-only',
      'un-delete',
    ]) {
      expect(s13, s).toContain(s);
    }
    expect(s13).toContain(`«\`${RECIPIENT_IDENTITY_MISSING_REASON}\`»`);
    expect(s13).toContain(`«\`${RECIPIENT_IDENTITY_RELEASE_REFUSAL}\`»`);
    // The quoted refusal is the one T14 wrote in dashboard-ops.ts, verbatim.
    expect(read('src/lib/dashboard-ops.ts')).toContain(`'${RECIPIENT_IDENTITY_RELEASE_REFUSAL}'`);
    // Section 2 says the mint screens the legal name as a further recipient party.
    expect(section(spec, '## 2. Verdicts and evidence')).toMatch(/mint also screens the recipient's legal \(account-holder\) name[^.]*as a further recipient party/);
    // Section 9 records the pre-pack-4 gap.
    expect(section(spec, '## 9. Known gaps')).toMatch(/charged before fix pack 4[^.]*can only be rejected or refunded until PR7/);
  });

  it("the spec's livectl: row names the provider disclosure approval cleared", () => {
    const rows = section(spec, '## 12. Ops alerts added by fix pack 3').split('\n').filter((l) => /^\| `[a-z-]+:/.test(l));
    expect(rows).toHaveLength(5);
    const livectl = rows.find((l) => l.startsWith('| `livectl:'))!;
    const raisedBy = livectl.split('|')[2];
    expect(raisedBy).toContain('provider disclosure approval cleared by a SmartRemit save');
    expect(raisedBy).toContain('`setDisclosure`');
  });

  it('claims-register: the provider evidence names PROVIDER_LINE_TEMPLATE and partnerApproved; the delivery evidence names delivery_business_days', () => {
    const by = (topic: string) => APPROVED_PUBLIC_PHRASINGS.find((p) => p.topic === topic)!;
    expect(by('provider').evidence).toContain('PROVIDER_LINE_TEMPLATE');
    expect(by('provider').evidence).toContain('src/lib/legal/provider-line.ts');
    expect(by('provider').evidence).toContain('partnerApproved');
    expect(by('delivery').evidence).toContain('transfers.delivery_business_days');
    expect(by('delivery').evidence).toContain('deliveryDaysFor');
    // The say of each stays as the home and about pages show it.
    expect(by('provider').say).toBe('A licensed money transmitter provides the transfer. SmartRemit provides the technology and never holds your money.');
    expect(by('delivery').say).toBe('Delivery is not instant. Your receipt shows when the money is expected to arrive.');
  });
});
