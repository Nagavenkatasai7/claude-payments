import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

// Fix pack 6 T21 (P0 rule 13, P18) — client bundles never reach node:*.
//
// A 'use client' file is bundled for the browser together with every module it
// imports at RUNTIME, transitively. A module there that imports `node:url`
// (untrusted-text.ts), `node:crypto` (customer-ref.ts, id.ts) or `node:fs`
// breaks the client build. The modules below are the ones client files reach
// (or will reach in this pack), so each one's runtime import graph must stay
// free of node built-ins. The client entry points this protects:
//   - src/app/partner/(app)/transfers/[id]/aml-explain.tsx  (-> partner-reviews -> compliance-config -> aml-rules;
//     the brief names it under admin-dashboard/transfers/[id]/, which does not exist)
//   - src/app/admin-dashboard/compliance/aml-explain.tsx
//   - src/app/pay/[transferId]/pay-form.tsx                 (-> pay-outcome, legal/disclosure-drafts, legal/esign-consent,
//                                                            legal/risk-warning from T28)
//   - src/app/pay/l/[token]/link-pay-form.tsx
//   - src/app/partner/(app)/settings/settings-forms.tsx
//   - src/app/admin-dashboard/compliance/risk-signals-form.tsx  (T23: may import RISK_SIGNALS from risk-signals)
// compliance-config imports risk-signals from T22 on, so risk-signals.ts is a root here already.
//
// Type-only imports are erased by the compiler and never bundled, so they are
// skipped: `import type`, `export type ... from`, and an import whose every
// named binding is `type` (TS and SWC elide it). Runtime edges followed:
// static imports (side-effect ones included), `export ... from`, dynamic
// `import()` and `require()`; `./x`, `../x` and `@/x` resolve to .ts/.tsx/index.
//
// src/lib/legal/provider-line.ts and src/lib/legal/cancel-drafts.ts are SERVER-only
// today (provider-line -> untrusted-text -> node:url; cancel-drafts -> payment ->
// untrusted-text): they are not roots, and the second test keeps them out of
// every 'use client' file.

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const LEGAL_SERVER_ONLY = new Set(['provider-line.ts', 'cancel-drafts.ts']);

const ROOTS: readonly string[] = [
  'src/lib/risk-signals.ts',
  'src/lib/compliance-config.ts',
  'src/lib/partner-reviews.ts',
  'src/lib/aml-rules.ts',
  'src/lib/pay-outcome.ts',
  'src/lib/live-certified.ts',
  'src/lib/partner-decision-scope.ts',
  'src/lib/hold-queue.ts',
  'src/lib/reg-clocks.ts',
  'src/lib/error-notice.ts',
  'src/lib/reg-case-view.ts',
  ...readdirSync(join(SRC, 'lib/legal'))
    .filter((f) => f.endsWith('.ts') && !LEGAL_SERVER_ONLY.has(f))
    .sort()
    .map((f) => `src/lib/legal/${f}`),
];

/** Bare node built-ins a browser bundle cannot resolve (the `node:` scheme is always refused). */
const NODE_BARE = new Set([
  'crypto', 'url', 'fs', 'fs/promises', 'path', 'os', 'child_process', 'net', 'tls', 'http', 'https', 'zlib',
  'stream', 'util', 'worker_threads', 'dns', 'module', 'async_hooks', 'perf_hooks', 'v8', 'vm',
]);

function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith('node:') || NODE_BARE.has(spec);
}

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
  else return null; // a package: not walked
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  throw new Error(`cannot resolve ${spec} from ${relative(ROOT, fromFile)}`);
}

/** The runtime module specifiers of one source file. */
function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let typeOnly = false;
      if (clause) {
        if (clause.isTypeOnly) typeOnly = true;
        else if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const els = clause.namedBindings.elements;
          typeOnly = els.length > 0 && els.every((e) => e.isTypeOnly);
        }
      }
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      let typeOnly = node.isTypeOnly;
      if (!typeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const els = node.exportClause.elements;
        typeOnly = els.length > 0 && els.every((e) => e.isTypeOnly);
      }
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every chain from `start` that ends in a node built-in, as "a.ts -> b.ts -> node:url".
 * With `stopAtUseServer`, a 'use server' module is not walked: Next replaces it in a
 * client bundle with references to its server functions
 * (node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-server.md).
 */
function nodeChains(start: string, stopAtUseServer = false): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    if (stopAtUseServer && chain.length > 1 && hasFileDirective(file, 'use server')) return;
    for (const spec of runtimeSpecifiers(file)) {
      if (isNodeBuiltin(spec)) {
        bad.push([...chain, spec].join(' -> '));
        continue;
      }
      const next = resolveLocal(file, spec);
      if (next) walk(next, [...chain, relative(ROOT, next)]);
    }
  };
  const abs = join(ROOT, start);
  walk(abs, [start]);
  return bad;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** True when the file starts with the given directive ('use client' or 'use server'). */
function hasFileDirective(file: string, directive: 'use client' | 'use server'): boolean {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const first = sf.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === directive
  );
}

function isUseClient(file: string): boolean {
  return hasFileDirective(file, 'use client');
}

