// build-errors — the per-build server error counter (Release safety Batch 2
// part D). EDGE-SAFE: no Node import, no Redis client. onRequestError
// (src/instrumentation.ts) adds 1 to `builderr:<sha7>` through the Upstash REST
// pipeline with one bounded fetch; the worker's deploy error watch
// (src/lib/deploy-error-watch.ts) and the Bearer /api/health read it.
//
// Never throws and never delays an error report by more than COUNT_TIMEOUT_MS:
// a Redis failure only loses one count. Only the SHA is in the key; nothing
// from the request or the error is stored.

export const BUILD_ERRORS_TTL_SEC = 7 * 24 * 3600;
export const COUNT_TIMEOUT_MS = 1_000;

const SHA7 = /^[0-9a-f]{7}$/;

/** The short SHA of a full commit SHA, or null (local builds, previews without git). */
export function buildSha(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(s) ? s.slice(0, 7) : null;
}

export function buildErrorsKey(sha7: string): string {
  if (!SHA7.test(sha7)) throw new Error('build-errors: bad sha');
  return `builderr:${sha7}`;
}

type Env = Record<string, string | undefined>;

/** Add one error to this build's counter. Never throws. Returns whether the count was written. */
export async function countBuildError(env: Env = process.env, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const sha = buildSha(env.VERCEL_GIT_COMMIT_SHA);
    const url = env.KV_REST_API_URL;
    const token = env.KV_REST_API_TOKEN;
    if (!sha || !url || !token || !url.startsWith('https://')) return false;
    const key = buildErrorsKey(sha);
    const res = await fetchFn(`${url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(BUILD_ERRORS_TTL_SEC)],
      ]),
      signal: AbortSignal.timeout(COUNT_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
