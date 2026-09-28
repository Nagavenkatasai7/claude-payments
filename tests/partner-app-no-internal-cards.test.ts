import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// UI redesign M3-22 (spec §3.10 "platform-only tabs removed"): nothing under
// src/app/partner may import the churn-risk scorer, its AI outreach narration,
// or any /admin-dashboard page or server-action module. The single allowed
// exception is the shared MFA enrolment actions (M3-1 reuse).
const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const PARTNER_APP = join(SRC, 'app', 'partner');
const ALLOWED_ADMIN = new Set(['app/admin-dashboard/account/actions']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx?|jsx?|mjs|cjs)$/.test(name) ? [p] : [];
  });
}

// Every module specifier: static import/export-from, side-effect import,
// dynamic import() and require(). Comments are stripped first so a mention in
// prose is not an import.
function specifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: string[] = [];
  const res = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  for (const re of res) for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

// Normalise a specifier to a src-relative module path ("lib/partner-health"),
// or null for a package import.
function toSrcPath(spec: string, fromFile: string): string | null {
  let abs: string;
  if (spec.startsWith('@/')) abs = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) abs = resolve(dirname(fromFile), spec);
  else return null;
  const rel = relative(SRC, abs).split(sep).join('/');
  return rel.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
}

function forbidden(mod: string): boolean {
  if (mod === 'lib/partner-health' || mod === 'lib/partner-health-ai') return true;
  if (mod === 'app/admin-dashboard' || mod.startsWith('app/admin-dashboard/')) return !ALLOWED_ADMIN.has(mod);
  return false;
}

describe('the /partner app never ships the internal churn / AI outreach card (M3-22)', () => {
  it('the scanner sees every import form and resolves aliases and relative paths', () => {
    const from = join(PARTNER_APP, '(app)', 'x', 'page.tsx');
    const src = [
      "import { scorePartnerHealth } from '@/lib/partner-health';",
      "import type { HealthBand } from \"../../../../lib/partner-health\";",
      "export { narratePartnerHealth } from '@/lib/partner-health-ai';",
      "const m = await import('@/app/admin-dashboard/partners/[id]/page');",
      "import '../../../admin-dashboard/partners/actions';",
      "// import { x } from '@/lib/partner-health';",
      "import { requireStaff } from '@/lib/auth';",
      "import { enrol } from '@/app/admin-dashboard/account/actions';",
    ].join('\n');
    const mods = specifiers(src).map((s) => toSrcPath(s, from));
    expect(mods).toEqual([
      'lib/partner-health',
      'lib/partner-health',
      'lib/partner-health-ai',
      'lib/auth',
      'app/admin-dashboard/account/actions',
      'app/admin-dashboard/partners/actions',
      'app/admin-dashboard/partners/[id]/page',
    ]);
    expect(mods.filter((m) => m && forbidden(m))).toEqual([
      'lib/partner-health',
      'lib/partner-health',
      'lib/partner-health-ai',
      'app/admin-dashboard/partners/actions',
      'app/admin-dashboard/partners/[id]/page',
    ]);
  });

  it('no file under src/app/partner imports partner-health, partner-health-ai or an admin-dashboard module', () => {
    const files = walk(PARTNER_APP);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of files) {
      for (const spec of specifiers(readFileSync(f, 'utf8'))) {
        const mod = toSrcPath(spec, f);
        if (mod && forbidden(mod)) hits.push(`${relative(ROOT, f)} -> ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no file under src/app/partner renders the card copy', () => {
    const hits = walk(PARTNER_APP).filter((f) => /churn-risk|Suggested outreach/i.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
