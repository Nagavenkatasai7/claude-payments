#!/usr/bin/env node
/**
 * Failure alert for scheduled workflows (the last job of nightly.yml and
 * worker-heartbeat.yml). GitHub only emails whoever last edited a schedule, so
 * a red Nightly stayed red for days unseen (Sep 30 - Oct 3, 2026).
 *
 * A failed run opens ONE issue per workflow, titled
 * "Scheduled workflow failing: <workflow>", or comments on it if it is already
 * open. The next fully green run comments and closes it. Cancelled or skipped
 * jobs change nothing. The repo is public: the issue carries only job names and
 * the run link, never logs.
 *
 *   node scripts/ci/scheduled-alert.mjs
 *
 * Env: WORKFLOW_NAME, NEEDS (toJSON(needs) of the watched jobs), RUN_URL,
 * GITHUB_REPOSITORY, GITHUB_TOKEN (issues: write), GITHUB_API_URL.
 * Exit 1 when the GitHub API call fails, so the alert job itself turns red.
 */
import { pathToFileURL } from 'node:url';

/**
 * The slice of fetch these scripts use (tests pass a fake).
 * @typedef {(url: string, init: {method?: string, headers: Record<string, string>, body?: string, signal?: AbortSignal}) => Promise<Response>} FetchLike
 */

/** @param {Record<string, {result?: string}>} needs */
export function summarizeNeeds(needs) {
  const entries = Object.entries(needs ?? {});
  const failed = entries.filter(([, v]) => v?.result === 'failure').map(([k]) => k);
  if (failed.length > 0) return { result: 'failure', failed };
  if (entries.length > 0 && entries.every(([, v]) => v?.result === 'success')) return { result: 'success', failed: [] };
  return { result: 'inconclusive', failed: [] };
}

/**
 * @param {'success' | 'failure' | 'inconclusive'} result
 * @param {number | null} openIssue
 * @returns {'create' | 'comment' | 'close' | 'none'}
 */
export function decideAlert(result, openIssue) {
  if (result === 'failure') return openIssue === null ? 'create' : 'comment';
  if (result === 'success' && openIssue !== null) return 'close';
  return 'none';
}

/** @param {string} workflow */
export function issueTitle(workflow) {
  return `Scheduled workflow failing: ${workflow}`;
}

/**
 * @param {{ env: Record<string, string | undefined>, fetchImpl?: FetchLike, out?: (l: string) => void }} opts
 * @returns {Promise<0 | 1>}
 */
export async function runAlert({ env, fetchImpl = fetch, out = console.log }) {
  const workflow = env.WORKFLOW_NAME ?? 'unknown workflow';
  const api = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const repo = env.GITHUB_REPOSITORY ?? '';
  const runUrl = env.RUN_URL ?? '';
  let needs;
  try {
    needs = JSON.parse(env.NEEDS ?? '{}');
  } catch {
    needs = {};
  }
  const { result, failed } = summarizeNeeds(needs);
  const title = issueTitle(workflow);

  const call = async (method, path, body) => {
    const res = await fetchImpl(`${api}/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN ?? ''}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return res.json();
  };

  try {
    const open = await call('GET', '/issues?state=open&per_page=100&sort=created&direction=desc');
    const match = Array.isArray(open) ? open.find((i) => i && !i.pull_request && i.title === title) : undefined;
    const openIssue = match ? match.number : null;
    const action = decideAlert(result, openIssue);
    const failedText = failed.length ? failed.join(', ') : 'none';

    if (action === 'create') {
      const issue = await call('POST', '/issues', {
        title,
        body: [
          `The scheduled **${workflow}** workflow failed.`,
          '',
          `- Failed jobs: ${failedText}`,
          `- Run: ${runUrl}`,
          '',
          'Open the run for the failing step. This issue gets a comment on every further failed run and closes itself after the next fully green run.',
        ].join('\n'),
      });
      out(`Opened issue #${issue.number}: ${title}`);
    } else if (action === 'comment') {
      await call('POST', `/issues/${openIssue}/comments`, { body: `Still failing. Failed jobs: ${failedText}. Run: ${runUrl}` });
      out(`Commented on issue #${openIssue}`);
    } else if (action === 'close') {
      await call('POST', `/issues/${openIssue}/comments`, { body: `Recovered: this run passed. ${runUrl}` });
      await call('PATCH', `/issues/${openIssue}`, { state: 'closed', state_reason: 'completed' });
      out(`Closed issue #${openIssue}`);
    } else {
      out(`No alert change (run ${result}${openIssue ? `, issue #${openIssue} stays open` : ''}).`);
    }
    return 0;
  } catch (e) {
    out(`::error title=Scheduled-run alert failed::${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runAlert({ env: process.env }).then((code) => process.exit(code));
}
