#!/usr/bin/env node
/**
 * Dependency review for pull requests (a step of ci.yml's `audit` job).
 *
 * Reads GitHub's dependency graph diff for the PR (GET
 * /repos/{repo}/dependency-graph/compare/{base}...{head}, free on public repos,
 * GITHUB_TOKEN with contents: read) and FAILS when the PR adds a runtime
 * package version that has a high or critical advisory. Development-scope
 * findings only warn: `braces` (via eslint-config-next) has a high advisory
 * with no fixed release, so blocking dev scope would block every lockfile
 * change that touches it. An API failure also only warns: `npm audit
 * --omit=dev --audit-level=high` in the same job stays the blocking gate, and
 * a GitHub outage must not stall every PR. This replaces
 * actions/dependency-review-action without adding another third-party action.
 *
 *   node scripts/ci/dependency-review.mjs
 *
 * Env: EVENT_NAME (anything but pull_request skips), PR_BASE_SHA, PR_HEAD_SHA,
 * GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_API_URL. Exit 1 on a blocking finding.
 */
import { pathToFileURL } from 'node:url';

/**
 * The slice of fetch these scripts use (tests pass a fake).
 * @typedef {(url: string, init: {method?: string, headers: Record<string, string>, body?: string, signal?: AbortSignal}) => Promise<Response>} FetchLike
 */

const BLOCKING = new Set(['high', 'critical']);

/** @param {unknown[]} changes */
export function classifyChanges(changes) {
  const block = [];
  const warn = [];
  for (const c of changes) {
    if (!c || c.change_type !== 'added' || !Array.isArray(c.vulnerabilities)) continue;
    const bad = c.vulnerabilities.filter((v) => BLOCKING.has(String(v?.severity).toLowerCase()));
    if (bad.length === 0) continue;
    const item = { name: c.name, version: c.version, manifest: c.manifest, scope: c.scope ?? 'unknown', advisories: bad };
    (c.scope === 'development' ? warn : block).push(item);
  }
  return { block, warn };
}

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const describe = (i) =>
  `${i.name}@${i.version} (${i.scope}, ${i.manifest}): ${i.advisories.map((a) => `${a.severity} ${a.advisory_ghsa_id} ${a.advisory_summary ?? ''}`.trim()).join('; ')}`;

/**
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: FetchLike, out?: (l: string) => void }} opts
 * @returns {Promise<0 | 1>}
 */
export async function runDependencyReview({ env, fetchImpl = fetch, out = console.log }) {
  if (env.EVENT_NAME !== 'pull_request') {
    out(`Dependency review runs on pull requests only (event: ${env.EVENT_NAME || 'none'}).`);
    return 0;
  }
  const base = env.PR_BASE_SHA ?? '';
  const head = env.PR_HEAD_SHA ?? '';
  const api = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const warnOnly = (why) => {
    out(`::warning title=Dependency review did not run::${esc(why)} Report-only; npm audit --omit=dev stays the blocking gate.`);
    return 0;
  };
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) return warnOnly('The base or head commit is missing from the event.');

  let changes;
  try {
    const res = await fetchImpl(`${api}/repos/${env.GITHUB_REPOSITORY}/dependency-graph/compare/${base}...${head}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN ?? ''}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 200) return warnOnly(`The dependency graph compare API answered HTTP ${res.status}.`);
    changes = await res.json();
  } catch (e) {
    return warnOnly(`The dependency graph compare API could not be reached (${e instanceof Error ? e.name : 'error'}).`);
  }
  if (!Array.isArray(changes)) return warnOnly('The dependency graph compare API answered without a list of changes.');

  const { block, warn } = classifyChanges(changes);
  const added = changes.filter((c) => c?.change_type === 'added').length;
  out(`Dependency review: ${changes.length} change(s), ${added} added package version(s).`);
  for (const i of warn) out(`::warning title=Dev dependency with a known advisory::${esc(describe(i))}`);
  for (const i of block) out(`::error title=Runtime dependency with a high advisory::${esc(describe(i))}`);
  return block.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runDependencyReview({ env: process.env }).then((code) => process.exit(code));
}
