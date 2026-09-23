import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { sql } from 'drizzle-orm';
import { freshDb, seedPartner } from './helpers-db';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';

// fix 11 (Program-Fix 18; audit F49/F54/F58/F66): NO outbox payload may carry a secret.
//
// (1) STATIC — the build gate. Every `.enqueue(` call under src/ is checked with
//     the TypeScript CHECKER (a real ts.Program over tsconfig.json):
//       • TYPE: the payload expression's type may not contain a secret-bearing
//         type — WaCreds (src/lib/whatsapp.ts) or any interface of
//         src/lib/partner-integrations.ts — however innocently the key is named
//         (`{ cfg: integrations.whatsapp }`);
//       • NAME: no secret-named key or value (creds, token, secret, …), incl.
//         inside template literals;
//       • DATAFLOW: a payload identifier is followed to its local declaration
//         (initializer / destructuring), so `const note = waCreds.token` or
//         `const { token: memo } = waCreds` cannot launder a token; reading a
//         field of a secret-bearing object is itself a finding;
//       • a payload that is not an inline literal is a finding (it could not be
//         checked). encryptField(...) is the ONE sanctioned sealer: its output is
//         ciphertext and is not scanned. Only CONDITIONS are skipped
//         (`x ? {…} : {}` persists a branch, never x).
//     Limit (documented, covered by (2)): a value that crosses a function
//     boundary as a plain `string` parameter is not traced.
// (2) TRIPWIRE — outbox-repo.enqueue throws under VITEST when a payload carries
//     a secret-bearing shape; every producer exercised anywhere in the suite
//     trips it at runtime.
// (3) MIGRATION — drizzle/0016_scrub_outbox_secrets scrubs legacy rows safely
//     and is idempotent (freshDb already applied it once, to an empty outbox).

const ROOT = join(__dirname, '..');
const SECRET_NAME = /(cred|token|secret|passw|pepper|authori[sz]ation|bearer|api_?key|private_?key)/i;
const SECRET_TYPE_DECLS: Record<string, 'all' | ReadonlySet<string>> = {
  [join('src', 'lib', 'partner-integrations.ts')]: 'all',
  [join('src', 'lib', 'whatsapp.ts')]: new Set(['WaCreds']),
  // Program-Fix 7: the Stripe client secret (returned only to the paying
  // browser) and the partner's Stripe key never belong in an outbox payload.
  [join('src', 'lib', 'providers', 'funding-provider.ts')]: new Set(['PendingCaptureResult']),
  [join('src', 'lib', 'providers', 'stripe-funding-provider.ts')]: new Set(['StripeFundingCredentials']),
};
const SEALERS: ReadonlySet<string> = new Set(['encryptField']);
const PROBE = join(ROOT, 'src', '__outbox_probe__.ts');

type Report = (at: ts.Node, why: string) => void;
interface Scan { checker: ts.TypeChecker; report: Report; seen: Set<ts.Node>; depth: number }

function isSecretSymbol(sym: ts.Symbol | undefined): boolean {
  for (const d of sym?.declarations ?? []) {
    const rule = SECRET_TYPE_DECLS[relative(ROOT, d.getSourceFile().fileName)];
    if (rule === 'all' || (rule && rule.has(sym!.getName()))) return true;
  }
  return false;
}

/** Deep: does this type CONTAIN a secret-bearing type anywhere (≤ 4 property levels)? */
function secretIn(checker: ts.TypeChecker, type: ts.Type, depth = 0, seen = new Set<ts.Type>()): string | null {
  if (depth > 4 || seen.has(type)) return null;
  seen.add(type);
  const sym = type.aliasSymbol ?? type.getSymbol();
  if (isSecretSymbol(sym)) return sym!.getName();
  if (type.isUnionOrIntersection()) {
    for (const t of type.types) { const hit = secretIn(checker, t, depth, seen); if (hit) return hit; }
    return null;
  }
  if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length > 0) return null;
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    for (const t of checker.getTypeArguments(type as ts.TypeReference)) {
      const hit = secretIn(checker, t, depth + 1, seen); if (hit) return hit;
    }
    return null;
  }
  for (const prop of checker.getPropertiesOfType(type)) {
    const hit = secretIn(checker, checker.getTypeOfSymbol(prop), depth + 1, seen);
    if (hit) return `${hit} (via .${prop.getName()})`;
  }
  return null;
}

