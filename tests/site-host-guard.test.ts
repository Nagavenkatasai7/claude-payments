import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Legacy server actions refuse on any non-apex host (UI redesign M2, X15 / owner I1).
//
// Allowlisting a page path on a partner subdomain makes Next accept a POST there carrying ANY
// server-action id, including one that belongs to a legacy apex module (the action handler runs
// whichever id the request names). So every server action outside the customer portal starts with
// `await refuseOnSiteHost();`. The scanner below DISCOVERS its targets (no hand list, no exemption):
// a module-level 'use server' file may export only guarded `export async function`s (type-only
// exports are erased at build and allowed); an inline 'use server' function body must start with
// the guard right after the directive.

const hostHeader = vi.hoisted(() => ({ value: 'smartremit.ai' as string | null }));
vi.mock('next/headers', async (orig) => ({
  ...(await orig<typeof import('next/headers')>()),
  headers: async () => {
    const h = new Headers();
    if (hostHeader.value !== null) h.set('host', hostHeader.value);
    return h;
  },
}));

import { refuseOnSiteHost } from '@/lib/site-host-guard';

describe('refuseOnSiteHost', () => {
  beforeEach(() => {
    hostHeader.value = 'smartremit.ai';
  });
  it.each(['acme.smartremit.ai', 'ACME.SmartRemit.ai:443', 'api.smartremit.ai', 'xn--abc.smartremit.ai', 'a.b.smartremit.ai'])(
    '%s (a partner site or a refused subdomain) → 404',
    async (host) => {
      hostHeader.value = host;
      await expect(refuseOnSiteHost()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    },
  );
  it.each(['smartremit.ai', 'www.smartremit.ai', 'claude-payments.vercel.app', 'localhost:3000', null])(
    '%s (apex, preview, local, missing) → resolves',
    async (host) => {
      hostHeader.value = host;
      await expect(refuseOnSiteHost()).resolves.toBeUndefined();
    },
  );
});

// ── The scanner ────────────────────────────────────────────────────────────────

const GUARD = 'refuseOnSiteHost';

function isUseServer(s: ts.Statement | undefined): boolean {
  return !!s && ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server';
}

/** The directive prologue (leading string-literal expression statements) of a statement list. */
function prologue(stmts: ts.NodeArray<ts.Statement>): ts.Statement[] {
  const out: ts.Statement[] = [];
  for (const s of stmts) {
    if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) out.push(s);
    else break;
  }
  return out;
}

/** Exactly `await refuseOnSiteHost();` */
function isGuard(s: ts.Statement | undefined): boolean {
  if (!s || !ts.isExpressionStatement(s) || !ts.isAwaitExpression(s.expression)) return false;
  const call = s.expression.expression;
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === GUARD && call.arguments.length === 0;
}

const hasMod = (n: ts.Node, k: ts.SyntaxKind) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === k);

