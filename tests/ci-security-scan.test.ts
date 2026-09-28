import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Compliance A3 (CC6.8 / CC7.1): secret scanning, SAST and a lockfile scan in
// CI, replacing GitHub Advanced Security before the repo goes private. Text
// assertions on the workflow files (the repo has no YAML parser dependency;
// same approach as tests/toolchain-pin.test.ts).

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/** The body of one top-level job in a workflow: from `  <id>:` to the next job. */
function jobBlock(wf: string, id: string): string {
  const lines = wf.split('\n');
  const start = lines.findIndex((l) => l === `  ${id}:`);
  if (start < 0) throw new Error(`job ${id} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i]) || /^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const ci = read('.github/workflows/ci.yml');
const nightly = read('.github/workflows/nightly.yml');
const SCRIPT = 'scripts/ci/gitleaks-scan.sh';

describe('ci.yml security job', () => {
  const job = jobBlock(ci, 'security');

  it('exists, is not named ci, and is a need of the required ci job', () => {
    expect(job).toMatch(/name: security scan/);
    const needs = /needs: \[([^\]]*)\]/.exec(jobBlock(ci, 'ci'));
    expect(needs).not.toBeNull();
    expect(needs![1].split(',').map((s) => s.trim())).toContain('security');
  });

  it('checks out full history so the diff range resolves, without persisting the token', () => {
    expect(job).toMatch(/fetch-depth: 0/);
    expect(job).toMatch(/persist-credentials: false/);
  });

  it('pins gitleaks and osv-scanner by version and verifies each download by sha256', () => {
    expect(job).toMatch(/GITLEAKS_VERSION: '8\.30\.1'/);
    expect(job).toMatch(/GITLEAKS_SHA256: '[0-9a-f]{64}'/);
    expect(job).toMatch(/OSV_SCANNER_VERSION: '2\.6\.0'/);
    expect(job).toMatch(/OSV_SCANNER_SHA256: '[0-9a-f]{64}'/);
    expect((job.match(/sha256sum -c/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('pins semgrep by image digest and the rules repo by commit sha', () => {
    expect(job).toMatch(/SEMGREP_IMAGE: 'semgrep\/semgrep:1\.178\.0@sha256:[0-9a-f]{64}'/);
    expect(job).toMatch(/SEMGREP_RULES_COMMIT: '[0-9a-f]{40}'/);
    expect(job).toMatch(/docker run [^\n]*\\\n[^\n]*"\$SEMGREP_IMAGE"/);
    // The checkout really is the pinned commit, and the container has no network.
    expect(job).toMatch(/test "\$\(git -C "\$rules" rev-parse HEAD\)" = "\$SEMGREP_RULES_COMMIT"/);
    expect(job).toMatch(/docker run --rm --network none /);
  });

  it('runs semgrep offline-only: scan, metrics off, local rules, ERROR gate', () => {
    // Commands only: the comments may name what is forbidden.
    const code = job
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).toMatch(/semgrep scan/);
    expect(code).not.toMatch(/semgrep ci/);
    expect(code).not.toMatch(/--config[ =](auto|p\/|r\/)/);
    expect(job).toMatch(/--metrics=off/);
    expect(job).toMatch(/--disable-version-check/);
    expect(job).toMatch(/--severity ERROR/);
    expect(job).toMatch(/--error/);
    const configs = [...code.matchAll(/--config[ =](\S+)/g)].map((m) => m[1]);
    expect(configs.sort()).toEqual(['/rules/javascript', '/rules/typescript']);
  });

  it('uploads nothing to GitHub code scanning and keeps read-only permissions', () => {
    for (const wf of [ci, nightly]) {
      expect(wf).not.toMatch(/upload-sarif/);
      expect(wf).not.toMatch(/codeql-action/);
      expect(wf).toMatch(/^permissions:\n {2}contents: read$/m);
    }
    expect(job).not.toMatch(/permissions:/);
  });

  it('runs the gitleaks diff scan through the shared script with the three trigger ranges', () => {
    expect(job).toMatch(new RegExp(`bash ${SCRIPT.replace(/\./g, '\\.')}`));
    expect(job).toMatch(/SCAN_MODE: diff/);
    expect(job).toMatch(/PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    expect(job).toMatch(/PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    expect(job).toMatch(/PUSH_BEFORE: \$\{\{ github\.event\.before \}\}/);
    expect(job).toMatch(/MG_BASE_SHA: \$\{\{ github\.event\.merge_group\.base_sha \}\}/);
    expect(job).toMatch(/MG_HEAD_SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}/);
  });

  // Decision: osv-scanner is REPORT-ONLY. `npm audit --omit=dev
  // --audit-level=high` (the audit job) stays the blocking dependency gate;
  // an osv.dev outage or a dev-only advisory must not fail every PR.
  it('osv-scanner runs on the lockfile and is report-only', () => {
    expect(job).toMatch(/osv-scanner[^\n]* scan source -L package-lock\.json/);
    expect(job).toMatch(/report-only/);
    expect(job).toMatch(/::warning/);
    expect(jobBlock(ci, 'audit')).toMatch(/npm audit --omit=dev --audit-level=high/);
  });
});

