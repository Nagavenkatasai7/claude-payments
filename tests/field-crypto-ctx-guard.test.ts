import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// Program-Fix 46B guard: from 46B, encryptField writes the context-bound v2
// envelope ONLY when it is given a storage context — a call without one would
// silently keep writing the unbound v1 format. And FIELD_CRYPTO_REJECT_V1 keys
// on the read context, so a context-less decrypt would bypass the switch.
// This walks the TypeScript AST of every file under src/ (not a line grep:
// several calls span lines and comments mention the names) and requires a
// third argument that is not the literal `undefined` on every call of the four
// field-crypto entry points.

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const GUARDED = new Set(['encryptField', 'decryptField', 'sealOptional', 'openOptional']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/ \d+\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

interface Offender {
  file: string;
  line: number;
  fn: string;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function scan(file: string): { calls: number; offenders: Offender[] } {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const offenders: Offender[] = [];
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const fn = calleeName(node.expression);
      if (fn && GUARDED.has(fn)) {
        calls += 1;
        const third = node.arguments[2];
        const missing =
          !third ||
          (ts.isIdentifier(third) && third.text === 'undefined') ||
          third.kind === ts.SyntaxKind.NullKeyword;
        if (missing) {
          offenders.push({ file: relative(ROOT, file), line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, fn });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { calls, offenders };
}

describe('every field-crypto call in src/ carries a storage context (46B)', () => {
  const files = sourceFiles(SRC);
  const results = files.map(scan);
  const offenders = results.flatMap((r) => r.offenders);
  const total = results.reduce((n, r) => n + r.calls, 0);

  it('finds the call sites (the scan is not vacuous)', () => {
    // 46B baseline: ~55 guarded calls across repos, actions and libs.
    expect(total).toBeGreaterThan(40);
  });

  it('no encryptField / decryptField / sealOptional / openOptional call lacks a ctx', () => {
    expect(offenders).toEqual([]);
  });

  it('the guard itself flags a context-less call (self-test)', () => {
    const probe = ts.createSourceFile(
      'probe.ts',
      "encryptField(x, provider);\nencryptField(x, undefined, undefined);\nm.openOptional(b, p, c);",
      ts.ScriptTarget.Latest,
      true,
    );
    const hits: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const fn = calleeName(node.expression);
        const third = node.arguments[2];
        if (fn && GUARDED.has(fn) && (!third || (ts.isIdentifier(third) && third.text === 'undefined'))) hits.push(fn);
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(hits).toEqual(['encryptField', 'encryptField']);
  });
});
