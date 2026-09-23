import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { env } from '@/lib/env';
import { logWarn } from '@/lib/log';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { cluster, firstTransfer, structuring, type AmlHit, type AmlRuleConfig } from '@/lib/aml-rules';
import { destinationBidx, senderBidx } from '@/lib/aml-bidx';
import type { Partner, PartnerId, Transfer } from '@/lib/types';

// aml-sweep — Program-Fix 43 (PR A): behavioural AML monitoring as a worker
// sweep beside reconcileSweep (/api/worker). Owner decision (binding): the
// rules raise ALERTS and REVIEW ITEMS only — a hit never changes a transfer
// (no complianceStatus / complianceReasons write, so no hold), and alerts never
// reach the customer, the bot or the partner API.
//
// Why a sweep (not inline in transfer-create, not a new outbox kind): inline
// would put I/O inside the locked mint; a new outbox kind would be thrown as
// `Unknown outbox kind` by an old build during the rolling-release overlap. The
// sweep adds zero latency to transfer create and reuses the existing ops.alert
// kind, whose handler sends `p.message` only.
//
// Per poke:
//   • aml:lock (SET NX EX 55) — a concurrent poke skips; released only if this
//     sweep still owns it (compare the value, then delete).
//   • aml:cursor — `<createdAt ISO>|<id>`, forward-only (written only when it
//     is greater than the stored value); missing ⇒ look back 24 h.
//   • rows with created_at < now − 2 min only (commit-lag guard: a slow mint
//     transaction that commits late is caught on a later poke, never skipped).
//   • ≤ 200 rows and a wall-clock budget: the sweep runs BEFORE the outbox
//     drain in the same invocation, so it must not eat the drain's window.
//
// Per row (blocked rows are skipped — the sanctions path owns them):
//   R1 structuring and R2a first-ever send — ledger aggregates (tenant-keyed).
//   R2b first send to a new destination — per-sender Redis set of destination
//       blind indexes, aml:sd:<partner>:<senderBidx> (90-day TTL). When the set
//       does not exist yet (first deploy, Redis flush, TTL lapse) it is SEEDED
//       without alerting.
//   R3 beneficiary clustering — per-partner ZSET aml:dst:<partner>:<destBidx>,
//       member = sender blind index, score = the transfer's createdAt ms:
//       ZADD GT → ZREMRANGEBYSCORE (older than 30 days) → ZCARD → rank-trim to
//       2× the threshold → EXPIRE 31 d. One alert per destination per month.
// The destination is decrypted in memory, here only, and only its keyed HMAC
// (aml-bidx.ts) leaves; nothing plaintext is logged or stored.
//
// Each hit, in ONE transaction: outbox.enqueue('ops.alert', {message}) with a
// dedupe key, and the `aml.alert` audit row ONLY when that enqueue was new —
// so a re-scan after a lost cursor re-raises nothing. The per-sender set is
// written AFTER the alert commits, so a failed commit is retried, not lost.
//
// Redis down: the first failure marks Redis down for the rest of the sweep
// (fail-open, like ip-rate-limit.ts); R1 + R2a still run from the ledger
// (look-back from 24 h, no lock — alerts are deduped anyway), R2b + R3 skip.

export const AML_LOCK_KEY = 'aml:lock';
export const AML_CURSOR_KEY = 'aml:cursor';
const LOCK_TTL_S = 55;
const LOOKBACK_MS = 24 * 3_600_000;
const COMMIT_LAG_MS = 2 * 60_000;
const BATCH = 200;
const DEFAULT_BUDGET_MS = 5_000;
const DAY_MS = 86_400_000;
const CLUSTER_WINDOW_MS = 30 * DAY_MS;
const DEST_SET_TTL_S = 90 * 86_400;
const DEST_ZSET_TTL_S = 31 * 86_400;
const REDIS_TIMEOUT_MS = 2_000;

/**
 * The Upstash commands the sweep uses, with the SDK's real shapes
 * (@upstash/redis 1.38.1, node_modules/@upstash/redis/error-8y4qG0W2.d.ts:
 * exists :4257, set :4636 (SetCommandOptions nx/ex), sismember :4668,
 * zadd :4800 ([key, ZAddCommandOptions {gt}, ScoreMember]), zcard :4804,
 * zremrangebyrank :4860, zremrangebyscore :4864 (min/max number | "(n" | "-inf")).
 */
