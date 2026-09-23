import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_PRODUCTION_VARS } from '@/lib/boot-assert';

// Program-Fix 42 (obs-12): `.env.example` had drifted to 14 of the ~40 names
// `src/lib/env.ts` reads, and 5 of the 8 boot-blocking vars were missing. This
// static test is the only checker (agents may not read `.env*` files), so it
// reads the files with `fs` and reports KEY NAMES only, never values.

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Active `KEY=value` lines only; commented examples do not count. */
function parseEnvExample(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of src.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** Every name `env.ts` reads through `required('X')` or `process.env.X`. */
function namesReadByEnvTs(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/required\('([A-Z0-9_]+)'\)|process\.env\.([A-Z0-9_]+)/g)) {
    names.add(m[1] ?? m[2]);
  }
  return [...names].sort();
}

// Injected by the platform or the runtime, or dead (both branches of
// env.paymentProviderMode return 'mock'; its removal is fix 7's, Phase 4).
const NOT_DOCUMENTED = (name: string) =>
  name.startsWith('VERCEL_') || name === 'NODE_ENV' || name === 'PAYMENT_PROVIDER_MODE';

// A value in the example is empty or one of these non-secret shapes.
const PLACEHOLDER_SHAPES: RegExp[] = [
  /^$/,
  /^(false|true|mock|sandbox)$/,
  /^\d{1,5}$/, // a port
  /^\d{4}-\d{2}-\d{2}$/, // an API version date
  /^https:\/\/[^\s@?#]+$/, // a public URL with no credentials or query
];

describe('.env.example matches the code that reads it', () => {
  const example = parseEnvExample(read('.env.example'));
  const envTsNames = namesReadByEnvTs(read('src/lib/env.ts'));

  it('sanity: the env.ts scan finds the names it should', () => {
    expect(envTsNames).toContain('DATABASE_URL');
    expect(envTsNames).toContain('SEED_ADMIN_USERNAME');
    expect(envTsNames.length).toBeGreaterThan(30);
  });

  it('(a) lists every boot-blocking REQUIRED_PRODUCTION_VARS entry', () => {
    const missing = REQUIRED_PRODUCTION_VARS.filter((n) => !example.has(n));
    expect(missing).toEqual([]);
  });

  it('(b) lists every name src/lib/env.ts reads (except platform-injected and dead ones)', () => {
    const missing = envTsNames.filter((n) => !NOT_DOCUMENTED(n) && !example.has(n));
    expect(missing).toEqual([]);
  });

  it('does not list the dead PAYMENT_PROVIDER_MODE', () => {
    expect(example.has('PAYMENT_PROVIDER_MODE')).toBe(false);
  });

  it('(c) carries no secret-shaped value: every value is empty or a known placeholder', () => {
    // Report the KEY only — never echo a value into test output.
    const offending = [...example.entries()]
      .filter(([, v]) => !PLACEHOLDER_SHAPES.some((re) => re.test(v)))
      .map(([k]) => k);
    expect(offending).toEqual([]);
  });

  it('marks the two set-once settings as never-rotate', () => {
    const src = read('.env.example');
    for (const name of ['FIELD_ENCRYPTION_KEY', 'PASSWORD_PEPPER']) {
      const idx = src.indexOf(`\n${name}=`);
      expect(idx, name).toBeGreaterThan(-1);
      // The comment block right above the key says so.
      const preceding = src.slice(Math.max(0, idx - 400), idx);
      expect(preceding, name).toMatch(/set-once/i);
    }
  });
});
