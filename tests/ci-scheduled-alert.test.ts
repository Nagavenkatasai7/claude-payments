import { describe, expect, it } from 'vitest';
import { decideAlert, issueTitle, runAlert, summarizeNeeds } from '../scripts/ci/scheduled-alert.mjs';

// scripts/ci/scheduled-alert.mjs: the last job of nightly.yml and
// worker-heartbeat.yml. A failed scheduled run opens one GitHub issue per
// workflow (or comments on the open one); the next green run closes it. Before
// this, the Nightly was red Sep 30 - Oct 3 and nobody was told.

describe('summarizeNeeds', () => {
  it('is failure when any job failed, listing them', () => {
    expect(summarizeNeeds({ a: { result: 'success' }, b: { result: 'failure' }, c: { result: 'failure' } })).toEqual({
      result: 'failure',
      failed: ['b', 'c'],
    });
  });

  it('is success only when every job succeeded', () => {
    expect(summarizeNeeds({ a: { result: 'success' }, b: { result: 'success' } })).toEqual({ result: 'success', failed: [] });
  });

  it('is inconclusive for cancelled or skipped jobs without a failure', () => {
    expect(summarizeNeeds({ a: { result: 'success' }, b: { result: 'cancelled' } }).result).toBe('inconclusive');
    expect(summarizeNeeds({}).result).toBe('inconclusive');
  });
});

describe('decideAlert', () => {
  it.each([
    ['failure', null, 'create'],
    ['failure', 12, 'comment'],
    ['success', 12, 'close'],
    ['success', null, 'none'],
    ['inconclusive', 12, 'none'],
    ['inconclusive', null, 'none'],
  ] as const)('%s with open issue %s -> %s', (result, open, action) => {
    expect(decideAlert(result, open)).toBe(action);
  });
});

describe('issueTitle', () => {
  it('is fixed per workflow so runs find the same issue', () => {
    expect(issueTitle('Nightly')).toBe('Scheduled workflow failing: Nightly');
  });
});

describe('runAlert', () => {
  const env = (needs: object, extra: Record<string, string> = {}) => ({
    WORKFLOW_NAME: 'Nightly',
    NEEDS: JSON.stringify(needs),
    RUN_URL: 'https://github.com/o/r/actions/runs/1',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'tok',
    GITHUB_API_URL: 'https://api.github.com',
    ...extra,
  });

  function fakeGitHub(openIssues: Array<{ number: number; title: string; pull_request?: object }>) {
    const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
    const impl = async (url: string, init: { method?: string; body?: string; headers: Record<string, string> }) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
      expect(init.headers.Authorization).toBe('Bearer tok');
      if (method === 'GET') return new Response(JSON.stringify(openIssues), { status: 200 });
      return new Response(JSON.stringify({ number: 99 }), { status: method === 'POST' ? 201 : 200 });
    };
    return { impl, calls };
  }
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);

  it('opens an issue naming the failed jobs and the run', async () => {
    const gh = fakeGitHub([]);
    expect(await runAlert({ env: env({ audit: { result: 'failure' }, tests: { result: 'success' } }), fetchImpl: gh.impl, out })).toBe(0);
    const post = gh.calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('https://api.github.com/repos/o/r/issues');
    expect(post?.body?.title).toBe('Scheduled workflow failing: Nightly');
    expect(String(post?.body?.body)).toMatch(/audit/);
    expect(String(post?.body?.body)).toMatch(/actions\/runs\/1/);
  });

  it('comments on the open issue instead of opening a second one, ignoring PRs and other titles', async () => {
    const gh = fakeGitHub([
      { number: 5, title: 'Scheduled workflow failing: Nightly', pull_request: {} },
      { number: 6, title: 'Scheduled workflow failing: worker-heartbeat' },
      { number: 7, title: 'Scheduled workflow failing: Nightly' },
    ]);
    await runAlert({ env: env({ audit: { result: 'failure' } }), fetchImpl: gh.impl, out });
    const writes = gh.calls.filter((c) => c.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toBe('https://api.github.com/repos/o/r/issues/7/comments');
  });

  it('closes the open issue after a green run, with a comment first', async () => {
    const gh = fakeGitHub([{ number: 7, title: 'Scheduled workflow failing: Nightly' }]);
    await runAlert({ env: env({ audit: { result: 'success' } }), fetchImpl: gh.impl, out });
    const writes = gh.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.github.com/repos/o/r/issues/7/comments',
      'PATCH https://api.github.com/repos/o/r/issues/7',
    ]);
    expect(writes[1].body).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('writes nothing for a green run with no open issue, or a cancelled run', async () => {
    for (const needs of [{ a: { result: 'success' } }, { a: { result: 'cancelled' } }]) {
      const gh = fakeGitHub([{ number: 7, title: 'Scheduled workflow failing: Nightly' }].filter(() => needs.a.result === 'cancelled'));
      await runAlert({ env: env(needs), fetchImpl: gh.impl, out });
      expect(gh.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    }
  });

  it('exits 1 when the GitHub API refuses, so the alert job itself shows red', async () => {
    const impl = async () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 });
    expect(await runAlert({ env: env({ a: { result: 'failure' } }), fetchImpl: impl, out })).toBe(1);
  });
});
