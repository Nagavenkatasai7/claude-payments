import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Program-Fix 40 (build-07, vercel-12, build-06). Pins the toolchain and the
// flake policy in files, so a drift shows up as a red test instead of a
// "works on my machine" surprise.

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const major = (v: string) => {
  const m = /^\s*v?(\d+)/.exec(v);
  if (!m) throw new Error(`no major version in ${JSON.stringify(v)}`);
  return Number(m[1]);
};

describe('Node version pin', () => {
  it('.nvmrc, package.json engines.node and every workflow node-version agree on one major', () => {
    expect(existsSync(join(root, '.nvmrc'))).toBe(true);
    const nvmrc = major(read('.nvmrc'));
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBeDefined();
    const engines = major(pkg.engines!.node!);
    expect(engines).toBe(nvmrc);

    const wfDir = join(root, '.github/workflows');
    const versions: Array<{ file: string; v: string }> = [];
    for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
      for (const m of read(`.github/workflows/${f}`).matchAll(/node-version:\s*['"]?([^'"\s]+)['"]?/g)) {
        versions.push({ file: f, v: m[1] });
      }
    }
    // Non-vacuous: the workflows do set up Node. Not a fixed count (other
    // fixes edit ci.yml).
    expect(versions.length).toBeGreaterThan(0);
    for (const { file, v } of versions) {
      expect({ file, major: major(v) }).toEqual({ file, major: nvmrc });
    }
  });
});

describe('flake policy (build-06)', () => {
  it('vitest.config.ts sets an explicit testTimeout and hookTimeout', () => {
    const cfg = read('vitest.config.ts');
    expect(cfg).toMatch(/testTimeout:\s*15_000/);
    expect(cfg).toMatch(/hookTimeout:\s*30_000/);
  });

  // Money and tenant suites never hide a flake behind the CI retry: a test's
  // own retry wins over config.retry (`options.retry ?? runner.config.retry`,
  // node_modules/@vitest/runner/dist/chunk-hooks.js:617), and nested describes
  // and tests inherit the suite options (chunk-hooks.js:655-657, 772-775).
  for (const file of ['tests/pay-finalize.test.ts', 'tests/settlement.test.ts', 'tests/scoped-store.test.ts']) {
    it(`${file}: every top-level describe carries { retry: 0 }`, () => {
      const lines = read(file).split('\n').filter((l) => l.startsWith('describe('));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) expect(l).toMatch(/^describe\((['"`]).*\1, \{ retry: 0 \}, /);
    });
  }
});
