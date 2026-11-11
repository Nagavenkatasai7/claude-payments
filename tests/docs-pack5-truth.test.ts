// Fix pack 5 T32 (D11; pins P8 gate order line, P10 example, P30 alert keys):
// the documents that state pack 5's rules say what the built code does. Read
// from disk, like tests/docs-pack4-truth.test.ts (same `paragraph`, `section`,
// `claudeLine` helpers) and tests/sanctions-spec-truth.test.ts (same `srcText`
// walker). A disk-reading guard: `vitest --changed` never selects it, so every
// later commit runs it by name.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildComplianceBlock, type ComplianceScreeningRef } from '@/lib/providers/http-payment-provider';
import { INSTRUCT_GATE_ORDER, heldStuckDedupeKey, type InstructHeldReason } from '@/lib/instruct-gates';
import { ORIGINATOR_INFO_MISSING_REASON } from '@/lib/compliance-config';
import { railRecordAlertKey } from '@/lib/instruct-errors';
import { ARCHIVE_LAG_ALERT_DAYS } from '@/lib/sanctions/list-archive';
import { MAX_REDIRECT_HOPS } from '@/lib/sanctions/pinned-fetch';
import type { Customer, Transfer } from '@/lib/types';
import { drizzle as drizzleProxy } from 'drizzle-orm/pg-proxy';
import { partnerWebhookDeliveries } from '@/db/schema';

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

