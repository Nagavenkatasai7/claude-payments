import { after } from 'next/server';
import { env } from './env';

// outbox — enqueue-side helpers. The repo-level enqueue lives in
// db/repos/outbox-repo (transaction-aware); this module adds the WORKER POKE:
// a best-effort, fire-and-forget nudge of /api/worker right after a response,
// so the common case drains in seconds. The GitHub Actions 5-minute heartbeat
// is the GUARANTEE; the poke is only the fast path — its loss costs latency,
// never correctness.

async function fetchWorker(): Promise<void> {
  try {
    await fetch(`${env.appBaseUrl}/api/worker`, {
      method: 'POST',
      headers: env.cronSecret
        ? { authorization: `Bearer ${env.cronSecret}` }
        : {},
    });
  } catch {
    /* best effort — the heartbeat will drain */
  }
}

export function pokeWorker(): void {
  try {
    after(fetchWorker);
  } catch {
    /* after() unavailable (tests / non-request context) — heartbeat covers it */
  }
}

/**
 * Best-effort DELAYED poke: nudge /api/worker after `delayMs`, post-response.
 * For effects enqueued with a future runAt (the mock rail's simulated delivery
 * delay) — the immediate poke drains only READY rows, so without this the row
 * waits for the next 5-minute heartbeat. Same contract as pokeWorker: fire and
 * forget, never throws, never blocks the response; the heartbeat is still the
 * delivery GUARANTEE.
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