/** Shallow: IS this value a secret-bearing object (so reading one of its fields leaks it)? */
function secretAtTop(type: ts.Type): string | null {
  for (const t of type.isUnion() ? type.types : [type]) {
    const sym = t.aliasSymbol ?? t.getSymbol();
    if (isSecretSymbol(sym)) return sym!.getName();
  }
  return null;
}

function unwrap(n: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)
  ) n = n.expression;
  return n;
}

/** Follow a local binding to what it was initialised from (same-file dataflow, ≤ 3 hops). */
function followDeclaration(sym: ts.Symbol | undefined, s: Scan): void {
  const decl = sym?.valueDeclaration;
  if (!decl || s.seen.has(decl) || s.depth >= 3) return;
  s.seen.add(decl);
  const next: Scan = { ...s, depth: s.depth + 1 };
  if (ts.isVariableDeclaration(decl) && decl.initializer) { scanValue(decl.initializer, next); return; }
  if (ts.isBindingElement(decl)) {
    const from = decl.propertyName ?? decl.name;
    if (ts.isIdentifier(from) && SECRET_NAME.test(from.text)) s.report(decl, `destructured from "${from.text}"`);
    let root: ts.Node = decl.parent;
    while (root && !ts.isVariableDeclaration(root) && !ts.isParameter(root)) root = root.parent;
    if (root && ts.isVariableDeclaration(root) && root.initializer) {
      const top = secretAtTop(s.checker.getTypeAtLocation(root.initializer));
      if (top) s.report(decl, `destructured from a ${top}`);
      scanValue(root.initializer, next);
    }
  }
  // Parameters and catch bindings have no initializer to follow (see the Limit above).
}

function scanObject(node: ts.Expression, s: Scan): void {
  node = unwrap(node);
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) { scanObject(prop.expression, s); continue; }
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (SECRET_NAME.test(prop.name.text)) s.report(prop, `key "${prop.name.text}"`);
        followDeclaration(s.checker.getShorthandAssignmentValueSymbol(prop), s);
        continue;
      }
      if (ts.isPropertyAssignment(prop)) {
        const n = prop.name;
        const key = ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) ? n.text : null;
        if (key === null) s.report(prop, 'computed key');
        else if (SECRET_NAME.test(key)) s.report(prop, `key "${key}"`);
        scanValue(prop.initializer, s);
        continue;
      }
      s.report(prop, 'method/accessor in a payload');
    }
    return;
  }
  if (ts.isConditionalExpression(node)) { scanObject(node.whenTrue, s); scanObject(node.whenFalse, s); return; }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
  ) {
    if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) scanObject(node.left, s);
    scanObject(node.right, s);
    return;
  }
  s.report(node, `non-literal payload \`${node.getText().slice(0, 60)}\` (inline the object so it can be checked)`);
}

function scanValue(node: ts.Expression, s: Scan): void {
  node = unwrap(node);
  if (ts.isObjectLiteralExpression(node)) return scanObject(node, s);
  if (ts.isArrayLiteralExpression(node)) {
    for (const e of node.elements) scanValue(ts.isSpreadElement(e) ? e.expression : e, s);
    return;
  }
  if (ts.isIdentifier(node)) {
    if (SECRET_NAME.test(node.text)) s.report(node, `value \`${node.text}\``);
    followDeclaration(s.checker.getSymbolAtLocation(node), s);
    return;
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (SECRET_NAME.test(node.name.text)) s.report(node, `value \`${node.getText()}\``);
    const top = secretAtTop(s.checker.getTypeAtLocation(node.expression));
    if (top) s.report(node, `reads a field of a ${top}`);
    scanValue(node.expression, s);
    return;
  }
  if (ts.isElementAccessExpression(node)) { scanValue(node.expression, s); scanValue(node.argumentExpression, s); return; }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    if (SEALERS.has(name)) return; // sealed by field-crypto: ciphertext only
    scanValue(node.expression, s);
    node.arguments.forEach((a) => scanValue(a, s));
    return;
  }
  if (ts.isTemplateExpression(node)) { node.templateSpans.forEach((sp) => scanValue(sp.expression, s)); return; }
  if (ts.isBinaryExpression(node)) { scanValue(node.left, s); scanValue(node.right, s); return; }
  if (ts.isConditionalExpression(node)) { scanValue(node.whenTrue, s); scanValue(node.whenFalse, s); return; }
  if (ts.isAwaitExpression(node) || ts.isTypeOfExpression(node)) { scanValue(node.expression, s); return; }
  if (ts.isPrefixUnaryExpression(node)) { scanValue(node.operand, s); return; }
  // String/number literals, `new X()`, arrow functions: nothing a secret can hide in by name.
}