/** Every .ts / .tsx file under src/, concatenated, with string concatenations across lines joined (sanctions-spec-truth's walker). */
function srcText(): string {
  const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  return files
    .map((f) => readFileSync(join(ROOT, 'src', f), 'utf8'))
    .join('\n')
    .replace(/['`]\s*\+\s*\n\s*['`]/g, '');
}

/** Each quoted «`...`» text of a table row: every literal piece of 8+ characters between <placeholders> is in src/. */
function expectQuotedInSrc(row: string, src: string, key: string): void {
  const texts = [...row.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
  expect(texts.length, `${key} quotes a text`).toBeGreaterThanOrEqual(1);
  for (const text of texts) {
    for (const piece of text.split(/<[^>]+>/).map((p) => p.trim()).filter((p) => p.length >= 8)) {
      expect(src, `${key} text piece "${piece}"`).toContain(piece);
    }
  }
}

/** The ids of `INSTRUCT_GATE_ORDER` in the order a text names them, in backticks, after `lead` up to the first full stop. */
function gateIdsAfter(text: string, lead: string): string[] {
  const at = text.indexOf(lead);
  expect(at, lead).toBeGreaterThanOrEqual(0);
  const rest = text.slice(at + lead.length);
  return [...rest.slice(0, rest.indexOf('.')).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
}

const WEBHOOKS = read('src/content/docs/webhooks.mdx');
const FUNDING = read('src/content/docs/funding.mdx');
const CHANGELOG = read('src/content/docs/changelog.mdx');
const SPEC = read('docs/compliance/sanctions-screening-spec.md');
const ROLLBACK = read('docs/ROLLBACK.md');
const RETENTION = read('docs/RECORDS-RETENTION.md');
const CLAUDE = read('CLAUDE.md');
const PR5 = 'PR5 (signed instructions and the rail record) adds migration 0039, which is additive:';

// ---- the compliance block example ------------------------------------------------------------

const NOW = new Date();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function fixtureTransfer(): Transfer {
  return {
    id: 'docs_t1', phone: '12025550142', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Docs Recipient', recipientPhone: '12025550143',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [], relationship: 'parent', purpose: 'family_support',
    createdAt: daysAgo(1), paidAt: daysAgo(1), partnerId: 'acme', environment: 'live',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

function fixtureCustomer(): Customer {
  return {
    senderPhone: '12025550142', firstSeenAt: daysAgo(30), kycStatus: 'verified', kycVerifiedAt: daysAgo(20),
    fullName: 'Docs Sender', idLast4: '1234', idDocType: 'passport', senderCountry: 'US', partnerId: 'acme',
    createdAt: daysAgo(30), updatedAt: daysAgo(1),
  } as Customer;
}

const SCREENING: ComplianceScreeningRef = {
  listSource: 'ofac-sdn', listVersion: 'v-docs', decision: 'clear', screenedAt: daysAgo(1),
  namesScreened: { sender: 1, recipient: 1 },
};

type Shape = string | null | Shape[] | { [k: string]: Shape };
/** The keys (and their order) at every level; every leaf (string, number, boolean, null) is the same. */
function shape(v: unknown): Shape {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]));
  return 'leaf';
}
const keyOrder = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(keyOrder) : v && typeof v === 'object' ? Object.entries(v).map(([k, x]) => [k, keyOrder(x)]) : 'leaf';

function webhooksExample(): Record<string, unknown> {
  const s = section(WEBHOOKS, '### Compliance block');
  const m = /```json\n([\s\S]*?)\n```/.exec(s);
  expect(m, 'a fenced json block under ### Compliance block').not.toBeNull();
  return JSON.parse(m![1]) as Record<string, unknown>;
}

describe('pack 5 documents say what the code does', () => {
  it('webhooks.mdx compliance example equals buildComplianceBlock output (keys and order at every level; version 2; funding)', () => {
    const block = buildComplianceBlock(fixtureTransfer(), fixtureCustomer(), NOW, { kycGateActive: true, screening: SCREENING });
    const built = JSON.parse(JSON.stringify(block, null, 2)) as Record<string, unknown>;
    const doc = webhooksExample();
    expect(shape(doc)).toEqual(shape(built));
    expect(keyOrder(doc)).toEqual(keyOrder(built));
    expect(doc.version).toBe(2);
    const funding = doc.funding as Record<string, unknown>;
    expect(Object.keys(funding)).toEqual(['mode', 'provider', 'reference', 'status', 'amount', 'currency']);
    const originator = doc.originator as Record<string, unknown>;
    expect(originator).not.toHaveProperty('address');
    expect(originator).not.toHaveProperty('date_of_birth');
  });

  it('webhooks.mdx states the version rule, the block and signing rules, the originator rule, screening.lists, the funding modes and the partner_collected reverse; and none of the old grace text', () => {
    for (const s of [
      'Accept any `version` of 1 or more and ignore keys you do not know',
      'An instruction is never sent without its compliance block, and never unsigned: a rail with no signing secret receives nothing until one is set.',
      '`address` and `date_of_birth` appear only on a real-money transfer, and never on a routed transfer',
      '`screening.lists` appears only when SmartRemit screens several lists',
      '`source`, `version` and `fitness`',
      '`partner_collected`',
      '`partner_psp`',
      '`partner_pull`',
      '`demo`',
      '"method": "partner_collected"',
      '`names_screened`',
    ]) {
      expect(WEBHOOKS, s).toContain(s);
    }
    expect(section(WEBHOOKS, '### Reversals')).toContain('"method": "partner_collected"');
    for (const s of ['accepted for now', 'still accepted when', 'could not be loaded']) expect(WEBHOOKS, s).not.toContain(s);
  });

  it('webhooks.mdx funding: a routed transfer gets a null reference, and amount is the total charge', () => {
    const s = section(WEBHOOKS, '### Compliance block');
    expect(s).toContain('On a routed transfer `funding.reference` is always `null`');
    expect(s).toContain('`funding.amount` is the total charge');
    // As built: fundingBlockFor nulls the reference on a routed row and keeps the total charge.
    const src = read('src/lib/providers/http-payment-provider.ts');
    expect(src).toContain('reference: t.settlementPartnerId ? null : (t.fundingRef ?? t.fundingIntentRef ?? null)');
    expect(src).toContain('const amount = t.totalChargeSource ?? t.totalChargeUsd;');
  });

  it('callback answers table: 401 legacy-only, 422 amount_required, 422 reference_unresolved, 200 held, 200 duplicate, each with the code the route answers', () => {
    const rows = section(WEBHOOKS, '### Our answers').split('\n').filter((l) => l.startsWith('| `'));
    const row = (status: string, needle: string) => {
      const r = rows.find((l) => l.startsWith(`| \`${status}\``) && l.includes(needle));
      expect(r, `${status} ${needle}`).toBeDefined();
      return r!;
    };
    expect(row('401', '`x-signature`')).toMatch(/only the legacy `x-signature`/);
    row('422', '"error": "amount_required"');
    const unresolved = row('422', '"error": "reference_unresolved"');
    // Review round 1 RG3: the verifying secret is chosen from the transfer the
    // callback's reference names, so a reference we cannot resolve fails the
    // signature check (401) before the reference check; 422
    // reference_unresolved means the reference resolves but names a different
    // transfer than the one the callback reports.
    expect(unresolved).not.toMatch(/does not name a transfer we know/);
    // Review round 1 R1 (F3-D1): the reference and the reported transfer come
    // from the same parse (railCallbackTransferId), so a resolving reference
    // always matches: 422 reference_unresolved is a defensive refusal that a
    // correctly signed callback naming a real transfer never gets.
    expect(unresolved).not.toContain('resolves to a transfer but does not match the transfer the callback reports');
    expect(unresolved).toContain('Defensive: the transfer we read from the callback differs from the one its `reference` names');
    expect(unresolved).toContain('a correctly signed callback that names a real transfer never gets it');
    const sig401 = rows.filter((l) => l.startsWith('| `401`'));
    expect(sig401.some((l) => l.includes('a `reference` we cannot resolve to a transfer'))).toBe(true);
    const changelog = read('src/content/docs/changelog.mdx');
    expect(changelog).not.toContain('names no known transfer gets');
    expect(changelog).toContain('a reference we cannot resolve gets `401`');
    expect(changelog).not.toContain('does not match the transfer the callback reports gets `422`');
    expect(changelog).toContain('`422` `"error": "reference_unresolved"` is a defensive refusal');
    expect(read('src/lib/providers/http-payment-provider.ts')).toContain('const transferId = railCallbackTransferId(body);');
    row('200', '"held": true');
    row('200', '"duplicate": true');
    const route = read('src/app/api/payment-webhook/[provider]/route.ts');
    expect(route).toContain("error: 'amount_required' }, { status: 422 }");
    expect(route).toContain("error: 'reference_unresolved' }, { status: 422 }");
    expect(route).toContain('return NextResponse.json({ ok: true, held: true });');
    expect(route).toContain('return NextResponse.json({ ok: true, duplicate: true });');
    expect(read('src/lib/providers/rail-signature.ts')).toContain("'legacy_rejected'");
    // Signatures: the legacy header is still SENT outbound, never accepted alone inbound.
    const sig = section(WEBHOOKS, '## Signatures');
    expect(sig).toContain('is still sent on our instructions');
    expect(sig).toContain('a callback that carries only `x-signature` is refused with `401`');
    expect(WEBHOOKS).toContain('A `paid_out` must carry the amount');
  });

  it('the public docs pages never say the product is in testing', () => {
    for (const [name, text] of [['webhooks', WEBHOOKS], ['funding', FUNDING], ['changelog', CHANGELOG]] as const) {
      expect(text, name).not.toMatch(/in testing/i);
    }
  });

  it('the instruct gate order line: CLAUDE.md Durability and spec section 4 rule 3 name INSTRUCT_GATE_ORDER in order and "never unsigned"', () => {
    const durability = claudeLine('- **Durability**');
    expect(gateIdsAfter(durability, 'fixed gate order (`INSTRUCT_GATE_ORDER`, `src/lib/instruct-gates.ts`):')).toEqual([...INSTRUCT_GATE_ORDER]);
    expect(durability).toContain('never unsigned');
    const rule3 = /^3\. \*\*Instruct gate\*\*(.*)$/m.exec(section(SPEC, '## 4.'))?.[1] ?? '';
    expect(gateIdsAfter(rule3, 'The full order (fix pack 5, `INSTRUCT_GATE_ORDER` in `src/lib/instruct-gates.ts`):')).toEqual([...INSTRUCT_GATE_ORDER]);
    expect(rule3).toContain('never unsigned');
  });

  it('CLAUDE.md Encryption bullet names rail_messages.body_enc and ctx.railMessage; the money-paths bullet keeps its pack 4 strings', () => {
    const enc = claudeLine('- **Encryption at rest**');
    expect(enc).toContain('`rail_messages.body_enc`');
    expect(enc).toContain('`ctx.railMessage`');
    expect(enc).toContain('`customers.residential_address_enc`');
    expect(enc).toContain('`date_of_birth_enc`');
    // pack 4 pins (tests/docs-pack4-truth.test.ts), re-asserted.
    expect(enc).toContain('`recipients.legal_name_enc`');
    const money = claudeLine('- **Money paths are transactional**');
    for (const s of ['**authorise, then capture**', '`commitPaymentEvidence`', 'Minting is **claim-first**']) expect(money, s).toContain(s);
  });

  it('CLAUDE.md names the rail record: rail_messages, append-only against app code by trigger, recorded before the POST, RailRecordError, railrecord:<hour>, MIGRATE_ON_BUILD_SKIP', () => {
    const durability = claudeLine('- **Durability**');
    for (const s of [
      '`rail_messages` before its POST',
      'append-only against app code by trigger (not a privilege boundary: see 0039\'s header)',
      '`RailRecordError`',
      '`railrecord:<hour>`',
      '`MIGRATE_ON_BUILD_SKIP=1`',
      'answers 500 to every verified callback until it is applied',
      // Review round 2 GD1: what else a build serving without 0039 breaks.
      // Review round 2 R2 (F7-D1): only the paths that send a reverse.
      'sends no reverse (a refund of a non-sandbox partner-pulled row or of an unrouted real-money partner-collected row stays pending and dead-letters at 8)',
      "fails the partner webhooks page's delivery log",
      "reports a \"Send test event\" ping that reached the partner's endpoint as failed (no delivery row, no `webhook.test` audit row)",
    ]) {
      expect(durability, s).toContain(s);
    }
    expect(railRecordAlertKey(3_600_000 * 7)).toBe('railrecord:7');
    expect(read('src/lib/instruct-errors.ts')).toContain('export class RailRecordError');
  });

  it('the coupling the "without 0039" text relies on: a ping insert that leaves body_sha256 out still names the column (review round 2 GD1)', () => {
    // drizzle names every insertable column and fills a missing one with `default`
    // (node_modules/drizzle-orm/pg-core/dialect.js buildInsertQuery), so the
    // unchanged sendTestPing insert fails on a database without 0039.
    const db = drizzleProxy(async () => ({ rows: [] }));
    const q = db
      .insert(partnerWebhookDeliveries)
      .values({ partnerId: 'acme', kind: 'ping', attempt: 1, outcome: 'ok', httpStatus: 200, latencyMs: 1 })
      .toSQL();
    expect(q.sql).toContain('"body_sha256"');
  });

  it('CLAUDE.md Sanctions bullet names SANCTIONS_LIST=lists as opt-in, the floor file and fail closed', () => {
    const line = claudeLine('- **Sanctions screening always runs**');
    expect(line).toContain('`SANCTIONS_LIST=lists`');
    expect(line).toContain('opt-in');
    expect(line).toContain('`src/lib/sanctions/list-sets.ts`');
    expect(line).toMatch(/fails? closed/);
    // Review round 1 RE2: a MISSING required list holds every transfer; a stale
    // or not-live one holds real-money transfers only (compliance.ts holds on
    // fitness only under requireLiveList).
    expect(line).not.toContain('a missing or not-live required list holds the transfer');
    expect(line).toContain(
      'a missing required list holds every transfer; a stale or not-live one holds real-money transfers only (an exact match on any list still blocks)',
    );
  });

  it("0039's header says NOT a privilege boundary (P2); RECORDS-RETENTION.md says TRUNCATE and has the erasure section (P1)", () => {
    expect(read('drizzle/0039_rail_messages.sql')).toContain('NOT a privilege boundary');
    expect(RETENTION).toContain('TRUNCATE');
    expect(RETENTION).toContain('## Erasure and correction requests');
  });

  it('RECORDS-RETENTION.md keeps its title and status line and names rail_messages and 5 years', () => {
    expect(RETENTION.startsWith('# Records retention (DRAFT for counsel, fix pack 5)\n')).toBe(true);
    expect(RETENTION).toContain('Status: draft for counsel. Nothing in this document is enforced: no job purges any record today.');
    expect(RETENTION).toContain('`rail_messages`');
    expect(RETENTION).toContain('5 years');
  });

  it('ROLLBACK.md PR5 paragraph names 0039, the rail record, version 1, fail-open, the held rows, SANCTIONS_LIST and What to check first; PR4 is unchanged before it; ## Data after it', () => {
    const p = paragraph(ROLLBACK, PR5);
    for (const s of [
      '0039',
      '`rail_messages`',
      '`body_sha256`',
      'version 1',
      'fail-open',
      'NOT recorded',
      '`fundmode:<id>`',
      '`travelrule:<id>`',
      '`mockfund:<id>`',
      '`nofunds-<id>`',
      'Issue refund',
      '`SANCTIONS_LIST`',
      '`ofac-sdn`',
      'What to check first',
      'append-only against application code (trigger; not TRUNCATE, not the table-owner role)',
      '`MIGRATE_ON_BUILD_SKIP=1`',
      'Set `SANCTIONS_LIST` back to `ofac-sdn` (or unset) BEFORE rolling back past PR5: an older build treats `lists` as unknown and screens with the mock',
      // Review round 2 GE1: Issue refund refuses a real-money card payment.
      "Issue refund refuses a card payment through the partner's Stripe key",
      // Review round 2 R2 (F6-D1): partner_psp lets only a funding-mode hold go out.
      "so for that one either, when it is held for its funding mode (`fundmode:<id>`), record `partner_psp` on the go-live card and let it go out before rolling back, or return the money in the partner's Stripe dashboard and do not roll back while its row is paid",
      // Final check F8 (X1, U1): a partner-collected row per class.
      'for a partner-collected row that is not routed, Issue refund sends nothing to a rail that never got the transfer and leaves the refund `pending` with one `refundheld:<id>` alert (roll back only after that alert is raised, so the worker has drained the refund), and no build (an older one included) instructs a row whose refund is pending; a person then arranges the return of the sender\'s money with the partner',
      'Issue refund is not available for a routed partner-collected row, so do not roll back while such a row is paid and held',
      // Review round 2 GD1: what else a build serving without 0039 breaks.
      // Review round 2 R2 (F7-D1): only the paths that send a reverse; a sandbox row
      // closes as sandbox-reverse-<id>, a routed partner-collected row raises refundrouted:<id>.
      'it also sends no reverse instruction, so a queued refund of a non-sandbox partner-pulled row, or of a real-money partner-collected row that is not routed, stays pending and dead-letters after 8 attempts (`dead:<id>`)',
      'the delivery log section of the partner webhooks page fails to load',
      "a \"Send test event\" ping still reaches the partner's endpoint but is reported as failed, with no delivery row and no `webhook.test` audit row",
    ]) {
      expect(p, s).toContain(s);
    }
    expect(p).not.toContain('The other fix pack 5 changes an older build undoes are listed below.');
    expect(ROLLBACK).not.toContain('The other fix pack 5 changes an older build undoes are listed below.');
    const pr4At = ROLLBACK.indexOf('PR4 (pay-step evidence and the provider line)');
    const pr5At = ROLLBACK.indexOf(PR5);
    expect(pr4At).toBeGreaterThanOrEqual(0);
    const pr4End = ROLLBACK.indexOf('\n\n', pr4At);
    expect(ROLLBACK.slice(pr4End, pr5At)).toBe('\n\n');
    expect(paragraph(ROLLBACK, 'PR4 (pay-step evidence and the provider line)')).not.toContain('0039');
    expect(ROLLBACK.indexOf('## Data')).toBeGreaterThan(pr5At + p.length);
  });

  it('ROLLBACK.md and the spec give the same order of steps for a later switch to SANCTIONS_LIST=lists (review L1, LC1)', () => {
    const p = paragraph(ROLLBACK, PR5);
    const s3 = section(SPEC, '## 3. Which list');
    for (const text of [p, s3]) {
      const steps = [
        'a platform admin uploads the India MHA list',
        'the owner sets `SANCTIONS_LIST=lists` with the loader enabled',
        'until one lists-mode cron run (13:00 and 17:00 UTC) has loaded the OFAC consolidated and UN lists, every real-money transfer holds `LIST_UNAVAILABLE`',
        'check the four lists on `/admin-dashboard/compliance/sanctions-lists`',
      ];
      const at = steps.map((s) => text.indexOf(s));
      for (const [i, s] of steps.entries()) expect(at[i], s).toBeGreaterThanOrEqual(0);
      for (let i = 1; i < at.length; i++) expect(at[i]).toBeGreaterThan(at[i - 1]);
      expect(text).toContain('one live load on a preview');
    }
    expect(read('vercel.json')).toContain('"0 13 * * *"');
    expect(read('vercel.json')).toContain('"0 17 * * *"');
  });

  it('every P30 key is in src/ and in the docs; each compliance key has a section 11 row whose quoted pieces are in src/', () => {
    const src = srcText();
    const docs = [SPEC, ROLLBACK, CLAUDE, WEBHOOKS].join('\n');
    const reasons: InstructHeldReason[] = ['mockfund', 'fundmode', 'travelrule'];
    for (const r of reasons) expect(heldStuckDedupeKey(r, 'x1')).toBe(`${r}:stuck:x1`);
    const keys = ['raillegacy:', 'railnoamount:', 'instructblock:', 'railrecord:', 'mockfund:', 'fundmode:', 'fundcapture:', 'fundrefund:', 'stripekey:', 'travelrule:', 'refundnosettle:', 'refundrouted:', 'refundheld:'];
    for (const k of keys) {
      expect(src, k).toContain(k);
      expect(docs, k).toContain(`\`${k}`);
    }
    for (const r of reasons) expect(docs, `${r}:stuck:`).toContain(`\`${r}:stuck:<id>\``);
    const rows = section(SPEC, '## 11.').split('\n').filter((l) => l.startsWith('| `'));
    for (const k of ['instructblock:', 'mockfund:<id>', 'fundmode:<id>', 'fundcapture:', 'fundrefund:', 'travelrule:<id>']) {
      const row = rows.find((l) => l.startsWith(`| \`${k}`));
      expect(row, k).toBeDefined();
      expectQuotedInSrc(row!, src, k);
    }
    const stuck = rows.find((l) => l.startsWith('| `mockfund:stuck:<id>`'));
    expect(stuck, 'the <reason>:stuck:<id> row').toBeDefined();
    for (const r of reasons) expect(stuck!).toContain(`\`${r}:stuck:<id>\``);
    expect([...stuck!.matchAll(/«`([^`]+)`»/g)]).toHaveLength(3);
    expectQuotedInSrc(stuck!, src, 'stuck');
    // Review round 2 GE1: the card-payment (class stripe) texts never name Issue refund.
    const fm = rows.find((l) => l.startsWith('| `fundmode:<id>`'))!;
    expect([...fm.matchAll(/«`([^`]+)`»/g)]).toHaveLength(6);
    for (const [, text] of [...fm.matchAll(/«`([^`]+)`»/g)].slice(3)) expect(text).not.toContain('Issue refund');
    const stuckCard = rows.find((l) => l.startsWith('| `fundmode:stuck:<id>`, `travelrule:stuck:<id>` for a card payment'));
    expect(stuckCard, 'the card-payment stuck row').toBeDefined();
    const cardTexts = [...stuckCard!.matchAll(/«`([^`]+)`»/g)].map((m) => m[1]);
    expect(cardTexts).toHaveLength(2);
    for (const text of cardTexts) expect(text).not.toContain('Issue refund');
    expectQuotedInSrc(stuckCard!, src, 'stuck card');
    // Final check F8 (TR1): the travelrule:<id> row quotes the card-payment tail too, which never names Issue refund.
    const tr = rows.find((l) => l.startsWith('| `travelrule:<id>`'))!;
    expect(tr).toContain("Return the sender's money in the partner's Stripe dashboard (SmartRemit cannot refund a card payment yet, and Cancel does not apply to a paid transfer).");
    expect(stuckCard!).not.toContain('still names Issue refund');
    // Final check F8 (X1, U1): a partner-collected row's own texts, routed or not, worker and sweeps.
    const pcRow = rows.find((l) => l.startsWith('| `fundmode:<id>`, `travelrule:<id>` for a partner-collected row'));
    expect(pcRow, 'the partner-collected worker row').toBeDefined();
    expect([...pcRow!.matchAll(/«`([^`]+)`»/g)]).toHaveLength(4);
    expectQuotedInSrc(pcRow!, src, 'partner-collected');
    expect(pcRow!).toContain('`refundheld:<id>`');
    const pcStuck = rows.find((l) => l.startsWith('| `fundmode:stuck:<id>`, `travelrule:stuck:<id>` for a partner-collected row'));
    expect(pcStuck, 'the partner-collected stuck row').toBeDefined();
    expect([...pcStuck!.matchAll(/«`([^`]+)`»/g)]).toHaveLength(4);
    expectQuotedInSrc(pcStuck!, src, 'partner-collected stuck');
    for (const routedText of ["Issue refund is not available for a transfer that another partner pays out: a person must arrange the return of the sender's money with the owner partner."]) {
      expect(pcRow!).toContain(routedText);
      expect(pcStuck!).toContain(routedText);
    }
    // The other pack 5 alerts (not compliance alerts) have their rows in section 14.
    const other = section(SPEC, '## 14.').split('\n').filter((l) => l.startsWith('| `'));
    // Review round 1 (RC2, RF1): the two funding.refund alerts.
    for (const k of ['raillegacy:', 'railnoamount:', 'railrecord:', 'stripekey:', 'refundnosettle:', 'refundrouted:', 'refundheld:']) {
      const row = other.find((l) => l.startsWith(`| \`${k}`));
      expect(row, k).toBeDefined();
      expectQuotedInSrc(row!, src, k);
    }
    // Final check F8 (X1, U1): refundnosettle:<id> is the demo era only; a row held before its first instruction is refundheld:<id>.
    const nosettle = other.find((l) => l.startsWith('| `refundnosettle:'))!;
    expect(nosettle).toContain('demo era');
    expect(nosettle).toContain('a row held before its first instruction raises `refundheld:<id>` instead');
    const held = other.find((l) => l.startsWith('| `refundheld:<id>`'))!;
    for (const s of ['the refund stays `pending`', 'no reverse', 'no customer message', 'not paid out']) expect(held, s).toContain(s);
  });

  it('the list-track alert keys: sanctions-archive-lag:<source>:<day> and sanctions-archive-unconfigured:<source>:<day> have their section 11 rows', () => {
    const src = srcText();
    const rows = section(SPEC, '## 11.').split('\n').filter((l) => l.startsWith('| `'));
    const lag = rows.find((l) => l.startsWith('| `sanctions-archive-lag:<source>:<day>`'));
    expect(lag).toBeDefined();
    expect(lag!).toContain(`${ARCHIVE_LAG_ALERT_DAYS} days`);
    expectQuotedInSrc(lag!, src, 'sanctions-archive-lag:');
    const unconf = rows.find((l) => l.startsWith('| `sanctions-archive-unconfigured:'));
    expect(unconf!).toContain('`sanctions-archive-unconfigured:<source>:<day>`');
    expect(src).toContain('sanctions-archive-unconfigured:${source}:${day}');
  });

  it('sanctions spec: section 3 names lists, the floor, the per-source age, MHA upload and confirm, the strict parses and the pinned downloads; section 7 per source; section 9 records the lists-mode gaps; the hold table quotes ORIGINATOR_INFO_MISSING_REASON', () => {
    const s3 = section(SPEC, '## 3. Which list');
    for (const s of [
      '`lists`',
      '`floorLists`',
      '`src/lib/sanctions/list-sets.ts`',
      '`ofac-cons`',
      '`un-sc`',
      '`in-mha-uapa`',
      '8 days',
      '36 hours',
      'loader is on AND `SANCTIONS_LIST` is `lists`',
      '`bad_encoding`',
      '`requestedVersion`',
      'unrecognised entry element',
      'entry <n> has a malformed <X> element',
      'entry <n> repeats an id',
      'entry <n> has unsupported markup',
      'decoded in one pass',
      'The SDN parse is unchanged',
      `at most ${MAX_REDIRECT_HOPS} hops`,
      'before the request',
      'user name or password',
      'while the body streams',
      '`src/lib/sanctions/pinned-fetch.ts`',
      'The SDN download is unchanged',
      '"Verified archive"',
    ]) {
      expect(s3, s).toContain(s);
    }
    const s7 = section(SPEC, '## 7. List archive');
    expect(s7).toContain('per source');
    expect(s7).toContain('inside the same budget');
    const s9 = section(SPEC, '## 9. Known gaps');
    expect(s9).not.toContain('One list only');
    expect(s9).toContain('over-hold');
    expect(s9).toMatch(/routed real-money transfer[^.]*held/);
    expect(s9).toMatch(/UK, EU and Canadian lists/);
    expect(SPEC).toContain(`\`ORIGINATOR_INFO_MISSING_REASON\` («\`${ORIGINATOR_INFO_MISSING_REASON}\`»)`);
    expect(read('src/lib/compliance-config.ts')).toContain(`'${ORIGINATOR_INFO_MISSING_REASON}'`);
  });

  it('funding.mdx is no longer "Coming soon" and names partner_collected and partner_psp; the changelog has a 2026-11 section with the partner-visible changes', () => {
    expect(FUNDING).not.toContain('Coming soon');
    expect(FUNDING).toContain('`partner_collected`');
    expect(FUNDING).toContain('`partner_psp`');
    expect(FUNDING).toContain('`compliance.funding`');
    expect(FUNDING).toContain('restricted');
    expect(FUNDING).toContain('POST /transactions/{id}/confirm');
    expect(CHANGELOG.startsWith('## 2026-11\n')).toBe(true);
    const nov = section(CHANGELOG, '## 2026-11');
    for (const s of ['version `2`', '`x-signature`', '`401`', '"error": "amount_required"', '`compliance.funding`', '"method": "partner_collected"']) {
      expect(nov, s).toContain(s);
    }
  });

  it('the changelog, funding.mdx and webhooks.mdx limit the partner_collected reverse to a settle sent to the rail after go-live (review round 1 R1, F2-D1)', () => {
    const line = section(CHANGELOG, '## 2026-11').split('\n').find((l) => l.includes('**Refunds of partner-collected funds.**'));
    expect(line).toBeDefined();
    expect(line!).toContain('when its settlement instruction went to your rail after you went live');
    expect(line!).toContain('A transfer settled before you went live, or on another partner\'s rail, gets no reverse');
    expect(FUNDING).toContain('when its settlement instruction went to your rail after you went live');
    expect(WEBHOOKS).toContain('whose settlement instruction we sent to your rail after you went live');
  });

  it('spec: a key-configuration error at the build step retries like a transient read failure; the instructblock alert says so (review round 1 R1, F1-D1)', () => {
    const rule = 'a transient read failure or a field-crypto key-configuration error retries with one `instructblock:<rail>:<hour>` alert from attempt 3, any other failure is dead-lettered at once';
    expect(SPEC).toContain(rule);
    expect(SPEC).not.toContain('`build` fails closed: a transient read failure retries with one');
    const row = section(SPEC, '## 11.').split('\n').find((l) => l.startsWith('| `instructblock:'));
    expect(row).toBeDefined();
    expect(row!).toContain('a database, network or key-configuration error');
    expect(row!).toContain('A transient read failure or a field-crypto key-configuration error retries; any other failure is dead-lettered at once');
    expect(row!).toContain('`FIELD_ENCRYPTION_*` key configuration');
    expect(read('src/lib/instruction-compliance.ts')).toContain('isTransientInstructError(err) || isKeyConfigError(err)');
  });
});
