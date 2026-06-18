import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { pokeWorker } from '@/lib/outbox';

// ticket-triage — the enqueue-side helper for AI auto-triage (U2). A freshly
// created CUSTOMER ticket lands category=null/priority='normal'; rather than run
// the synchronous Ollama call inline (which would block the customer-facing
// redirect), every creation site enqueues ONE durable 'ticket.triage' outbox
// row. The worker (src/lib/outbox-worker.ts) drains it out-of-band: load the
// ticket + its first message → triageSuggest → setTriage → audit. A model/Ollama
// outage just leaves the ticket un-triaged (the worker's retry/backoff/dead-letter
// handles it like any other kind); staff hand-sort in the meantime.
//
// dedupeKey `triage:${ticketId}` makes the effect idempotent BY CONSTRUCTION —
// a double-enqueue (crash-replay, retried action) never queues it twice.

/**
 * Enqueue an out-of-band AI triage for a customer ticket, then poke the worker
 * for the fast path. ONLY ever called for kind 'customer' tickets. The enqueue
 * shares the caller's transaction when a tx is passed; the poke is a best-effort,
 * fire-and-forget nudge (the heartbeat is the delivery guarantee).
 */
export async function enqueueTriage(db: DbOrTx, ticketId: string): Promise<void> {
  await createOutboxRepo(db).enqueue(
    'ticket.triage',
    { ticketId },
    { dedupeKey: `triage:${ticketId}` },
  );
  pokeWorker();
}
