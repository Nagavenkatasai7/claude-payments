import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// UI redesign M2-5: every customer-portal server action is a PUBLIC POST endpoint that must run the
// dark-by-default host gate FIRST. The scanner DISCOVERS every 'use server' module under
// src/app/portal (no hand list): each export is an `export async function` (type-only exports are
// erased and allowed) whose FIRST statement awaits requirePortalSite(), either bare or as
// `const x = await requirePortalSite();`.

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

const isUseServer = (s: ts.Statement) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server';
const hasMod = (n: ts.Node, k: ts.SyntaxKind) => (ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []).some((m) => m.kind === k);

function awaitsGate(e: ts.Expression | undefined): boolean {
  return !!e && ts.isAwaitExpression(e) && ts.isCallExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'requirePortalSite';
}
function firstIsGate(s: ts.Statement | undefined): boolean {
  if (!s) return false;
  if (ts.isExpressionStatement(s)) return awaitsGate(s.expression);
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.length === 1 && awaitsGate(s.declarationList.declarations[0].initializer);
  return false;
}

/**
 * M2-14 (#394 L5): an INLINE 'use server' function (a server action declared inside a page or
 * component) is a public endpoint too. Its first statement after the directive prologue must await
 * requirePortalSite(). Neither this scanner nor the site-host one covered these under src/app/portal.
 */
function inlineViolations(file: string, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const body =
      (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)) && n.body && ts.isBlock(n.body)
        ? n.body
        : undefined;
    if (body) {
      let i = 0;
      let server = false;
      while (i < body.statements.length && ts.isExpressionStatement(body.statements[i]) && ts.isStringLiteral((body.statements[i] as ts.ExpressionStatement).expression)) {
        if (isUseServer(body.statements[i])) server = true;
        i++;
      }
      if (server && !firstIsGate(body.statements[i])) out.push(`${file}: an inline 'use server' function does not start with requirePortalSite()`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function violations(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const inline = inlineViolations(file, sf);
  if (!sf.statements.some(isUseServer)) return inline;
  const out: string[] = [...inline];
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s) ? !s.isTypeOnly : ts.isExportAssignment(s)) out.push(`${file}: non-function export`);
    if (!hasMod(s, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
    if (ts.isFunctionDeclaration(s) && hasMod(s, ts.SyntaxKind.AsyncKeyword) && !hasMod(s, ts.SyntaxKind.DefaultKeyword) && s.body) {
      if (!firstIsGate(s.body.statements[0])) out.push(`${file}: ${s.name?.text} does not start with requirePortalSite()`);
    } else out.push(`${file}: an export that is not an async function`);
  }
  return out;
}

describe('customer-portal server actions gate on the host first', () => {
  const files = walk('src/app/portal');
  it('finds the portal action modules', () => {
    const serverModules = files.filter((f) => ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.Latest).statements.some(isUseServer));
    expect(serverModules.length).toBeGreaterThanOrEqual(3); // login, verify, signout
  });
  it('every export starts with requirePortalSite()', () => {
    expect(files.flatMap((f) => violations(f, readFileSync(f, 'utf8')))).toEqual([]);
  });
  it('M2-14 (#394 L5) self-test: an ungated inline action in a page is flagged; a gated one passes', () => {
    const bad = `export default function Page() {\n  async function act(fd: FormData) {\n    'use server';\n    return fd;\n  }\n  return <form action={act} />;\n}\n`;
    const arrow = `export const X = () => { const a = async () => { 'use server'; await other(); }; return a; };`;
    const good = `export default function Page() {\n  async function act() {\n    'use server';\n    await requirePortalSite();\n  }\n  return <form action={act} />;\n}\n`;
    expect(violations('p.tsx', bad)).toHaveLength(1);
    expect(violations('p.tsx', arrow)).toHaveLength(1);
    expect(violations('p.tsx', good)).toEqual([]);
  });
  it('self-test: an ungated or late-gated action is flagged; both gate forms pass', () => {
    const M = "'use server';\n";
    expect(violations('a.ts', `${M}export async function a() { return 1; }`)).toHaveLength(1);
    expect(violations('a.ts', `${M}export async function a() { const x = 1; await requirePortalSite(); }`)).toHaveLength(1);
    expect(violations('a.ts', `${M}export const a = async () => { await requirePortalSite(); };`)).toHaveLength(1);
    expect(violations('a.ts', `${M}export type S = {};\nexport async function a() { await requirePortalSite(); }\nexport async function b() { const s = await requirePortalSite(); return s; }`)).toEqual([]);
  });
});