describe('nightly full-history gitleaks scan', () => {
  const job = jobBlock(nightly, 'secret-scan');

  it('scans the default branch history with full depth', () => {
    expect(job).toMatch(/fetch-depth: 0/);
    expect(job).toMatch(/persist-credentials: false/);
    expect(job).toMatch(/SCAN_MODE: full/);
    expect(job).toMatch(/GITLEAKS_VERSION: '8\.30\.1'/);
    expect(job).toMatch(/GITLEAKS_SHA256: '[0-9a-f]{64}'/);
    expect(job).toMatch(/sha256sum -c/);
    expect(job).toMatch(new RegExp(`bash ${SCRIPT.replace(/\./g, '\\.')}`));
  });

  it('pins the same gitleaks build as ci.yml', () => {
    const pin = (wf: string) => /GITLEAKS_SHA256: '([0-9a-f]{64})'/.exec(wf)?.[1];
    expect(pin(job)).toBeDefined();
    expect(pin(job)).toBe(pin(jobBlock(ci, 'security')));
  });
});

describe(`${SCRIPT}`, () => {
  const sh = read(SCRIPT);

  it('exists and fails fast', () => {
    expect(statSync(join(root, SCRIPT)).isFile()).toBe(true);
    expect(sh).toMatch(/set -euo pipefail/);
  });

  it('redacts on every gitleaks invocation', () => {
    const calls = sh.split('\n').filter((l) => /"\$GITLEAKS_BIN"/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/--redact/);
  });

  it('full mode is scoped to HEAD history, not every fetched branch', () => {
    expect(sh).toMatch(/--full-history HEAD/);
  });

  it('handles pull_request, push (incl. zero/unknown before) and merge_group', () => {
    expect(sh).toMatch(/pull_request\)/);
    expect(sh).toMatch(/merge_group\)/);
    expect(sh).toMatch(/push\)/);
    expect(sh).toMatch(/0{40}/);
    expect(sh).toMatch(/git cat-file -e/);
    // Anything else is a configuration error, never a silent pass.
    expect(sh).toMatch(/\*\)\n\s+fail /);
    expect(sh).toMatch(/fail\(\) \{\n[^}]*exit 2\n\}/);
  });
});

describe('gitleaks baseline', () => {
  it('.gitleaksignore holds only commit-bound fingerprints (no path-wide allowlist)', () => {
    expect(existsSync(join(root, '.gitleaksignore'))).toBe(true);
    const entries = read('.gitleaksignore')
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('#'));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).toMatch(/^[0-9a-f]{40}:.+:[a-z0-9-]+:\d+$/);
  });

  it('.gitleaks.toml extends the default rules and allowlists exact values only', () => {
    const toml = read('.gitleaks.toml');
    expect(toml).toMatch(/^\[extend\]\nuseDefault = true$/m);
    // No path, commit or stopword allowlists: nothing broader than one value.
    expect(toml).not.toMatch(/^\s*(paths|commits|stopwords)\s*=/m);
    expect(toml).not.toMatch(/^\s*\[\[rules\]\]/m);
    const regexes = [...toml.matchAll(/^regexes = \[(.*)\]$/gm)].map((m) => m[1]);
    expect(regexes.length).toBeGreaterThan(0);
    for (const r of regexes) {
      // Each entry is one anchored literal: no wildcard, class or quantifier.
      for (const lit of r.split(',').map((x) => x.trim())) {
        expect(lit).toMatch(/^'''\^[0-9a-f-]+\$'''$/);
      }
    }
    expect(read(SCRIPT)).toMatch(/--config "\$CONFIG"/);
  });
});
