import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// CI/CD review 2026-10-04 (Batch A): workflow wiring that the scripts in
// scripts/ci/ depend on. Text assertions on the workflow files, as in
// tests/ci-security-scan.test.ts (the repo has no YAML parser dependency).

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

const jobIds = (wf: string) => {
  const body = wf.slice(wf.indexOf('\njobs:\n'));
  return [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
};

const ci = read('.github/workflows/ci.yml');
const nightly = read('.github/workflows/nightly.yml');
const heartbeat = read('.github/workflows/worker-heartbeat.yml');

describe('third-party actions are pinned by commit SHA', () => {
  const files = [
    ...readdirSync(join(root, '.github/workflows'))
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => `.github/workflows/${f}`),
    '.github/actions/setup-playwright/action.yml',
  ];

  it('every non-local `uses:` is @<40-hex sha> with the version in a comment', () => {
    const uses = files.flatMap((f) =>
      [...read(f).matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].map((m) => ({ f, ref: m[1], rest: m[2] })),
    );
    const remote = uses.filter((u) => !u.ref.startsWith('./'));
    expect(remote.length).toBeGreaterThan(20);
    for (const u of remote) {
      expect({ f: u.f, ref: u.ref }).toEqual({ f: u.f, ref: expect.stringMatching(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/) });
      expect({ f: u.f, comment: u.rest.trim() }).toEqual({ f: u.f, comment: expect.stringMatching(/^# v\d/) });
    }
  });

  it('pins each action to one SHA everywhere', () => {
    const byAction = new Map<string, Set<string>>();
    for (const f of files) {
      for (const m of read(f).matchAll(/uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})/g)) {
        byAction.set(m[1], (byAction.get(m[1]) ?? new Set()).add(m[2]));
      }
    }
    for (const [action, shas] of byAction) expect({ action, count: shas.size }).toEqual({ action, count: 1 });
  });

  it('Dependabot watches github-actions, including the composite action', () => {
    const dep = read('.github/dependabot.yml');
    expect(dep).toMatch(/package-ecosystem: github-actions/);
    expect(dep).toMatch(/- '\/\.github\/actions\/setup-playwright'/);
    expect(dep).toMatch(/package-ecosystem: npm/);
  });
});

describe('ci.yml migration safety job', () => {
  const job = jobBlock(ci, 'migrations');

  it('is a need of the required ci job and is not named ci', () => {
    expect(job).toMatch(/name: migration safety/);
    const needs = /needs: \[([^\]]*)\]/.exec(jobBlock(ci, 'ci'));
    expect(needs![1].split(',').map((s) => s.trim())).toContain('migrations');
  });

  it('checks out full history without persisting the token, then runs the guard', () => {
    expect(job).toMatch(/fetch-depth: 0/);
    expect(job).toMatch(/persist-credentials: false/);
    expect(job).toMatch(/run: node scripts\/ci\/migration-guard\.mjs/);
    expect(job).toMatch(/PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
    expect(job).toMatch(/PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
    expect(job).toMatch(/MIGRATIONS_URL: https:\/\/smartremit\.ai\/api\/version\/migrations/);
  });

  it('is the only place in ci.yml that receives a secret', () => {
    const secrets = [...ci.matchAll(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g)].map((m) => m[1]);
    expect(secrets).toEqual(['CRON_SECRET']);
    expect(job).toMatch(/CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}/);
  });
});

describe('ci.yml dependency review', () => {
  it('runs in the audit job after the blocking prod audit, with the read-only token', () => {
    const job = jobBlock(ci, 'audit');
    expect(job.indexOf('npm audit --omit=dev --audit-level=high')).toBeLessThan(job.indexOf('dependency-review.mjs'));
    expect(job).toMatch(/run: node scripts\/ci\/dependency-review\.mjs/);
    expect(job).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
    expect(job).not.toMatch(/permissions:/);
  });
});

describe('scheduled workflows alert on failure', () => {
  it.each([
    ['nightly.yml', nightly],
    ['worker-heartbeat.yml', heartbeat],
  ])('%s: an alert job needs every other job, always runs, and alone may write issues', (_name, wf) => {
    const alert = jobBlock(wf, 'alert');
    const others = jobIds(wf).filter((j) => j !== 'alert');
    expect(others.length).toBeGreaterThan(0);
    const needs = /needs: \[([^\]]*)\]/.exec(alert);
    expect(needs![1].split(',').map((s) => s.trim()).sort()).toEqual([...others].sort());
    expect(alert).toMatch(/if: \$\{\{ always\(\) \}\}/);
    expect(alert).toMatch(/permissions:\n\s+contents: read\n\s+issues: write/);
    expect(alert).toMatch(/run: node scripts\/ci\/scheduled-alert\.mjs/);
    expect(alert).toMatch(/NEEDS: \$\{\{ toJSON\(needs\) \}\}/);
    for (const j of others) expect(jobBlock(wf, j)).not.toMatch(/issues: write/);
  });

  it('keeps the top-level permissions of both workflows', () => {
    expect(nightly).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(heartbeat).toMatch(/^permissions: \{\}$/m);
  });
});

describe('nightly.yml', () => {
  it('blocks on production advisories and only reports dev-tree ones', () => {
    const job = jobBlock(nightly, 'audit');
    expect(job).toMatch(/- name: Audit production dependencies\n\s+run: npm audit --omit=dev --audit-level=high/);
    const full = job.slice(job.indexOf('Audit all dependencies (report-only)'));
    expect(full).toMatch(/npm audit --audit-level=high > /);
    expect(full).toMatch(/::warning/);
  });

  it('prod smoke runs every e2e spec, like the post-deploy smoke', () => {
    const job = jobBlock(nightly, 'prod-smoke');
    expect(job).toMatch(/run: npm run e2e/);
    expect(job).not.toMatch(/dashboard-smoke\.spec\.ts/);
    expect(read('.github/workflows/smoke.yml')).toMatch(/run: npm run e2e/);
  });
});

describe('PR template (release safety plan, PR 1)', () => {
  // SOC 2 CC8.1 and PCI DSS 6.5.2 ask each change to record its risk, its
  // approval evidence and its rollback; GitHub prefills new PR bodies from
  // this file.
  const tpl = () => read('.github/pull_request_template.md');

  it('has every section the change record needs, in order', () => {
    const headings = [...tpl().matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    expect(headings).toEqual([
      'Before',
      'After',
      'Touches money, auth, webhooks, crypto or compliance?',
      'Migration?',
      'Risk',
      'Rollback',
      'Tests run',
    ]);
  });

  it('asks for /security-review and /migrate-prod where they apply', () => {
    expect(tpl()).toContain('/security-review');
    expect(tpl()).toContain('/migrate-prod');
    expect(tpl()).toContain('after-deploy');
  });

  it('keeps the Program-Fix line on its own line for the tracker', () => {
    expect(tpl()).toMatch(/^Program-Fix: <n>/m);
  });
});