describe('client-reachable modules never reach node:* (P0 rule 13)', { retry: 0 }, () => {
  it('the root list is what the contract names (legal/*.ts included)', () => {
    expect(ROOTS).toEqual(expect.arrayContaining([
      'src/lib/risk-signals.ts', 'src/lib/compliance-config.ts', 'src/lib/partner-reviews.ts', 'src/lib/aml-rules.ts',
      'src/lib/pay-outcome.ts', 'src/lib/legal/disclosure-drafts.ts', 'src/lib/legal/esign-consent.ts',
      'src/lib/legal/risk-warning.ts', 'src/lib/legal/drafts.ts', 'src/lib/legal/error-notice-drafts.ts',
      'src/lib/live-certified.ts', 'src/lib/partner-decision-scope.ts', 'src/lib/hold-queue.ts',
    ]));
    for (const r of ROOTS) expect(existsSync(join(ROOT, r)), r).toBe(true);
  });

  it.each(ROOTS)('%s has no runtime import chain to a node built-in', (root) => {
    const chains = nodeChains(root);
    expect(chains, `client-reachable module reaches node:*:\n  ${chains.join('\n  ')}`).toEqual([]);
  });

  it('the walker sees through a multi-hop chain (untrusted-text reaches node:url)', () => {
    expect(nodeChains('src/lib/purpose-detail.ts').some((c) => c.endsWith('node:url'))).toBe(true);
    expect(nodeChains('src/lib/legal/provider-line.ts').some((c) => c.endsWith('node:url'))).toBe(true);
  });
});

// Fix pack 6 review round 2 (H2): the walk ALSO starts from the client entry
// points themselves, so a chain through a module that is not a root above (for
// example @/lib/i18n -> catalogues/en.ts -> hold-replies.ts -> untrusted-text.ts
// -> node:url) is caught. A 'use server' module ends the walk (see nodeChains).
const CLIENT_ENTRY_POINTS: readonly string[] = [
  'src/app/pay/[transferId]/pay-form.tsx',
  'src/app/pay/l/[token]/link-pay-form.tsx',
  'src/app/partner/(app)/settings/settings-forms.tsx',
  'src/app/partner/(app)/transfers/[id]/aml-explain.tsx',
  'src/app/admin-dashboard/compliance/aml-explain.tsx',
  'src/app/admin-dashboard/compliance/risk-signals-form.tsx',
  'src/app/portal/profile/profile-forms.tsx',
];

describe("the client entry points never reach node:* (P0 rule 13, H2)", { retry: 0 }, () => {
  it('each listed entry point is a use client file', () => {
    for (const f of CLIENT_ENTRY_POINTS) expect(isUseClient(join(ROOT, f)), f).toBe(true);
  });

  it.each(CLIENT_ENTRY_POINTS)('%s has no runtime import chain to a node built-in', (entry) => {
    const chains = nodeChains(entry, true);
    expect(chains, `client entry point reaches node:*:\n  ${chains.join('\n  ')}`).toEqual([]);
  });

  it("the walk stops at a 'use server' module (whose server code does reach node:*)", () => {
    // Without the stop, a client file that imports its actions.ts would walk the server code.
    const withActions = CLIENT_ENTRY_POINTS.filter((f) =>
      runtimeSpecifiers(join(ROOT, f)).some((s) => {
        const t = resolveLocal(join(ROOT, f), s);
        return !!t && hasFileDirective(t, 'use server');
      }),
    );
    expect(withActions.length).toBeGreaterThan(0);
    for (const f of withActions) expect(nodeChains(f, false).length, f).toBeGreaterThan(0);
  });
});

describe("no 'use client' file imports a server-only module directly", { retry: 0 }, () => {
  const SERVER_ONLY = [
    'risk-chat-cue', 'purpose-detail', 'untrusted-text', 'customer-ref', 'esign', 'hold-replies',
    'legal/provider-line', 'legal/cancel-drafts',
  ];
  const clientFiles = walkFiles(join(SRC, 'app')).filter(isUseClient);

  it('finds the client entry points it protects', () => {
    const rel = clientFiles.map((f) => relative(ROOT, f));
    expect(rel).toEqual(expect.arrayContaining([
      'src/app/pay/[transferId]/pay-form.tsx',
      'src/app/pay/l/[token]/link-pay-form.tsx',
      'src/app/partner/(app)/settings/settings-forms.tsx',
      'src/app/partner/(app)/transfers/[id]/aml-explain.tsx',
      'src/app/admin-dashboard/compliance/aml-explain.tsx',
      // Review round 1 (H1): the two client files pack 6 adds or changes.
      'src/app/admin-dashboard/compliance/risk-signals-form.tsx',
      'src/app/portal/profile/profile-forms.tsx',
    ]));
  });

  it('none of them imports risk-chat-cue, purpose-detail, untrusted-text, customer-ref, esign, hold-replies or the server-only legal files', () => {
    const hits: string[] = [];
    for (const file of clientFiles) {
      for (const spec of runtimeSpecifiers(file)) {
        const target = resolveLocal(file, spec);
        if (!target) continue;
        const mod = relative(join(SRC, 'lib'), target).replace(/\.tsx?$/, '');
        if (SERVER_ONLY.includes(mod)) hits.push(`${relative(ROOT, file)} -> ${spec}`);
      }
    }
    // Pre-existing (live since #454, outside pack 6): the branding form reads two
    // length constants from untrusted-text. It is pinned here so no NEW import
    // joins it; moving BRAND_MAX/PERSONA_MAX to a pure module is a follow-up.
    const KNOWN = ['src/app/partner/(app)/branding/branding-forms.tsx -> @/lib/untrusted-text'];
    expect(hits.sort()).toEqual(KNOWN);
  });
});
