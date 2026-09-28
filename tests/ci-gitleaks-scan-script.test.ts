import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Compliance A3, review round 1: behaviour of scripts/ci/gitleaks-scan.sh.
// A temp git repo plus a stub GITLEAKS_BIN that prints its args and exits
// with $STUB_RC. The scan must never pass without scanning the intended
// commits (fail-closed on a missing range end, an empty range or a shallow
// clone).

const SCRIPT = join(__dirname, '..', 'scripts', 'ci', 'gitleaks-scan.sh');
const ZERO = '0'.repeat(40);
const UNKNOWN = '1234567890abcdef1234567890abcdef12345678';

let dir: string;
let repo: string;
let stub: string;
let c1: string;
let c2: string;
let c3: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, 'add', name);
  git(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', name);
  return git(cwd, 'rev-parse', 'HEAD');
}

function run(cwd: string, env: Record<string, string>, rc = 0) {
  const r = spawnSync('bash', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', GITLEAKS_BIN: stub, STUB_RC: String(rc), ...env },
  });
  const m = /--log-opts=(.*)$/m.exec(r.stdout);
  return { status: r.status, logOpts: m?.[1], out: r.stdout + r.stderr };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitleaks-scan-'));
  stub = join(dir, 'stub.sh');
  writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\nexit "${STUB_RC:-0}"\n');
  chmodSync(stub, 0o755);
  repo = join(dir, 'repo');
  git(dir, 'init', '-q', repo);
  writeFileSync(join(repo, '.gitleaks.toml'), '[extend]\nuseDefault = true\n');
  git(repo, 'add', '.gitleaks.toml');
  c1 = commit(repo, 'a');
  c2 = commit(repo, 'b');
  c3 = commit(repo, 'c');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('gitleaks-scan.sh range selection', () => {
  it('pull_request scans base..head', () => {
    const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'pull_request', PR_BASE_SHA: c1, PR_HEAD_SHA: c3 });
    expect(r.status).toBe(0);
    expect(r.logOpts).toBe(`${c1}..${c3}`);
  });

  it('merge_group scans base..head', () => {
    const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'merge_group', MG_BASE_SHA: c2, MG_HEAD_SHA: c3 });
    expect(r.status).toBe(0);
    expect(r.logOpts).toBe(`${c2}..${c3}`);
  });

  it('push with a known before scans before..sha', () => {
    const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'push', PUSH_BEFORE: c1, GITHUB_SHA: c3 });
    expect(r.status).toBe(0);
    expect(r.logOpts).toBe(`${c1}..${c3}`);
  });

  it('push with an all-zeros or unknown before scans the pushed commit alone', () => {
    for (const before of [ZERO, UNKNOWN]) {
      const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'push', PUSH_BEFORE: before, GITHUB_SHA: c3 });
      expect(r.status).toBe(0);
      expect(r.logOpts).toBe(`-1 ${c3}`);
    }
  });

  it('full mode scans HEAD history only', () => {
    const r = run(repo, { SCAN_MODE: 'full' });
    expect(r.status).toBe(0);
    expect(r.logOpts).toBe('--full-history HEAD');
  });

  it('passes the explicit config and --redact to gitleaks', () => {
    const r = run(repo, { SCAN_MODE: 'full' });
    expect(r.out).toMatch(/^--redact$/m);
    expect(r.out).toMatch(/^--config$\n^\.gitleaks\.toml$/m);
  });

  it('a found secret (gitleaks rc=1) fails the scan', () => {
    const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'pull_request', PR_BASE_SHA: c1, PR_HEAD_SHA: c3 }, 1);
    expect(r.status).toBe(1);
  });
});

describe('gitleaks-scan.sh fails closed', () => {
  it('pull_request whose base is not in the clone', () => {
    const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'pull_request', PR_BASE_SHA: UNKNOWN, PR_HEAD_SHA: c3 });
    expect(r.status).toBe(2);
    expect(r.logOpts).toBeUndefined();
  });

  it('merge_group whose base is not in the clone', () => {
    const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'merge_group', MG_BASE_SHA: UNKNOWN, MG_HEAD_SHA: c3 });
    expect(r.status).toBe(2);
    expect(r.logOpts).toBeUndefined();
  });

  it('an empty diff range', () => {
    const r = run(repo, { SCAN_MODE: 'diff', GITHUB_EVENT_NAME: 'pull_request', PR_BASE_SHA: c3, PR_HEAD_SHA: c3 });
    expect(r.status).toBe(2);
    expect(r.logOpts).toBeUndefined();
  });

  it('a missing config file', () => {
    const bare = join(dir, 'noconfig');
    git(dir, 'init', '-q', bare);
    commit(bare, 'x');
    const r = run(bare, { SCAN_MODE: 'full' });
    expect(r.status).toBe(2);
    expect(r.logOpts).toBeUndefined();
  });

  it('a shallow clone', () => {
    const shallow = join(dir, 'shallow');
    git(dir, 'clone', '-q', '--depth', '1', `file://${repo}`, shallow);
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const r = run(shallow, { SCAN_MODE: 'full' });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/::error::/);
    expect(r.logOpts).toBeUndefined();
  });
});