/** Violations in one source text (file name used only for messages and the TSX flag). */
function scanSource(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  // (a) module-level 'use server'
  const moduleLevel = prologue(sf.statements).some(isUseServer);
  if (moduleLevel) {
    for (const s of sf.statements) {
      if (ts.isExportDeclaration(s)) {
        if (!s.isTypeOnly) out.push(`${fileName}:${line(s)} export {…} / re-export in a 'use server' module`);
        continue;
      }
      if (ts.isExportAssignment(s)) {
        out.push(`${fileName}:${line(s)} export default in a 'use server' module`);
        continue;
      }
      if (!hasMod(s, ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue; // erased at build
      if (
        ts.isFunctionDeclaration(s) &&
        !hasMod(s, ts.SyntaxKind.DefaultKeyword) &&
        hasMod(s, ts.SyntaxKind.AsyncKeyword) &&
        s.body
      ) {
        if (!isGuard(s.body.statements[0])) out.push(`${fileName}:${line(s)} ${s.name?.text ?? '?'} does not start with await ${GUARD}()`);
        continue;
      }
      out.push(`${fileName}:${line(s)} an export that is not an 'export async function' in a 'use server' module`);
    }
  }

  // (b) inline 'use server' in any function body
  const visit = (n: ts.Node) => {
    const body =
      (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) &&
      n.body &&
      ts.isBlock(n.body)
        ? n.body
        : undefined;
    if (body) {
      const pro = prologue(body.statements);
      if (pro.some(isUseServer) && !isGuard(body.statements[pro.length])) {
        out.push(`${fileName}:${line(n)} inline 'use server' function does not start with await ${GUARD}()`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) acc.push(p);
  }
  return acc;
}

/** The customer portal's own actions start with requirePortalSite() instead (they must RUN on a site host). */
const OUTSIDE_PORTAL = (p: string) => !p.split('\\').join('/').startsWith('src/app/portal/');

describe('every server action outside the customer portal refuses on a site host', () => {
  const files = walk('src').filter(OUTSIDE_PORTAL);
  const useServerFiles = files.filter((f) => prologue(ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest).statements).some(isUseServer));

  it('discovers the server-action modules (sanity: the scan is not vacuous)', () => {
    expect(useServerFiles.length).toBeGreaterThanOrEqual(24);
  });

  it('no violations anywhere under src/ (outside src/app/portal)', () => {
    const violations = files.flatMap((f) => scanSource(f, readFileSync(f, 'utf8')));
    expect(violations).toEqual([]);
  });
});

describe('scanner self-test (planted fixtures)', () => {
  const MOD = `'use server';\nimport { refuseOnSiteHost } from '@/lib/site-host-guard';\n`;
  it('a guarded async export passes; a type export passes', () => {
    expect(
      scanSource(
        'a.ts',
        `${MOD}export type S = { ok: boolean };\nexport interface I { a: 1 }\nexport async function go(): Promise<{ ok: true } | { ok: false }> {\n  await refuseOnSiteHost();\n  return { ok: true };\n}\n`,
      ),
    ).toEqual([]);
  });
  it('an unguarded async export fails (including a guard that is not FIRST)', () => {
    expect(scanSource('a.ts', `${MOD}export async function go() { return 1; }`)).toHaveLength(1);
    expect(scanSource('a.ts', `${MOD}export async function go() { const x = 1; await refuseOnSiteHost(); return x; }`)).toHaveLength(1);
    expect(scanSource('a.ts', `${MOD}export async function go() { refuseOnSiteHost(); }`)).toHaveLength(1);
    expect(scanSource('a.ts', `${MOD}export async function go() { await refuseOnSiteHost(1); }`)).toHaveLength(1);
  });
  it.each([
    ['export const', `${MOD}export const go = async () => { await refuseOnSiteHost(); };`],
    ['export let', `${MOD}export let go = async function () { await refuseOnSiteHost(); };`],
    ['export {}', `${MOD}async function go() { await refuseOnSiteHost(); }\nexport { go };`],
    ['re-export', `${MOD}export { go } from './other';`],
    ['export *', `${MOD}export * from './other';`],
    ['export default', `${MOD}export default async function go() { await refuseOnSiteHost(); }`],
    ['export default expr', `${MOD}const go = 1;\nexport default go;`],
    ['non-async function', `${MOD}export function go() { return 1; }`],
    ['class', `${MOD}export class Go {}`],
  ])('%s in a use-server module fails', (_label, src) => {
    expect(scanSource('a.ts', src).length).toBeGreaterThan(0);
  });
  it('an unguarded inline action is flagged; a guarded one passes; a non-server module is ignored', () => {
    const inlineBad = `export default function Page() {\n  async function act(fd: FormData) {\n    'use server';\n    return fd;\n  }\n  return act;\n}\n`;
    const inlineArrow = `export const X = () => { const a = async () => { 'use server'; return 1; }; return a; };`;
    const inlineGood = `export default function Page() {\n  async function act() {\n    'use server';\n    await refuseOnSiteHost();\n  }\n  return act;\n}\n`;
    expect(scanSource('p.tsx', inlineBad)).toHaveLength(1);
    expect(scanSource('p.tsx', inlineArrow)).toHaveLength(1);
    expect(scanSource('p.tsx', inlineGood)).toEqual([]);
    expect(scanSource('lib.ts', `export async function notAnAction() { return 1; }\nexport const x = 1;`)).toEqual([]);
  });
});
