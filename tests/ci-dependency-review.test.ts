import { describe, expect, it } from 'vitest';
import { classifyChanges, runDependencyReview } from '../scripts/ci/dependency-review.mjs';

// scripts/ci/dependency-review.mjs, a step of ci.yml's `audit` job on pull
// requests: fails a PR that ADDS a runtime package version with a high or
// critical advisory (GitHub dependency graph compare API). Development-scope
// findings only warn (e.g. `braces`, which has no fixed release), and an API
// failure only warns: `npm audit --omit=dev` stays the blocking gate.

const vuln = (severity: string) => ({ severity, advisory_ghsa_id: `GHSA-${severity}`, advisory_summary: `${severity} issue`, advisory_url: 'https://x' });
const change = (over: Record<string, unknown>) => ({
  change_type: 'added',
  manifest: 'package-lock.json',
  ecosystem: 'npm',
  name: 'pkg',
  version: '1.0.0',
  scope: 'runtime',
  vulnerabilities: [],
  ...over,
});

describe('classifyChanges', () => {
  it('blocks an added runtime package with a high or critical advisory', () => {
    const { block, warn } = classifyChanges([
      change({ name: 'a', vulnerabilities: [vuln('high')] }),
      change({ name: 'b', vulnerabilities: [vuln('critical')] }),
    ]);
    expect(block.map((b: { name: string }) => b.name)).toEqual(['a', 'b']);
    expect(warn).toEqual([]);
  });

  it('treats an unknown scope as runtime', () => {
    expect(classifyChanges([change({ scope: 'unknown', vulnerabilities: [vuln('high')] })]).block).toHaveLength(1);
    expect(classifyChanges([change({ scope: undefined, vulnerabilities: [vuln('high')] })]).block).toHaveLength(1);
  });

  it('only warns for development scope', () => {
    const { block, warn } = classifyChanges([change({ scope: 'development', vulnerabilities: [vuln('high')] })]);
    expect(block).toEqual([]);
    expect(warn).toHaveLength(1);
  });

  it('ignores removed packages and moderate or low advisories', () => {
    expect(
      classifyChanges([
        change({ change_type: 'removed', vulnerabilities: [vuln('critical')] }),
        change({ vulnerabilities: [vuln('moderate'), vuln('low')] }),
      ]),
    ).toEqual({ block: [], warn: [] });
  });
});

describe('runDependencyReview', () => {
  const env = {
    EVENT_NAME: 'pull_request',
    PR_BASE_SHA: 'a'.repeat(40),
    PR_HEAD_SHA: 'b'.repeat(40),
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 'tok',
    GITHUB_API_URL: 'https://api.github.com',
  };
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  const answer = (status: number, body: unknown) => {
    const urls: string[] = [];
    const impl = async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url);
      expect(init.headers.Authorization).toBe('Bearer tok');
      return new Response(JSON.stringify(body), { status });
    };
    return { impl, urls };
  };

  it('calls the compare API for base...head', async () => {
    const f = answer(200, []);
    expect(await runDependencyReview({ env, fetchImpl: f.impl, out })).toBe(0);
    expect(f.urls).toEqual([`https://api.github.com/repos/o/r/dependency-graph/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`]);
  });

  it('exits 1 with an error naming the package when a blocking advisory is added', async () => {
    const f = answer(200, [change({ name: 'evil', version: '6.6.6', vulnerabilities: [vuln('critical')] })]);
    expect(await runDependencyReview({ env, fetchImpl: f.impl, out })).toBe(1);
    expect(lines.join('\n')).toMatch(/::error[^\n]*evil@6\.6\.6/);
  });

  it('only warns (exit 0) when the API fails or answers something unexpected', async () => {
    expect(await runDependencyReview({ env, fetchImpl: answer(404, { message: 'Not Found' }).impl, out })).toBe(0);
    expect(await runDependencyReview({ env, fetchImpl: answer(200, { message: 'odd' }).impl, out })).toBe(0);
    expect(lines.join('\n')).toMatch(/::warning/);
  });

  it('skips events other than pull_request', async () => {
    const f = answer(200, []);
    expect(await runDependencyReview({ env: { ...env, EVENT_NAME: 'push' }, fetchImpl: f.impl, out })).toBe(0);
    expect(f.urls).toEqual([]);
  });
});
