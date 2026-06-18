import { eq, sql } from 'drizzle-orm';
import { outbox } from '@/db/schema';
import type { DbOrTx } from '@/db/client';

// outbox-repo — the durability backbone (Stage 2). Every external effect
// (WhatsApp send, settlement instruction, rail callback, mock settle, agent
// turn, ops alert) is enqueued IN THE SAME TRANSACTION as the state change
// that implies it, then drained by /api/worker:
//
//   claimBatch  — atomic claim via FOR UPDATE SKIP LOCKED (concurrent drains
//                 never double-process a row; attempts increments at claim)
//   markDone    — terminal success
//   markFailed  — exponential backoff (2^attempts s, cap 1h); at maxAttempts
//                 the row goes 'dead' (the caller enqueues the ops alert)
//
// dedupe_key (UNIQUE where not null) makes effects idempotent BY CONSTRUCTION:
// re-running a money path can never enqueue the same effect twice.

export type OutboxKind =
  | 'whatsapp.text'
  | 'whatsapp.template'
  | 'settlement.instruct'
  | 'rail.callback'
  | 'mock.settle'
  | 'funding.refund'
  | 'agent.turn'
  | 'ticket.triage'
  | 'ops.alert';

export type OutboxRow = typeof outbox.$inferSelect;

export const MAX_ATTEMPTS = 8;

export function createOutboxRepo(db: DbOrTx) {
  return {
    /**
     * Enqueue an effect. `dedupeKey` collisions are SILENT no-ops (the effect
     * is already queued/processed — exactly what a crash-replay wants).
     * Returns true when a new row was created.
     */
    async enqueue(
      kind: OutboxKind,
      payload: Record<string, unknown>,
      opts: { delayMs?: number; dedupeKey?: string } = {},
    ): Promise<boolean> {
      const rows = await db
        .insert(outbox)
        .values({
          kind,
          payload,
          nextAttemptAt: opts.delayMs ? new Date(Date.now() + opts.delayMs) : new Date(),
          dedupeKey: opts.dedupeKey ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: outbox.id });
      return rows.length > 0;
    },

    /** Atomically claim up to `limit` due rows (SKIP LOCKED — drain-safe). */
    async claimBatch(limit: number, workerId: string): Promise<OutboxRow[]> {
      const rows = await db.execute(sql`
        UPDATE outbox SET status = 'processing', locked_at = now(), locked_by = ${workerId},
                          attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox
          WHERE status IN ('pending','failed') AND next_attempt_at <= now()
          ORDER BY id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *;
      `);
      return (rows as unknown as { rows: Record<string, unknown>[] }).rows.map((r) => ({
        id: Number(r.id),
        kind: String(r.kind),
        payload: r.payload,
        status: String(r.status),
        attempts: Number(r.attempts),
        nextAttemptAt: new Date(String(r.next_attempt_at)),
        lockedAt: r.locked_at ? new Date(String(r.locked_at)) : null,
        lockedBy: (r.locked_by as string) ?? null,
        lastError: (r.last_error as string) ?? null,
        dedupeKey: (r.dedupe_key as string) ?? null,
        createdAt: new Date(String(r.created_at)),
      })) as OutboxRow[];
    },

    async markDone(id: number): Promise<void> {
      await db.update(outbox).set({ status: 'done' }).where(eq(outbox.id, id));
    },

    /**
     * Record a failure: backoff-and-retry until MAX_ATTEMPTS, then 'dead'.
     * Returns the resulting status so the worker can fire the ops alert on death.
     */
    async markFailed(id: number, attempts: number, error: string): Promise<'failed' | 'dead'> {
      const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      const backoffSec = Math.min(2 ** attempts, 3600);
      await db
        .update(outbox)
        .set({
          status,
          lastError: error.slice(0, 1000),
          nextAttemptAt: sql`now() + make_interval(secs => ${backoffSec})`,
        })
        .where(eq(outbox.id, id));
      return status;
    },

    /** Dead letters for the ops page (+ manual retry). */
    async listDead(limit = 100): Promise<OutboxRow[]> {
      return db.select().from(outbox).where(eq(outbox.status, 'dead')).limit(limit);
    },

    /** A single dead row by id (null if missing or not dead) — the ops copilot's subject resolve. */
    async getDead(id: number): Promise<OutboxRow | null> {
      const rows = await db
        .select()
        .from(outbox)
        .where(sql`${outbox.id} = ${id} AND ${outbox.status} = 'dead'`)
        .limit(1);
      return rows[0] ?? null;
    },

    /**
     * DETERMINISTIC sibling clustering for the ops copilot: how many OTHER dead
     * rows share a last_error PREFIX. Case-insensitive prefix match on the
     * already-normalized prefix the caller computed (errorPrefix in
     * ops-diagnosis-ai); `excludeId` keeps the subject row out of its own count.
     * Pure SQL — the model never counts.
     */
    async countDeadByErrorPrefix(prefix: string, excludeId: number): Promise<number> {
      if (!prefix) return 0;
      const like = `${prefix.replace(/[%_\\]/g, '\\$&')}%`;
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(outbox)
        .where(
          sql`${outbox.status} = 'dead' AND ${outbox.id} <> ${excludeId} AND lower(${outbox.lastError}) LIKE ${like}`,
        );
      return rows[0]?.n ?? 0;
    },

    /** Ops action: resurrect a dead row for another attempt cycle. */
    async retryDead(id: number): Promise<void> {
      await db
        .update(outbox)
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
        .where(sql`${outbox.id} = ${id} AND ${outbox.status} = 'dead'`);
    },

    async countPending(): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(outbox)
        .where(sql`${outbox.status} IN ('pending','failed')`);
      return rows[0]?.n ?? 0;
    },
  };
}

export type OutboxRepo = ReturnType<typeof createOutboxRepo>;
