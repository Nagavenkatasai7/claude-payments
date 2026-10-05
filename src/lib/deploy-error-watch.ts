import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { buildErrorsKey, buildSha, BUILD_ERRORS_TTL_SEC } from './build-errors';

// deploy-error-watch — Release safety Batch 2 part D. Runs in every full worker
// run on the CURRENT build:
//   1. The first run on a new build records when it was first seen and which
//      build ran before it (`buildseen:<sha>`, `buildprev:<sha>`, `build:current`).
//   2. For the first WATCH_WINDOW_MS of the new build, it compares the new
//      build's error count with what the previous build would have had in the
//      same time (its count spread over its own life). When the new count is
//      above MIN_ERRORS and above RATIO times that baseline, it raises ONE ops
//      alert (dedupe `deployerrors:<sha>`).
// Counts come from onRequestError (src/lib/build-errors.ts). Nothing here can
// stop the drain: the worker wraps it in try/catch.

export const WATCH_WINDOW_MS = 15 * 60_000;
export const MIN_ERRORS = 5;
export const RATIO = 3;

export interface WatchRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex?: number; nx?: boolean }): Promise<unknown>;
}

export type WatchResult =
  | { kind: 'no-build' }
  | { kind: 'outside-window' }
  | { kind: 'ok'; count: number; baseline: number }
  | { kind: 'alerted'; count: number; baseline: number };

const n = (v: string | null): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) && x >= 0 ? x : 0;
};

/** Pure: does this count call for an alert? `baseline` = expected errors in the window. */
export function errorSpike(count: number, baseline: number): boolean {
  return count > MIN_ERRORS && count > RATIO * baseline;
}

/**
 * The previous build's expected error count in one window: its count spread
 * evenly over its life (first seen → the new build's first seen). A previous
 * build that lived less than one window counts as it is.
 */
export function previousBaseline(prevCount: number, prevLifeMs: number): number {
  if (!(prevLifeMs > WATCH_WINDOW_MS)) return prevCount;
  return (prevCount * WATCH_WINDOW_MS) / prevLifeMs;
}

export async function deployErrorWatch(
  db: DbOrTx,
  redis: WatchRedis,
  nowMs: number = Date.now(),
  commitSha: string | undefined = process.env.VERCEL_GIT_COMMIT_SHA,
): Promise<WatchResult> {
  const sha = buildSha(commitSha);
  if (!sha) return { kind: 'no-build' };
  const ttl = { ex: BUILD_ERRORS_TTL_SEC };

  // First run on this build: record first-seen and the build before it.
  // `build:current` follows the build the worker runs on (a rollback moves it
  // back), so the next new build compares with the build it replaced.
  const first = await redis.set(`buildseen:${sha}`, String(nowMs), { ...ttl, nx: true });
  const before = await redis.get('build:current');
  if (first !== null && first !== undefined && first !== false && before && before !== sha) {
    await redis.set(`buildprev:${sha}`, before, ttl);
  }
  if (before !== sha) await redis.set('build:current', sha, ttl);
  const seenAt = n(await redis.get(`buildseen:${sha}`)) || nowMs;
  if (nowMs - seenAt > WATCH_WINDOW_MS) return { kind: 'outside-window' };

  const count = n(await redis.get(buildErrorsKey(sha)));
  const prev = await redis.get(`buildprev:${sha}`);
  let baseline = 0;
  if (prev && /^[0-9a-f]{7}$/.test(prev)) {
    const prevCount = n(await redis.get(buildErrorsKey(prev)));
    const prevSeen = n(await redis.get(`buildseen:${prev}`));
    baseline = previousBaseline(prevCount, prevSeen > 0 ? seenAt - prevSeen : 0);
  }
  if (!errorSpike(count, baseline)) return { kind: 'ok', count, baseline };

  await createOutboxRepo(db).enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit release: build ${sha} has ${count} server errors in its first ${Math.round(WATCH_WINDOW_MS / 60_000)} minutes ` +
        `(previous build${prev ? ` ${prev}` : ''}: about ${baseline.toFixed(1)} in the same time). ` +
        'Check Sentry for this release. To undo it: Vercel Instant Rollback (docs/ROLLBACK.md).',
    },
    { dedupeKey: `deployerrors:${sha}` },
  );
  return { kind: 'alerted', count, baseline };
}

/** This build's error count for the Bearer /api/health body (null when unknown). */
export async function currentBuildErrors(
  redis: Pick<WatchRedis, 'get'>,
  commitSha: string | undefined = process.env.VERCEL_GIT_COMMIT_SHA,
): Promise<number | null> {
  const sha = buildSha(commitSha);
  if (!sha) return null;
  try {
    return n(await redis.get(buildErrorsKey(sha)));
  } catch {
    return null;
  }
}