/** Scan every `.enqueue(` payload in the given source files. */
function scanFiles(program: ts.Program, files: readonly string[]): { sites: number; findings: string[] } {
  const checker = program.getTypeChecker();
  const findings: string[] = [];
  let sites = 0;
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`not in program: ${file}`);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'enqueue') {
        sites++;
        const report: Report = (at, why) => {
          const { line } = sf.getLineAndCharacterOfPosition(at.getStart(sf));
          findings.push(`${relative(ROOT, file)}:${line + 1} ${why}`);
        };
        const payload = n.arguments[1];
        if (!payload) report(n, 'enqueue without a payload argument');
        else {
          const hit = secretIn(checker, checker.getTypeAtLocation(payload));
          if (hit) report(payload, `payload type contains ${hit}`);
          scanObject(payload, { checker, report, seen: new Set(), depth: 0 });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sites, findings };
}

/** A real ts.Program over tsconfig.json (so `@/` aliases and types resolve); optional in-memory probe file. */
function buildProgram(probeSource?: string): { program: ts.Program; files: string[] } {
  const { config } = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, incremental: false };
  const files = parsed.fileNames.filter(
    (f) => relative(ROOT, f).startsWith(`src${sep}`) && readFileSync(f, 'utf8').includes('.enqueue('),
  );
  const host = ts.createCompilerHost(options, true);
  if (probeSource !== undefined) {
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.getSourceFile = (f, lang, onError, create) =>
      f === PROBE ? ts.createSourceFile(f, probeSource, lang, true) : getSourceFile(f, lang, onError, create);
    host.fileExists = (f) => f === PROBE || fileExists(f);
  }
  const rootNames = probeSource !== undefined ? [PROBE] : files;
  return { program: ts.createProgram({ rootNames, options, host }), files };
}

describe('STATIC: no enqueue payload under src/ carries creds / tokens / secrets (fix 11)', () => {
  it('every .enqueue( payload is an inline literal whose TYPE, NAMES and local DATAFLOW are free of secrets', () => {
    const { program, files } = buildProgram();
    const { sites, findings } = scanFiles(program, files);
    // The scan must actually see the producers (36 at bf4b083; 38 once Task 9's
    // sweepFxHealth + schedule-refused ops.alert sites land — both scanned here
    // like every other src file) — a rename that makes it scan nothing must fail.
    // Why the floor is 30 and not the exact 38: this is a liveness check, not a
    // census. An exact count would fail every PR that legitimately adds or
    // removes an enqueue site (and parallel waves do both), training people to
    // bump the number blindly. What it must catch is the scan going vacuous: a
    // `.enqueue(` rename, a tsconfig/include change or a file filter that drops
    // most of src/. 30 sits below today's 38 with room for consolidation, yet far
    // above what any such breakage leaves (0 or a handful). Coverage of each
    // site is enforced by `findings` below, not by this number.
    expect(sites).toBeGreaterThanOrEqual(30);
    expect(findings).toEqual([]);
  }, 120_000);

  it('the scanner is live: it flags every shape the audit found AND the two name-only bypasses', () => {
    const probe = [
      "import type { WaCreds } from '@/lib/whatsapp';",
      "import type { PartnerIntegrations } from '@/lib/partner-integrations';",
      "import { encryptField } from '@/lib/field-crypto';",
      'declare const o: { enqueue(kind: string, payload: Record<string, unknown>): Promise<boolean> };',
      'declare const waCreds: WaCreds;',
      'declare const integrations: PartnerIntegrations;',
      'declare const ctx: { waCreds?: WaCreds; partnerId: string };',
      'declare const to: string, body: string, base: string, token: string;',
      'declare const payload: Record<string, unknown>;',
      'declare function pickPartner(c: unknown): string | undefined;',
      'export async function probe(): Promise<void> {',
      "  await o.enqueue('p1', { to, body, creds: waCreds });",
      "  await o.enqueue('p2', { to, body, ...(ctx.waCreds ? { creds: ctx.waCreds } : {}) });",
      "  await o.enqueue('p3', { text: `${base}/partners/apply/${token}` });",
      "  await o.enqueue('p4', { to, token });",
      "  await o.enqueue('p5', payload);",
      "  await o.enqueue('p6', { to, body, cfg: integrations.whatsapp });", // BYPASS A: innocent key, secret TYPE
      '  const note = waCreds.token;',
      "  await o.enqueue('p7', { to, note });", // BYPASS B: innocent local/shorthand
      '  const { token: memo } = waCreds;',
      "  await o.enqueue('p8', { to, memo });", // BYPASS B′: innocent destructured name
      "  await o.enqueue('c1', { to, body, partnerId: pickPartner(ctx) });", // the fixed shape: clean
      "  await o.enqueue('c2', { to, sealed: { apply_link: encryptField(`${base}/partners/apply/${token}`) } });", // sealed: clean
      '}',
    ].join('\n');
    const { program } = buildProgram(probe);
    const sf = program.getSourceFile(PROBE)!;
    const checker = program.getTypeChecker();
    const flagged: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'enqueue') {
        const kind = (n.arguments[0] as ts.StringLiteral).text;
        let hit = false;
        const report: Report = () => { hit = true; };
        if (secretIn(checker, checker.getTypeAtLocation(n.arguments[1]))) hit = true;
        scanObject(n.arguments[1], { checker, report, seen: new Set(), depth: 0 });
        if (hit) flagged.push(kind);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(flagged).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  }, 120_000);
});

