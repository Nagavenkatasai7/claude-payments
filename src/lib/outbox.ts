import { after } from 'next/server';
import { env } from './env';

// outbox — enqueue-side helpers. The repo-level enqueue lives in
// db/repos/outbox-repo (transaction-aware); this module adds the WORKER POKE:
// a best-effort, fire-and-forget nudge of /api/worker right after a response,
// so the common case drains in seconds. The Vercel per-minute cron is the
// clock (vercel.json) and the hourly GitHub heartbeat backs it up; the poke is
// only the fast path — its loss costs latency, never correctness.

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

export function pokeWorker(): void {
  try {
    after(fetchWorker);
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
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await fetchWorker();
    });
  } catch {
    /* after() unavailable (tests / non-request context) — heartbeat covers it */
  }
}
