#!/usr/bin/env node
/**
 * Release safety Batch 2 part B: what a workflow does when a release fails.
 *
 *   node scripts/ci/release-guard.mjs release-check-failed
 *     release-check.yml: the synthetic sandbox transfer failed on a HELD
 *     production deployment. Vercel Deployment Checks keep the build held, so
 *     nothing is rolled back. This opens a GitHub issue and raises one ops alert.
 *
 *   node scripts/ci/release-guard.mjs rollback
 *     smoke.yml `rollback` job: the money test or the health check failed on
 *     the LIVE build. This puts the previous production deployment back
 *     (Vercel rollback API), opens a GitHub issue and raises one ops alert.
 *     It refuses when production's newest deployment is not the failed commit
 *     (a newer merge already replaced it): rolling back then would undo that.
 *
 * The repo is public: issues carry SHAs, deployment ids and the run link only,
 * never logs or a secret. The ops alert goes through POST /api/ops/deploy-alert
 * (Bearer CRON_SECRET, fixed kinds); a 404 from a build without that route is
 * a warning, not a failure.
 *
 * Env (both): GITHUB_REPOSITORY, GITHUB_TOKEN (issues: write), GITHUB_API_URL,
 *   RUN_URL, RUN_ID, CRON_SECRET, ALERT_URL (https://smartremit.ai/api/ops/deploy-alert).
 * release-check-failed: TARGET_SHA, DEPLOYMENT_ID, DEPLOYMENT_URL.
 * rollback: TARGET_SHA, VERCEL_ROLLBACK_TOKEN, VERCEL_PROJECT_ID, VERCEL_TEAM_ID.
 * Exit 1 when the rollback fails or the GitHub issue cannot be written.
 */
import { pathToFileURL } from 'node:url';

/**
 * @typedef {(url: string, init: {method?: string, headers: Record<string, string>, body?: string, signal?: AbortSignal}) => Promise<Response>} FetchLike
 * @typedef {{ uid: string, created: number, sha: string }} Dep
 */

const SHA = /^[0-9a-f]{40}$/;
const DPL = /^dpl_[A-Za-z0-9]{6,64}$/;
const VERCEL_API = 'https://api.vercel.com';

/** Normalise the Vercel list response to {uid, created, sha}, newest first. */
export function normalizeDeployments(json) {
  const list = Array.isArray(json?.deployments) ? json.deployments : [];
  return list
    .map((d) => ({
      uid: typeof d?.uid === 'string' ? d.uid : '',
      created: Number(d?.created ?? d?.createdAt ?? 0),
      sha: typeof d?.meta?.githubCommitSha === 'string' ? d.meta.githubCommitSha.toLowerCase() : '',
    }))
    .filter((d) => DPL.test(d.uid) && SHA.test(d.sha) && Number.isFinite(d.created))
    .sort((a, b) => b.created - a.created);
}

/**
 * Which deployment to roll back TO. `deps` are READY production deployments,
 * newest first. The failed commit must be the newest one; the target is the
 * newest deployment of a DIFFERENT commit.
 * @param {Dep[]} deps
 * @param {string} failedSha full 40-hex SHA
 * @returns {{ ok: true, from: Dep, to: Dep } | { ok: false, reason: string }}
 */
export function pickRollbackTarget(deps, failedSha) {
  const sha = String(failedSha ?? '').toLowerCase();
  if (!SHA.test(sha)) return { ok: false, reason: 'The failed commit is not a full SHA.' };
  if (deps.length === 0) return { ok: false, reason: 'Vercel listed no READY production deployment.' };
  if (deps[0].sha !== sha) {
    return { ok: false, reason: `Production's newest deployment is commit ${deps[0].sha.slice(0, 7)}, not ${sha.slice(0, 7)}. A newer merge replaced it, so nothing is rolled back.` };
  }
  const to = deps.find((d) => d.sha !== sha);
  if (!to) return { ok: false, reason: 'No earlier production deployment of another commit exists.' };
  return { ok: true, from: deps[0], to };
}

