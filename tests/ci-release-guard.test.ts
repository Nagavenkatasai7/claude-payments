import { describe, expect, it } from 'vitest';
import {
  normalizeDeployments,
  pickRollbackTarget,
  rollbackIssue,
  runReleaseCheckFailed,
  runRollback,
} from '../scripts/ci/release-guard.mjs';

// scripts/ci/release-guard.mjs (Release safety Batch 2 part B): the rollback
// job of smoke.yml and the failure job of release-check.yml. The rollback must
// only ever put back the deployment of the commit BEFORE the failed one, and
// only while the failed commit is still production's newest deployment.

const A = 'a'.repeat(40); // failed (newest)
const B = 'b'.repeat(40); // previous
const C = 'c'.repeat(40);

const dep = (uid: string, created: number, sha: string) => ({ uid, created, meta: { githubCommitSha: sha } });
const LIST = { deployments: [dep('dpl_prevB1', 200, B), dep('dpl_failA1', 300, A), dep('dpl_oldC11', 100, C), dep('dpl_redoA2', 250, A)] };

describe('pickRollbackTarget', () => {
  it('picks the newest deployment of a different commit', () => {
    const r = pickRollbackTarget(normalizeDeployments(LIST), A);
    expect(r).toMatchObject({ ok: true, from: { uid: 'dpl_failA1' }, to: { uid: 'dpl_prevB1', sha: B } });
  });

  it('refuses when a newer merge is already production', () => {
    const r = pickRollbackTarget(normalizeDeployments(LIST), B);
    expect(r.ok).toBe(false);
  });

  it('refuses with no earlier commit, an empty list or a short SHA', () => {
    expect(pickRollbackTarget(normalizeDeployments({ deployments: [dep('dpl_failA1', 1, A)] }), A).ok).toBe(false);
    expect(pickRollbackTarget([], A).ok).toBe(false);
    expect(pickRollbackTarget(normalizeDeployments(LIST), 'aaaaaaa').ok).toBe(false);
  });

  it('drops malformed entries', () => {
    expect(normalizeDeployments({ deployments: [{ uid: 'x', created: 1, meta: { githubCommitSha: A } }, dep('dpl_okok11', 1, 'zz')] })).toEqual([]);
  });
});

describe('rollbackIssue', () => {
  it('names both builds, the rolled-back state and the promote step; no secret', () => {
    const i = rollbackIssue({ fromSha: A, toSha: B, fromId: 'dpl_failA1', toId: 'dpl_prevB1', runUrl: 'https://github.com/x/y/actions/runs/1', projectId: 'prj_abc' });
    expect(i.title).toContain('aaaaaaa');
    expect(i.body).toContain('bbbbbbb');
    expect(i.body).toContain('Rolled-back state');
    expect(i.body).toContain('Promote');
    expect(i.body).toContain('/v10/projects/prj_abc/promote/');
  });
});

type Call = { url: string; method: string; body?: string; auth?: string };
function fakeFetch(routes: (c: Call) => Response) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    const c = { url, method: init.method ?? 'GET', body: init.body, auth: init.headers.Authorization };
    calls.push(c);
    return routes(c);
  };
  return { calls, impl };
}

const ENV = {
  TARGET_SHA: A,
  VERCEL_ROLLBACK_TOKEN: 'vtok',
  VERCEL_PROJECT_ID: 'prj_abc',
  VERCEL_TEAM_ID: 'team_xyz',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_TOKEN: 'ghtok',
  RUN_URL: 'https://github.com/o/r/actions/runs/9',
  RUN_ID: '9',
  CRON_SECRET: 'cron',
  ALERT_URL: 'https://smartremit.ai/api/ops/deploy-alert',
};

