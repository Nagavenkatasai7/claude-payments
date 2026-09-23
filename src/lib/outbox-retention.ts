import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';

// outbox-retention (Program-Fix 37, ctx-03): the daily /api/cron sweep that
// empties the payload of 'done' outbox rows older than the retention window.
// Only the payload goes; the row (and its dedupe_key) stays forever.
//
// Readers that stay safe with a 7-day window:
//  - reconcile.ts (stuck refund) reads funding.refund payloads under 60 min old;
//  - ops-diagnose reads DEAD rows only, and dead rows are never scrubbed;
//  - listSecretsAtRest (the fix-11 gate) keeps working: {} holds no secret.
// A dead row retried after 7 days that then succeeds is 'done' with an old
// created_at, so the next cron run empties it.

/** Owner decision (Phase 2, decision 8): 7 days. */
export const OUTBOX_PAYLOAD_RETENTION_DAYS = 7;

/**
 * Loop scrubDonePayloads in batches until a short batch or until `budgetMs`
 * has passed (checked before each batch), so a large first run cannot eat
 * the cron function's time. Returns the total rows emptied.
 */
export async function scrubOldOutboxPayloads(
  db: DbOrTx,
  opts: { days?: number; batch?: number; budgetMs?: number; now?: () => number } = {},
): Promise<number> {
  const days = opts.days ?? OUTBOX_PAYLOAD_RETENTION_DAYS;
  const batch = opts.batch ?? 1000;
  const budgetMs = opts.budgetMs ?? 20_000;
  const now = opts.now ?? Date.now;
  const repo = createOutboxRepo(db);
  const deadline = now() + budgetMs;
  let total = 0;
  for (;;) {
    const n = await repo.scrubDonePayloads(days, batch);
    total += n;
    if (n < batch || now() >= deadline) return total;
  }
}