export function rollbackIssue({ fromSha, toSha, fromId, toId, runUrl, projectId }) {
  return {
    title: `Automatic rollback: build ${fromSha.slice(0, 7)} failed the post-release check`,
    body: [
      `The post-deploy smoke found a failure in the money test or the health check on build \`${fromSha.slice(0, 7)}\` (deployment \`${fromId}\`).`,
      '',
      `Production is rolled back to build \`${toSha.slice(0, 7)}\` (deployment \`${toId}\`).`,
      '',
      '**Rolled-back state.** After a rollback, Vercel does not promote new production deployments automatically. New merges build, but they do not go live until a person promotes one.',
      '',
      'What to do:',
      '1. Open the smoke run below and find the cause.',
      '2. Merge the fix (or a revert) to `main`.',
      '3. In Vercel > Deployments, open the new production deployment and select **Promote**. This also ends the rolled-back state.',
      `   API form: \`POST /v10/projects/${projectId}/promote/<deploymentId>\` with a Vercel token.`,
      '4. Check that the smoke run for that commit goes green.',
      '',
      `Smoke run: ${runUrl}`,
      '',
      'Database: each migration is additive and works with the previous build (CLAUDE.md), so the rollback needs no database step.',
    ].join('\n'),
  };
}

export function rollbackFailedIssue({ fromSha, reason, runUrl }) {
  return {
    title: `Automatic rollback FAILED: build ${fromSha.slice(0, 7)} failed the post-release check`,
    body: [
      `The post-deploy smoke found a failure in the money test or the health check on build \`${fromSha.slice(0, 7)}\`.`,
      '',
      `The automatic rollback did not run: ${reason}`,
      '',
      'Roll back by hand now: Vercel > Deployments > the previous production deployment > **Instant Rollback** (see `docs/ROLLBACK.md`).',
      '',
      `Smoke run: ${runUrl}`,
    ].join('\n'),
  };
}

export function releaseCheckIssue({ sha, deploymentId, deploymentUrl, runUrl }) {
  return {
    title: `Release check failed: build ${sha.slice(0, 7)} is held`,
    body: [
      `The synthetic sandbox transfer failed on the held production deployment of build \`${sha.slice(0, 7)}\` (deployment \`${deploymentId || 'unknown'}\`${deploymentUrl ? `, ${deploymentUrl}` : ''}).`,
      '',
      'Vercel Deployment Checks keep this build held. Customers stay on the previous build. Nothing was rolled back.',
      '',
      'What to do:',
      '1. Open the run below and find the cause.',
      '2. Merge a fix. Its new build runs the same check.',
      '3. If the failure was in the check itself (not the build), re-run the failed job. A green re-run releases the build.',
      '',
      `Release check run: ${runUrl}`,
    ].join('\n'),
  };
}