describe('TRIPWIRE: outbox-repo.enqueue refuses a secret-bearing payload under test (fix 11)', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('rejects creds, a nested WaCreds shape and a PartnerIntegrations shape — naming paths, never values', async () => {
    const outbox = createOutboxRepo(db);
    await expect(outbox.enqueue('whatsapp.text', { to: '1', body: 'x', creds: { phoneNumberId: 'p', token: 'SEKRIT' } }))
      .rejects.toThrow(/secret-bearing shape at \$\.creds/);
    await expect(outbox.enqueue('whatsapp.text', { to: '1', meta: { cfg: { phoneNumberId: 'p', token: 'SEKRIT' } } }))
      .rejects.toThrow(/\$\.meta\.cfg\.token/);
    await expect(outbox.enqueue('email.send', { cfg: { kyc: {}, payment: {}, whatsapp: {} } }))
      .rejects.toThrow(/\$\.cfg \(PartnerIntegrations shape\)/);
    await expect(outbox.enqueue('whatsapp.text', { to: '1', creds: { token: 'SEKRIT' } })).rejects.not.toThrow(/SEKRIT/);
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM outbox`)) as unknown as { rows: Array<{ n: number }> };
    expect(r.rows[0].n).toBe(0);
    expect(await outbox.enqueue('whatsapp.text', { to: '1', body: 'x', partnerId: 'default' })).toBe(true);
  });
});

describe('drizzle/0016_scrub_outbox_secrets (data-only) — scrubs legacy rows without degrading an unsent one, idempotent', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb(); // migrate() already ran 0016 once, against an empty outbox
    await seedPartner(db, 'acme');
    await createIntegrationsRepo(db).saveIntegrations('acme', {
      kyc: {}, payment: {}, whatsapp: { phoneNumberId: 'pn_acme', token: 'tok_acme' },
    });
  });

  async function runMigration(): Promise<void> {
    const file = readFileSync(join(ROOT, 'drizzle/0016_scrub_outbox_secrets.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) {
      if (stmt.trim()) await db.execute(sql.raw(stmt));
    }
  }

  async function payloads(): Promise<Record<string, Record<string, unknown>>> {
    const r = (await db.execute(sql`SELECT dedupe_key, payload FROM outbox ORDER BY id`)) as unknown as {
      rows: Array<{ dedupe_key: string; payload: Record<string, unknown> }>;
    };
    return Object.fromEntries(r.rows.map((x) => [x.dedupe_key, x.payload]));
  }

  it('back-fills partnerId, strips creds only where safe, redacts only FINISHED legacy invites, leaves new-shape rows alone', async () => {
    // Raw INSERTs: these are rows the PREVIOUS release wrote (the enqueue tripwire refuses them).
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, dedupe_key) VALUES
      ('whatsapp.text', '{"to":"1","body":"a","creds":{"phoneNumberId":"pn_acme","token":"LEAKED1"}}'::jsonb, 'pending', 'stage1:legacy_known_pending'),
      ('whatsapp.text', '{"to":"1","body":"b","creds":{"phoneNumberId":"pn_gone","token":"LEAKED2"}}'::jsonb, 'done', 'stage1:legacy_unknown_done'),
      ('whatsapp.text', '{"to":"1","body":"c","creds":{"phoneNumberId":"pn_gone","token":"LEAKED3"}}'::jsonb, 'dead', 'stage1:legacy_unknown_dead'),
      ('whatsapp.text', '{"to":"1","body":"d","creds":{"phoneNumberId":"pn_gone","token":"KEEP4"}}'::jsonb, 'pending', 'stage1:legacy_unknown_pending'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"link: https://x/partners/apply/0123456789abcdef"}'::jsonb, 'done', 'partner_app_invite:preq_done'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"link: https://x/partners/apply/fedcba9876543210"}'::jsonb, 'dead', 'partner_app_invite:preq_dead'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"link: https://x/partners/apply/00112233445566778"}'::jsonb, 'pending', 'partner_app_invite:preq_pending'),
      ('whatsapp.text', '{"to":"1","body":"z","partnerId":"acme"}'::jsonb, 'pending', 'stage1:new'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"{{apply_link}}","sealed":{"apply_link":"v1.a.b.c.d"}}'::jsonb, 'done', 'partner_app_invite:preq_new'),
      ('email.send', '{"to":["team@x"],"subject":"New partner request","text":"Review: https://x/admin-dashboard/partner-requests"}'::jsonb, 'done', 'preq:preq_new'),
      ('funding.refund', '{"transferId":"keep_me"}'::jsonb, 'done', 'refund:keep_me')`);

    await runMigration();
    const by = await payloads();
    // Replaceable ⇒ stripped: the pending row now names acme and re-resolves its creds at drain.
    expect(by['stage1:legacy_known_pending']).toEqual({ to: '1', body: 'a', partnerId: 'acme' });
    // Finished ⇒ stripped (no current owner ⇒ no partnerId).
    expect(by['stage1:legacy_unknown_done']).toEqual({ to: '1', body: 'b' });
    expect(by['stage1:legacy_unknown_dead']).toEqual({ to: '1', body: 'c' });
    // UNSENT and unresolvable ⇒ untouched: 0016 never moves a send to the shared
    // number. The worker now fails such a row closed (fix 12b: no shim) — it
    // dead-letters with an alert, so listSecretsAtRest still reports it.
    expect(by['stage1:legacy_unknown_pending']).toEqual({ to: '1', body: 'd', creds: { phoneNumberId: 'pn_gone', token: 'KEEP4' } });
    // Finished legacy invites are redacted; an UNSENT one keeps its link (never emails the redaction).
    expect(by['partner_app_invite:preq_done'].text).toBe('[redacted by migration 0016: legacy partner-application link]');
    expect(by['partner_app_invite:preq_dead'].text).toBe('[redacted by migration 0016: legacy partner-application link]');
    expect(by['partner_app_invite:preq_pending'].text).toBe('link: https://x/partners/apply/00112233445566778');
    // New-shape and unrelated rows are untouched.
    expect(by['stage1:new']).toEqual({ to: '1', body: 'z', partnerId: 'acme' });
    expect(by['partner_app_invite:preq_new'].text).toBe('{{apply_link}}');
    expect(by['preq:preq_new'].text).toBe('Review: https://x/admin-dashboard/partner-requests');
    expect(by['refund:keep_me']).toEqual({ transferId: 'keep_me' }); // scripts/outbox-status.ts + reconcile read payload->>'transferId'
    expect(JSON.stringify(by)).not.toMatch(/LEAKED/);

    await runMigration(); // idempotent
    expect(await payloads()).toEqual(by);
  });

  // Review of PR #272: the checks must test whether a key has a VALUE, not
  // whether it is present. `"partnerId": null` / `""` is NOT a partner the
  // worker can resolve (str() ⇒ '' ⇒ since fix 12b, a non-null creds beside it
  // fails closed with legacy_creds_payload), and `"creds": null` is not a secret.
  it('a null/empty partnerId is NOT a resolvable partner: it is back-filled when matched and never lets an unsent row lose its creds', async () => {
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, dedupe_key) VALUES
      ('whatsapp.text', '{"to":"1","body":"e","partnerId":null,"creds":{"phoneNumberId":"pn_gone","token":"KEEP5"}}'::jsonb, 'pending', 'stage1:null_pid_unknown_pending'),
      ('whatsapp.text', '{"to":"1","body":"f","partnerId":"","creds":{"phoneNumberId":"pn_gone","token":"KEEP6"}}'::jsonb, 'failed', 'stage1:empty_pid_unknown_failed'),
      ('whatsapp.text', '{"to":"1","body":"g","partnerId":null,"creds":{"phoneNumberId":"pn_acme","token":"LEAKED7"}}'::jsonb, 'pending', 'stage1:null_pid_known_pending'),
      ('whatsapp.template', '{"to":"1","template":"t","partnerId":"","creds":{"phoneNumberId":"pn_acme","token":"LEAKED8"}}'::jsonb, 'pending', 'stage1:empty_pid_known_pending'),
      ('whatsapp.text', '{"to":"1","body":"h","creds":null}'::jsonb, 'pending', 'stage1:null_creds_pending'),
      ('whatsapp.text', '{"to":"1","body":"i","partnerId":"acme","creds":null}'::jsonb, 'pending', 'stage1:null_creds_with_pid')`);

    await runMigration();
    const by = await payloads();
    // Unsent + unresolvable ⇒ untouched (never moved to the shared number); the
    // worker fails it closed (fix 12b) and listSecretsAtRest keeps counting it.
    expect(by['stage1:null_pid_unknown_pending']).toEqual({
      to: '1', body: 'e', partnerId: null, creds: { phoneNumberId: 'pn_gone', token: 'KEEP5' },
    });
    expect(by['stage1:empty_pid_unknown_failed']).toEqual({
      to: '1', body: 'f', partnerId: '', creds: { phoneNumberId: 'pn_gone', token: 'KEEP6' },
    });
    // Matched ⇒ the null/empty partnerId is REPLACED by the owner, then creds are stripped.
    expect(by['stage1:null_pid_known_pending']).toEqual({ to: '1', body: 'g', partnerId: 'acme' });
    expect(by['stage1:empty_pid_known_pending']).toEqual({ to: '1', template: 't', partnerId: 'acme' });
    // A null creds key carries nothing and changes no send: it is dropped, whatever the status.
    expect(by['stage1:null_creds_pending']).toEqual({ to: '1', body: 'h' });
    expect(by['stage1:null_creds_with_pid']).toEqual({ to: '1', body: 'i', partnerId: 'acme' });
    expect(JSON.stringify(by)).not.toMatch(/LEAKED/);

    await runMigration(); // idempotent
    expect(await payloads()).toEqual(by);
  });
});

describe('SECRETS AT REST (scripts/outbox-status.ts gate) — counts rows that still HOLD a secret, never a null key', () => {
  let db: Db;
  beforeEach(async () => { db = await freshDb(); });

  it('counts object creds and cleartext legacy invites by kind/status; ignores "creds": null, partnerId-only rows and sealed invites', async () => {
    await db.execute(sql`INSERT INTO outbox (kind, payload, status, dedupe_key) VALUES
      ('whatsapp.text', '{"to":"1","body":"a","creds":{"phoneNumberId":"pn_x","token":"FAKE1"}}'::jsonb, 'pending', 'stage1:a'),
      ('whatsapp.text', '{"to":"1","body":"b","creds":{"phoneNumberId":"pn_x","token":"FAKE2"}}'::jsonb, 'done', 'stage1:b'),
      ('whatsapp.text', '{"to":"1","body":"c","creds":null}'::jsonb, 'pending', 'stage1:c'),
      ('whatsapp.text', '{"to":"1","body":"d","partnerId":"acme"}'::jsonb, 'pending', 'stage1:d'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"link: https://x/partners/apply/0123"}'::jsonb, 'done', 'partner_app_invite:p1'),
      ('email.send', '{"to":["a@b.c"],"subject":"s","text":"{{apply_link}}","sealed":{"apply_link":"v1.a.b.c.d"}}'::jsonb, 'pending', 'partner_app_invite:p2')`);
    expect(await createOutboxRepo(db).listSecretsAtRest()).toEqual([
      { kind: 'email.send', status: 'done', n: 1 },
      { kind: 'whatsapp.text', status: 'done', n: 1 },
      { kind: 'whatsapp.text', status: 'pending', n: 1 },
    ]);
  });

  it('prints none on an outbox with no secrets', async () => {
    expect(await createOutboxRepo(db).listSecretsAtRest()).toEqual([]);
  });
});