export interface AmlRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { nx?: boolean; ex?: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  exists(key: string): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
  sadd(key: string, member: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  zadd(key: string, opts: { gt: true }, scoreMember: { score: number; member: string }): Promise<number | null>;
  zremrangebyscore(key: string, min: number | '-inf', max: number | `(${number}`): Promise<number>;
  zremrangebyrank(key: string, start: number, stop: number): Promise<number>;
  zcard(key: string): Promise<number>;
}

let cached: AmlRedis | null = null;
/**
 * The sweep's own client — the cadenceRedis() recipe (worker-cadence.ts):
 * `retry: false` (at most two fetches, no backoff) and a function-form 2 s
 * AbortSignal, so an Upstash outage costs one bounded failure per sweep instead
 * of getRedis()'s default retries on every row.
 */
export function amlRedis(): AmlRedis {
  if (!cached) {
    cached = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
      retry: false,
      signal: () => AbortSignal.timeout(REDIS_TIMEOUT_MS),
    }) as unknown as AmlRedis;
  }
  return cached;
}

export interface AmlSweepOptions {
  now?: Date;
  budgetMs?: number;
  batch?: number;
  bidxKey?: Buffer;
  clock?: () => number;
}

export interface AmlSweepResult {
  scanned: number;
  alerts: number;
  skipped: 'locked' | null;
  redis: 'ok' | 'down';
}

type Cursor = { at: Date; id: string };

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  const sep = raw.lastIndexOf('|');
  if (sep < 0) return null;
  const at = new Date(raw.slice(0, sep));
  if (isNaN(at.getTime())) return null;
  return { at, id: raw.slice(sep + 1) };
}

function cursorAfter(a: Cursor, b: Cursor): boolean {
  const d = a.at.getTime() - b.at.getTime();
  return d > 0 || (d === 0 && a.id > b.id);
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7); // yyyy-mm (UTC)

export async function amlSweep(db: Db, redis: AmlRedis, opts: AmlSweepOptions = {}): Promise<AmlSweepResult> {
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const result: AmlSweepResult = { scanned: 0, alerts: 0, skipped: null, redis: 'ok' };

  let redisUp = true;
  const markDown = (where: string) => {
    if (redisUp) logWarn('aml.sweep', 'redis unavailable — clustering and new-destination checks skipped', { where });
    redisUp = false;
    result.redis = 'down';
  };

  // ── lock ──
  const token = randomUUID();
  let ownLock = false;
  try {
    const got = await redis.set(AML_LOCK_KEY, token, { nx: true, ex: LOCK_TTL_S });
    if (got === null) return { ...result, skipped: 'locked' };
    ownLock = true;
  } catch {
    markDown('lock');
  }

  try {
    // ── cursor ──
    let stored: Cursor | null = null;
    if (redisUp) {
      try {
        stored = parseCursor(await redis.get(AML_CURSOR_KEY));
      } catch {
        markDown('cursor');
      }
    }
    const from: Cursor = stored ?? { at: new Date(now.getTime() - LOOKBACK_MS), id: '' };
    const repo = createTransferRepo(db);
    const rows = await repo.listCreatedSince(from, new Date(now.getTime() - COMMIT_LAG_MS), opts.batch ?? BATCH);

    const partners = new Map<PartnerId, Partner | null>();
    const partnerRepo = createPartnerRepo(db);
    let last: Cursor | null = null;

    for (const t of rows) {
      if (clock() - started >= budgetMs) break;
      if (t.status !== 'blocked') {
        if (!partners.has(t.partnerId)) partners.set(t.partnerId, await partnerRepo.getPartner(t.partnerId));
        const rules = resolveCorridorRules(partners.get(t.partnerId) ?? null, t.sourceCountry);
        const cfg: AmlRuleConfig = { ...rules.aml, largeAmountUsd: rules.largeAmountUsd };
        result.alerts += await evaluateRow(db, redis, t, cfg, opts.bidxKey, () => redisUp, markDown);
      }
      result.scanned++;
      last = { at: new Date(t.createdAt), id: t.id };
    }

    // ── cursor advance: forward-only, past completed rows only ──
    if (last && redisUp) {
      try {
        const current = parseCursor(await redis.get(AML_CURSOR_KEY));
        if (!current || cursorAfter(last, current)) {
          await redis.set(AML_CURSOR_KEY, `${last.at.toISOString()}|${last.id}`);
        }
      } catch {
        markDown('cursor-write');
      }
    }
  } finally {
    if (ownLock && redisUp) {
      try {
        if ((await redis.get(AML_LOCK_KEY)) === token) await redis.del(AML_LOCK_KEY);
      } catch {
        markDown('unlock'); // the 55 s TTL frees it
      }
    }
  }
  return result;
}