async function openIssue({ env, fetchImpl, issue, out }) {
  const api = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !env.GITHUB_TOKEN) {
    out('::error title=Release guard::GITHUB_REPOSITORY or GITHUB_TOKEN is missing; the issue was not opened.');
    return false;
  }
  const res = await fetchImpl(`${api}/repos/${repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(issue),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    out(`::error title=Release guard::GitHub answered ${res.status} when the issue was opened.`);
    return false;
  }
  out(`Opened the issue "${issue.title}".`);
  return true;
}

/** Best effort: a missing secret or a build without the route is a warning only. */
async function sendAlert({ env, fetchImpl, payload, out }) {
  const url = env.ALERT_URL ?? 'https://smartremit.ai/api/ops/deploy-alert';
  if (!env.CRON_SECRET) {
    out('::warning title=Ops alert not sent::CRON_SECRET is not available to this job.');
    return;
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CRON_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ...(env.RUN_ID ? { runId: String(env.RUN_ID) } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) out('Ops alert queued.');
    else out(`::warning title=Ops alert not sent::${url} answered ${res.status}${res.status === 404 ? ' (the live build has no alert route yet)' : ''}.`);
  } catch {
    out(`::warning title=Ops alert not sent::${url} did not answer.`);
  }
}

/** @param {{ env: Record<string, string | undefined>, fetchImpl?: FetchLike, out?: (l: string) => void }} opts */
export async function runReleaseCheckFailed({ env, fetchImpl = fetch, out = console.log }) {
  const sha = String(env.TARGET_SHA ?? '').toLowerCase();
  if (!SHA.test(sha)) {
    out('::error title=Release guard::TARGET_SHA is not a full commit SHA.');
    return 1;
  }
  const deploymentId = DPL.test(env.DEPLOYMENT_ID ?? '') ? env.DEPLOYMENT_ID : '';
  const deploymentUrl = /^https:\/\/[a-z0-9.-]+$/i.test(env.DEPLOYMENT_URL ?? '') ? env.DEPLOYMENT_URL : '';
  const issue = releaseCheckIssue({ sha, deploymentId, deploymentUrl, runUrl: env.RUN_URL ?? '' });
  await sendAlert({ env, fetchImpl, out, payload: { kind: 'release_check_failed', sha, ...(deploymentId ? { deploymentId } : {}) } });
  return (await openIssue({ env, fetchImpl, issue, out })) ? 0 : 1;
}

/** @param {{ env: Record<string, string | undefined>, fetchImpl?: FetchLike, out?: (l: string) => void }} opts */
export async function runRollback({ env, fetchImpl = fetch, out = console.log }) {
  const failedSha = String(env.TARGET_SHA ?? '').toLowerCase();
  const runUrl = env.RUN_URL ?? '';
  const projectId = env.VERCEL_PROJECT_ID ?? '';
  const teamId = env.VERCEL_TEAM_ID ?? '';
  const token = env.VERCEL_ROLLBACK_TOKEN ?? '';

  const fail = async (reason) => {
    out(`::error title=Automatic rollback failed::${reason}`);
    if (SHA.test(failedSha)) {
      await sendAlert({ env, fetchImpl, out, payload: { kind: 'rollback_failed', fromSha: failedSha } });
      await openIssue({ env, fetchImpl, out, issue: rollbackFailedIssue({ fromSha: failedSha, reason, runUrl }) });
    }
    return 1;
  };

  if (!SHA.test(failedSha)) return fail('TARGET_SHA is not a full commit SHA.');
  if (!token) return fail('The VERCEL_ROLLBACK_TOKEN secret is not available to this job.');
  if (!/^prj_[A-Za-z0-9]+$/.test(projectId)) return fail('The VERCEL_PROJECT_ID variable is missing or malformed.');
  if (teamId && !/^team_[A-Za-z0-9]+$/.test(teamId)) return fail('The VERCEL_TEAM_ID variable is malformed.');

  const team = teamId ? `&teamId=${teamId}` : '';
  const auth = { Authorization: `Bearer ${token}` };
  let deps;
  try {
    const res = await fetchImpl(
      `${VERCEL_API}/v6/deployments?projectId=${projectId}&target=production&state=READY&limit=20${team}`,
      { headers: auth, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return fail(`Vercel answered ${res.status} to the deployment list.`);
    deps = normalizeDeployments(await res.json());
  } catch {
    return fail('The Vercel deployment list did not answer.');
  }

  const pick = pickRollbackTarget(deps, failedSha);
  if (!pick.ok) return fail(pick.reason);

  try {
    const description = encodeURIComponent(`Automatic rollback: ${failedSha.slice(0, 7)} failed the post-release check`);
    const res = await fetchImpl(
      `${VERCEL_API}/v1/projects/${projectId}/rollback/${pick.to.uid}?description=${description}${team}`,
      { method: 'POST', headers: auth, signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) return fail(`Vercel answered ${res.status} to the rollback request.`);
  } catch {
    return fail('The Vercel rollback request did not answer.');
  }

  out(`Rolled production back from ${failedSha.slice(0, 7)} (${pick.from.uid}) to ${pick.to.sha.slice(0, 7)} (${pick.to.uid}).`);
  await sendAlert({ env, fetchImpl, out, payload: { kind: 'rollback_done', fromSha: failedSha, toSha: pick.to.sha } });
  const issue = rollbackIssue({
    fromSha: failedSha, toSha: pick.to.sha, fromId: pick.from.uid, toId: pick.to.uid, runUrl, projectId,
  });
  // The rollback itself succeeded; the job still goes red so the failure is seen.
  await openIssue({ env, fetchImpl, issue, out });
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cmd = process.argv[2];
  const run = cmd === 'rollback' ? runRollback : cmd === 'release-check-failed' ? runReleaseCheckFailed : null;
  if (!run) {
    console.error('Usage: release-guard.mjs rollback | release-check-failed');
    process.exit(2);
  }
  process.exit(await run({ env: process.env }));
}
