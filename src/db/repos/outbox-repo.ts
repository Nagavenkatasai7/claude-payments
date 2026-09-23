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

// Keys that only a secret-bearing shape carries: WaCreds ({ phoneNumberId, token }),
// the PartnerIntegrations sub-configs (apiKey, webhookSecret, credentials,
// verifyToken, appSecret) and the pre-fix-11 `creds` envelope.
const SECRET_SHAPE_KEYS: ReadonlySet<string> = new Set([
  'creds', 'token', 'verifytoken', 'appsecret', 'apikey', 'webhooksecret',
  'credentials', 'signingsecret', 'secret', 'password',
]);

/**
 * Paths (never values) at which `value` carries a secret-bearing shape: a
 * secret-named key anywhere, or a { kyc, payment, whatsapp } PartnerIntegrations
 * object. Pure; used by enqueue's test-only tripwire (fix 11).
 */
export function secretShapePaths(value: unknown, path = '$', depth = 0, out: string[] = []): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => secretShapePaths(v, `${path}[${i}]`, depth + 1, out));
    return out;
  }
  const obj = value as Record<string, unknown>;
  if ('kyc' in obj && 'payment' in obj && 'whatsapp' in obj) out.push(`${path} (PartnerIntegrations shape)`);
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_SHAPE_KEYS.has(k.toLowerCase())) out.push(`${path}.${k}`);
    secretShapePaths(v, `${path}.${k}`, depth + 1, out);
  }
  return out;
}

export const MAX_ATTEMPTS = 8;
/**
 * Lease length for a claimed row. 5× the worker's hard ceiling (maxDuration =
 * 60 at src/app/api/worker/route.ts:27): a worker that is still legally
 * running can NEVER have its row stolen. A row whose lease has expired was
 * abandoned (function killed mid-row) and is reclaimed by the next claimBatch —
 * attempts++ as on any retry, so a poison row still dies at MAX_ATTEMPTS.
 */
