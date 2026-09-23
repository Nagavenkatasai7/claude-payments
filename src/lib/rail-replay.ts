import { getRedis } from './redis';
import { logWarn } from './log';
import type { RedisLike } from './store';
import { RAIL_SIG_TOLERANCE_SEC } from './providers/rail-signature';

// rail-replay — the replay guard for v2 rail signatures (Program-Fix 29).
//
// CHECK-THEN-MARK: the route GETs `railsig:<nonce>` before handling and SETs it
// only after the handling succeeded. A handler throw (or a kill mid-handler)
// therefore leaves no mark and the rail's retry still lands. Two concurrent
// duplicates may both run — every downstream effect is idempotent (the
// forward-only state machine, the railcb:/railconflict:/railamount: dedupe
// keys, the handleRailFailure row claim).
//
// FAIL-OPEN: Upstash is hot/ephemeral only. A Redis error or a stall past the
// deadline is 'unavailable' and the request proceeds — the ±5 min signature
// window is still enforced without Redis, and failing closed would stall every
// delivery during an Upstash outage.

/** TTL of a mark: comfortably more than the whole ±window (2 × 300 s). */
export const RAIL_NONCE_TTL_SEC = 3 * RAIL_SIG_TOLERANCE_SEC;
const DEADLINE_MS = 1_000;

export type NonceState = 'seen' | 'fresh' | 'unavailable';

const TIMEOUT = Symbol('timeout');

async function withDeadline<T>(work: () => Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    // Promise.race subscribes to both; a late rejection of the loser is absorbed.
    return await Promise.race([work(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function railNonceSeen(
  nonce: string,
  redis?: RedisLike,
  deadlineMs = DEADLINE_MS,
): Promise<NonceState> {
  try {
    const r = await withDeadline(() => (redis ?? getRedis()).get(`railsig:${nonce}`), deadlineMs);
    if (r === TIMEOUT) {
      logWarn('rail-replay.unavailable', 'nonce check timed out; proceeding (fail-open)');
      return 'unavailable';
    }
    return r === null ? 'fresh' : 'seen';
  } catch (err) {
    logWarn('rail-replay.unavailable', err);
    return 'unavailable';
  }
}

/** Best-effort; never throws (a failed mark must not fail a handled request). */
export async function markRailNonce(
  nonce: string,
  redis?: RedisLike,
  deadlineMs = DEADLINE_MS,
): Promise<void> {
  try {
    const r = await withDeadline(
      () => (redis ?? getRedis()).set(`railsig:${nonce}`, '1', { ex: RAIL_NONCE_TTL_SEC }),
      deadlineMs,
    );
    if (r === TIMEOUT) logWarn('rail-replay.mark_failed', 'nonce mark timed out');
  } catch (err) {
    logWarn('rail-replay.mark_failed', err);
  }
}
