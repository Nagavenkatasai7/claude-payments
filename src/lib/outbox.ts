import { after } from 'next/server';
import { env } from './env';

// outbox — enqueue-side helpers. The repo-level enqueue lives in
// db/repos/outbox-repo (transaction-aware); this module adds the WORKER POKE:
// a best-effort, fire-and-forget nudge of /api/worker right after a response,
// so the common case drains in seconds. The GitHub Actions 5-minute heartbeat
// is the GUARANTEE; the poke is only the fast path — its loss costs latency,
// never correctness.

export function pokeWorker(): void {
  try {
    after(async () => {
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
    });
  } catch {
    /* after() unavailable (tests / non-request context) — heartbeat covers it */
  }
}