export const LEASE_MS = 5 * 60_000;
const LEASE_SEC = LEASE_MS / 1000;

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
      // TEST-ONLY tripwire (fix 11): a payload must never carry a secret-bearing
      // shape — creds resolve at drain time, capabilities are sealed. Under
      // vitest every producer the suite exercises is checked at runtime; in
      // production this is a no-op (a new throw inside money transactions is not
      // worth it — tests/outbox-payload-secrets.test.ts is the build gate).
      if (process.env.VITEST) {
        const paths = secretShapePaths(payload);
        if (paths.length > 0) {
          throw new Error(`outbox payload for ${kind} carries a secret-bearing shape at ${paths.join(', ')} (fix 11)`);
        }
      }
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
     *   • ABANDONED rows ('processing' whose lease_until has passed). A row
     *     claimed by PRE-lease code has lease_until NULL; its implied lease is
     *     locked_at + LEASE_MS, so the migrate→deploy window needs no backfill.
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
             OR (status = 'processing' AND coalesce(lease_until, locked_at + make_interval(secs => ${LEASE_SEC})) < now())
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
     *
     * `minBackoffSec` floors the retry delay. The worker passes LEASE_MS/1000 on
     * a row-deadline failure: the abandoned handler may still be running inside
     * the live invocation (up to maxDuration), so the row must not become
     * claimable by another worker before that invocation is certainly gone.
     */
    async markFailed(
      id: number,
      attempts: number,
      error: string,
      owner?: string,
      opts: { minBackoffSec?: number } = {},
    ): Promise<'failed' | 'dead' | 'lost'> {
      const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
      const backoffSec = Math.max(Math.min(2 ** attempts, 3600), opts.minBackoffSec ?? 0);
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
     * never print `payload` (message bodies are customer-facing text; sealed
     * email values are ciphertext — fix 11 keeps secrets out, not PII).
     */
    async listStaleProcessing(minutes: number, limit = 100): Promise<OutboxRow[]> {
      return db
        .select()
        .from(outbox)
        .where(
          sql`${outbox.status} = 'processing' AND coalesce(${outbox.leaseUntil}, ${outbox.lockedAt} + make_interval(secs => ${LEASE_SEC})) < now() - make_interval(mins => ${minutes})`,
        )
        .orderBy(sql`coalesce(${outbox.leaseUntil}, ${outbox.lockedAt} + make_interval(secs => ${LEASE_SEC}))`)
        .limit(limit);
    },

    /**
     * fix 11: rows that still HOLD a secret a pre-fix release copied into the
     * payload — an object `creds` (WhatsApp bearer token) or a cleartext
     * partner-application link on an unsealed invite. COUNTS by kind/status
     * only; no payload is ever selected. The drizzle 0016 runbook gate
     * (scripts/outbox-status.ts "SECRETS AT REST"): before /migrate-prod every
     * row here must be done/dead; after the apply this must be empty. Tests a
     * VALUE, not a key: `"creds": null` holds nothing and is not counted
     * (jsonb_typeof, same predicates as drizzle/0016_scrub_outbox_secrets.sql).
     */
    async listSecretsAtRest(): Promise<Array<{ kind: string; status: string; n: number }>> {
      return db
        .select({ kind: outbox.kind, status: outbox.status, n: sql<number>`count(*)::int`.mapWith(Number) })
        .from(outbox)
        .where(
          sql`jsonb_typeof(${outbox.payload} -> 'creds') = 'object'
            OR (${outbox.kind} = 'email.send'
                AND starts_with(${outbox.dedupeKey}, 'partner_app_invite:')
                AND jsonb_typeof(${outbox.payload} -> 'sealed') IS DISTINCT FROM 'object'
                AND ${outbox.payload} ->> 'text' LIKE '%/partners/apply/%')`,
        )
        .groupBy(outbox.kind, outbox.status)
        .orderBy(outbox.kind, outbox.status);
    },

    /**
     * Program-Fix 37 (ctx-03): payload retention. Empties the payload of up to
     * `limit` 'done' rows created more than `olderThanDays` days ago (their
     * payloads are plaintext copies of what was sent: bodies, phones, names).
     * ONLY the payload changes: id, kind, status, attempts, dedupe_key and the
     * timestamps stay, so a redelivered key still dedupes and every ladder
     * keyed on dedupe_key still sees its row. Never deletes a row, and never
     * touches pending/failed/processing/dead (ops Retry needs a dead payload).
     * Returns how many rows were emptied (RETURNING, not rowCount: the drivers
     * disagree on that field).
     */
    async scrubDonePayloads(olderThanDays: number, limit = 1000): Promise<number> {
      const res = await db.execute(sql`
        UPDATE outbox SET payload = '{}'::jsonb
        WHERE id IN (
          SELECT id FROM outbox
          WHERE status = 'done'
            AND created_at < now() - make_interval(days => ${olderThanDays})
            AND payload <> '{}'::jsonb
          ORDER BY id
          LIMIT ${limit}
        )
        RETURNING id
      `);
      return (res as unknown as { rows: unknown[] }).rows.length;
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

    /**
     * What the NEXT drain would claim (Program-Fix 12 / Task 8): due
     * 'pending'/'failed' rows PLUS 'processing' rows whose lease has expired —
     * the same predicate and the same `coalesce(lease_until, locked_at + LEASE)`
     * expression as claimBatch, so the drain-gap alarm and the claim can never
     * disagree. `oldestDueAt` is the instant the oldest row became claimable
     * (next_attempt_at, or the lease expiry for an abandoned row); null when
     * nothing is due. Counts and timestamps only — no payload is selected.
     */
    async dueSummary(): Promise<{ dueNow: number; oldestDueAt: Date | null }> {
      const rows = await db.execute(sql`
        SELECT count(*)::int AS due_now,
               min(CASE WHEN status IN ('pending','failed') THEN next_attempt_at
                        ELSE coalesce(lease_until, locked_at + make_interval(secs => ${LEASE_SEC})) END) AS oldest_due_at
        FROM outbox
        WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
           OR (status = 'processing' AND coalesce(lease_until, locked_at + make_interval(secs => ${LEASE_SEC})) < now())
      `);
      const r = (rows as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};
      return {
        dueNow: Number(r.due_now ?? 0),
        oldestDueAt: r.oldest_due_at ? new Date(String(r.oldest_due_at)) : null,
      };
    },
  };
}

export type OutboxRepo = ReturnType<typeof createOutboxRepo>;