describe('runRollback', () => {
  it('rolls back to the previous commit, alerts, opens the issue and exits 1 (the job stays red)', async () => {
    const f = fakeFetch((c) => {
      if (c.url.includes('/v6/deployments')) return Response.json(LIST);
      if (c.url.includes('/rollback/')) return new Response(null, { status: 201 });
      if (c.url.includes('deploy-alert')) return Response.json({ queued: true });
      return Response.json({ number: 1 }, { status: 201 });
    });
    const out: string[] = [];
    expect(await runRollback({ env: ENV, fetchImpl: f.impl as never, out: (l) => out.push(l) })).toBe(1);
    const rb = f.calls.find((c) => c.url.includes('/rollback/'))!;
    expect(rb.method).toBe('POST');
    expect(rb.url).toContain('/v1/projects/prj_abc/rollback/dpl_prevB1?');
    expect(rb.url).toContain('teamId=team_xyz');
    expect(rb.auth).toBe('Bearer vtok');
    const alert = JSON.parse(f.calls.find((c) => c.url.includes('deploy-alert'))!.body!);
    expect(alert).toEqual({ kind: 'rollback_done', fromSha: A, toSha: B, runId: '9' });
    expect(f.calls.some((c) => c.url === 'https://api.github.com/repos/o/r/issues')).toBe(true);
    // Never prints a secret.
    expect(out.join('\n')).not.toMatch(/vtok|ghtok|cron/);
  });

  it('a newer production merge: no rollback call, a rollback_failed alert and issue', async () => {
    const f = fakeFetch((c) => (c.url.includes('/v6/deployments') ? Response.json(LIST) : Response.json({}, { status: 201 })));
    expect(await runRollback({ env: { ...ENV, TARGET_SHA: B }, fetchImpl: f.impl as never, out: () => {} })).toBe(1);
    expect(f.calls.some((c) => c.url.includes('/rollback/'))).toBe(false);
    expect(JSON.parse(f.calls.find((c) => c.url.includes('deploy-alert'))!.body!).kind).toBe('rollback_failed');
  });

  it('a missing token or project id fails before any Vercel call', async () => {
    for (const env of [{ ...ENV, VERCEL_ROLLBACK_TOKEN: '' }, { ...ENV, VERCEL_PROJECT_ID: 'nope' }]) {
      const f = fakeFetch(() => Response.json({}, { status: 201 }));
      expect(await runRollback({ env, fetchImpl: f.impl as never, out: () => {} })).toBe(1);
      expect(f.calls.some((c) => c.url.includes('api.vercel.com'))).toBe(false);
    }
  });

  it('a 404 from a build without the alert route is only a warning', async () => {
    const f = fakeFetch((c) => {
      if (c.url.includes('/v6/deployments')) return Response.json(LIST);
      if (c.url.includes('deploy-alert')) return new Response('nf', { status: 404 });
      return new Response(null, { status: 201 });
    });
    const out: string[] = [];
    await runRollback({ env: ENV, fetchImpl: f.impl as never, out: (l) => out.push(l) });
    expect(out.join('\n')).toContain('::warning title=Ops alert not sent::');
    expect(f.calls.some((c) => c.url.endsWith('/issues'))).toBe(true);
  });
});

describe('runReleaseCheckFailed', () => {
  it('alerts with the SHA and deployment id and opens one issue; exit 0', async () => {
    const f = fakeFetch(() => Response.json({}, { status: 201 }));
    const code = await runReleaseCheckFailed({
      env: { ...ENV, DEPLOYMENT_ID: 'dpl_held11', DEPLOYMENT_URL: 'https://claude-payments-x.vercel.app' },
      fetchImpl: f.impl as never,
      out: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(f.calls[0].body!)).toEqual({ kind: 'release_check_failed', sha: A, deploymentId: 'dpl_held11', runId: '9' });
    const issue = JSON.parse(f.calls[1].body!);
    expect(issue.title).toContain('is held');
    expect(issue.body).toContain('https://claude-payments-x.vercel.app');
  });

  it('exits 1 when the issue cannot be written', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/issues') ? new Response('no', { status: 403 }) : Response.json({})));
    expect(await runReleaseCheckFailed({ env: ENV, fetchImpl: f.impl as never, out: () => {} })).toBe(1);
  });
});