/** Evaluate one transfer; returns how many FRESH alerts it raised. */
async function evaluateRow(
  db: Db,
  redis: AmlRedis,
  t: Transfer,
  cfg: AmlRuleConfig,
  bidxKey: Buffer | undefined,
  redisUp: () => boolean,
  markDown: (where: string) => void,
): Promise<number> {
  const repo = createTransferRepo(db);
  const at = new Date(t.createdAt);
  const prior = await repo.senderAmlStats(t.partnerId, t.phone, { at, id: t.id }, cfg.largeAmountUsd, cfg.band);

  const hits: Array<{ hit: AmlHit; dedupeKey: string }> = [];
  const s = structuring(prior, t.amountUsd, cfg);
  if (s) hits.push({ hit: s, dedupeKey: `aml:structuring:${t.id}` });

  // ── Redis-backed rules (R2b, R3) ──
  let newDestination: boolean | null = null;
  let seed: { key: string; member: string } | null = null;
  if (redisUp()) {
    let destB: string | null = null;
    let sendB: string | null = null;
    try {
      // One decrypt per new row, in memory, in the worker only. Only the HMAC leaves.
      const full = await repo.getTransfer(t.id, { decrypt: true });
      if (full) {
        destB = destinationBidx(full.payoutMethod, full.payoutDestination, bidxKey);
        sendB = senderBidx(t.phone, bidxKey);
      }
    } catch {
      // Never log the error text (it could carry plaintext); the id is enough.
      logWarn('aml.sweep', 'destination fingerprint unavailable — row checked on ledger rules only', { transferId: t.id });
    }
    if (destB && sendB) {
      try {
        const sdKey = `aml:sd:${t.partnerId}:${sendB}`;
        const existed = (await redis.exists(sdKey)) === 1;
        const known = existed ? (await redis.sismember(sdKey, destB)) === 1 : false;
        newDestination = existed ? !known : null; // missing set ⇒ seed without alerting
        if (!known) seed = { key: sdKey, member: destB };

        const zKey = `aml:dst:${t.partnerId}:${destB}`;
        const score = at.getTime();
        await redis.zadd(zKey, { gt: true }, { score, member: sendB });
        await redis.zremrangebyscore(zKey, '-inf', `(${score - CLUSTER_WINDOW_MS}`);
        let card = await redis.zcard(zKey);
        const cap = cfg.senders * 2;
        if (card > cap) {
          await redis.zremrangebyrank(zKey, 0, -(cap + 1));
          card = cap;
        }
        await redis.expire(zKey, DEST_ZSET_TTL_S);
        const c = cluster(card, cfg);
        if (c) hits.push({ hit: c, dedupeKey: `aml:cluster:${t.partnerId}:${destB}:${monthOf(at)}` });
      } catch {
        markDown('rules');
        newDestination = null;
        seed = null;
      }
    }
  }

  const f = firstTransfer(prior, t.amountUsd, newDestination, cfg);
  if (f) hits.push({ hit: f, dedupeKey: `aml:${f.rule}:${t.id}` });

  let fresh = 0;
  for (const { hit, dedupeKey } of hits) {
    const raised = await db.transaction(async (tx) => {
      const enqueued = await createOutboxRepo(tx).enqueue(
        'ops.alert',
        // The handler sends p.message only (outbox-worker.ts ops.alert). Ids only: no PII.
        { message: `AML ${hit.rule} on ${t.id}` },
        { dedupeKey },
      );
      if (enqueued) {
        await createAuditRepo(tx).record({
          partnerId: t.partnerId,
          actor: 'system',
          actorType: 'system',
          action: 'aml.alert',
          subjectId: t.id,
          meta: { rule: hit.rule, window: hit.window, count: hit.count, sumUsd: hit.sumUsd },
        });
      }
      return enqueued;
    });
    if (raised) fresh++;
  }

  // Remember the destination only after the alerts committed.
  if (seed && redisUp()) {
    try {
      await redis.sadd(seed.key, seed.member);
      await redis.expire(seed.key, DEST_SET_TTL_S);
    } catch {
      markDown('seed');
    }
  }
  return fresh;
}
