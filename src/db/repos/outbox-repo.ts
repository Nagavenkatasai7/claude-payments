import { and, eq, inArray, sql } from 'drizzle-orm';
import { outbox } from '@/db/schema';
import type { DbOrTx } from '@/db/client';

// outbox-repo — the durability backbone (Stage 2). Every external effect
// (WhatsApp send, settlement instruction, rail callback, mock settle, agent
// turn, ops alert) is enqueued IN THE SAME TRANSACTION as the state change
// that implies it, then drained by /api/worker:
//
//   claimBatch  — atomic claim via FOR UPDATE SKIP LOCKED (concurrent drains
//                 never double-process a row; attempts increments at claim);
//                 also RECLAIMS 'processing' rows whose lease expired (owner
//                 died mid-row); attempts increments either way
//   markDone    — terminal success
//   markDone/markFailed — compare-and-set on lease_owner when the caller
//                 passes one (a worker that lost its lease cannot clobber)
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
  | 'ops.alert'
  | 'email.send';

export type OutboxRow = typeof outbox.$inferSelect;

export const MAX_ATTEMPTS = 8;
/**
 * Lease length for a claimed row. 5× the worker's hard ceiling (maxDuration =
 * 60 at src/app/api/worker/route.ts:27): a worker that is still legally
 * running can NEVER have its row stolen. A row whose lease has expired was
 * abandoned (function killed mid-row) and is reclaimed by the next claimBatch —
 * attempts++ as on any retry, so a poison row still dies at MAX_ATTEMPTS.
 */
export const LEASE_MS = 5 * 60_000;

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

    /**
     * Atomically claim up to `limit` rows (SKIP LOCKED — drain-safe):
     *   • due rows ('pending'/'failed' with next_attempt_at <= now()), and
     *   • ABANDONED rows ('processing' whose lease_until has passed).
     * Both paths charge one attempt and take a fresh lease for `workerId`.
     */
    async claimBatch(limit: number, workerId: string, leaseMs = LEASE_MS): Promise<OutboxRow[]> {
      const leaseSec = Math.ceil(leaseMs / 1000);
      const rows = await db.execute(sql`
        UPDATE outbox SET status = 'processing', locked_at = now(), locked_by = ${workerId},
                          lease_until = now() + make_interval(secs => ${leaseSec}),
                          lease_owner = ${workerId},
                          attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM outbox
          WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
             OR (status = 'processing' AND lease_until < now())
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
        leaseUntil: r.lease_until ? new Date(String(r.lease_until)) : null,
        leaseOwner: (r.lease_owner as string) ?? null,
        lastError: (r.last_error as string) ?? null,
        dedupeKey: (r.dedupe_key as string) ?? null,
        createdAt: new Date(String(r.created_at)),
      })) as OutboxRow[];
    },

    /**
     * Terminal success. With `owner`, compare-and-set on lease_owner: a worker
     * whose lease was reclaimed gets `false` and must NOT treat the row as its
     * own. Without `owner` (staff dismiss of a dead row) it is unconditional.
     */
    async markDone(id: number, owner?: string): Promise<boolean> {
      const rows = await db
        .update(outbox)
        .set({ status: 'done', leaseUntil: null, leaseOwner: null })
        .where(owner === undefined ? eq(outbox.id, id) : and(eq(outbox.id, id), eq(outbox.leaseOwner, owner)))
        .returning({ id: outbox.id });
      return rows.length > 0;
    },

    /**
     * Record a failure: backoff-and-retry until MAX_ATTEMPTS, then 'dead'.
     * Returns the resulting status so the worker can fire the ops alert on
     * death — or 'lost' when `owner` no longer holds the lease (the new owner's
     * outcome wins; nothing was written).
     */
    async markFailed(
      id: number,
      attempts: number,
      error: string,
      owner?: string,
    ): Promise<'failed' | 'dead' | 'lost'> {
      const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      const backoffSec = Math.min(2 ** attempts, 3600);
      const rows = await db
        .update(outbox)
        .set({
          status,
          lastError: error.slice(0, 1000),
          nextAttemptAt: sql`now() + make_interval(secs => ${backoffSec})`,
          leaseUntil: null,
          leaseOwner: null,
        })
        .where(owner === undefined ? eq(outbox.id, id) : and(eq(outbox.id, id), eq(outbox.leaseOwner, owner)))
        .returning({ id: outbox.id });
      return rows.length > 0 ? status : 'lost';
    },

    /**
     * OWNER-ONLY: hand back rows this worker claimed but never STARTED (the
     * invocation's start cutoff passed first). The claim's attempt is refunded
     * because the row never ran — this is not a retry. NOTE on reclaims: a row
     * whose claim in THIS batch was a reclaim of an expired lease (its previous
     * owner died mid-row) and that is then released unstarted also gets that
     * reclaim's charge refunded — by design: only GENUINE runs count toward
     * MAX_ATTEMPTS, and this worker never ran it either. The row keeps the
     * attempt its dead owner charged, so a poison row still converges on
     * MAX_ATTEMPTS through real runs. (Task 8's `reclaimed` flag lets a later
     * change exclude reclaimed rows from the refund if that ever proves
     * necessary; it is not required for correctness.)
     */
    async releaseUnstarted(ids: number[], owner: string): Promise<number> {
      if (ids.length === 0) return 0;
      const rows = await db
        .update(outbox)
        .set({
          status: 'pending',
          attempts: sql`greatest(${outbox.attempts} - 1, 0)`,
          leaseUntil: null,
          leaseOwner: null,
          lockedAt: null,
          lockedBy: null,
        })
        .where(and(inArray(outbox.id, ids), eq(outbox.status, 'processing'), eq(outbox.leaseOwner, owner)))
        .returning({ id: outbox.id });
      return rows.length;
    },

    /**
     * 'processing' rows whose lease expired more than `minutes` ago and were
     * STILL not reclaimed. The reclaim lives in claimBatch, so an expired lease
     * normally disappears within one drain; one that survives this long means
     * the drain itself is not running. Ids/kinds/timestamps only — callers must
     * never print `payload` (it may carry creds until fix 11).
     */
    async listStaleProcessing(minutes: number, limit = 100): Promise<OutboxRow[]> {
      return db
        .select()
        .from(outbox)
        .where(
          sql`${outbox.status} = 'processing' AND ${outbox.leaseUntil} < now() - make_interval(mins => ${minutes})`,
        )
        .orderBy(outbox.leaseUntil)
        .limit(limit);
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
        .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null, leaseUntil: null, leaseOwner: null })
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
