import { after } from 'next/server';
import { env } from './env';
import { gateRedis, markDue } from './worker-gate';

// outbox — enqueue-side helpers. The repo-level enqueue lives in
// db/repos/outbox-repo (transaction-aware); this module adds the WORKER POKE:
// a best-effort, fire-and-forget nudge of /api/worker right after a response,
// so the common case drains in seconds. The Vercel per-minute cron is the
// clock (vercel.json) and the hourly GitHub heartbeat backs it up; the poke is
// only the fast path — its loss costs latency, never correctness.
//
// partner-demo R4: each poke also MARKS the work due in the worker gate's
// Redis set (src/lib/worker-gate.ts) so a cron tick wakes Neon for it even if
// the poke itself is lost. The mark lives here, post-commit, and NOT in
// outbox-repo.enqueue: enqueue runs inside money transactions, and an Upstash
// round trip there would lengthen lock hold. A producer that never pokes is
// picked up by the :17/:47 backstop (≤ 30 min).

/**
 * A hung poke would keep the poking function's after() alive for the whole
 * function ceiling. /api/worker never reads req.signal, so aborting the poke
 * frees THIS function without stopping the drain it triggered.
 */
export const POKE_TIMEOUT_MS = 10_000;

async function fetchWorker(): Promise<void> {
  try {
    await fetch(`${env.appBaseUrl}/api/worker`, {
      method: 'POST',
      headers: env.cronSecret
        ? { authorization: `Bearer ${env.cronSecret}` }
        : {},
      signal: AbortSignal.timeout(POKE_TIMEOUT_MS),
    });
  } catch {
    /* best effort (including a timeout) — the per-minute cron will drain */
  }
}

/** Best effort: never throws (a missing KV env or a Redis error only loses the mark). */
async function markDueSafely(atMs: number): Promise<void> {
  try {
    await markDue(gateRedis(), atMs);
  } catch {
    /* fail-open — the backstop covers a lost mark */
  }
}

export function pokeWorker(): void {
  try {
    after(async () => {
      // Both start at once: the mark never delays the poke.
      await Promise.allSettled([markDueSafely(Date.now()), fetchWorker()]);
    });
  } catch {
    /* after() unavailable (tests / non-request context) — the cron covers it */
  }
}

/**
 * Best-effort DELAYED poke: nudge /api/worker after `delayMs`, post-response.
 * For effects enqueued with a future runAt (the mock rail's simulated delivery
 * delay) — the immediate poke drains only READY rows, so without this the row
 * waits for the next cron tick (about a minute). Same contract as pokeWorker:
 * fire and forget, never throws, never blocks the response; the per-minute
 * cron still drains it.
 */
export function pokeWorkerDelayed(delayMs: number): void {
  try {
    after(async () => {
      // Marked BEFORE the sleep: if this after() is cut short, the cron still
      // wakes the worker when the delayed row becomes due.
      const mark = markDueSafely(Date.now() + delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await Promise.allSettled([mark, fetchWorker()]);
    });
  } catch {
    /* after() unavailable (tests / non-request context) — heartbeat covers it */
  }
}
