import { Redis } from '@upstash/redis';
import { env } from '@/lib/env';
import { logWarn } from '@/lib/log';
import type { InvocationSource } from '@/lib/worker-cadence';

// worker-gate — partner-demo R4 (Neon compute). The per-minute Vercel cron
// used to wake Neon every minute, which kept the free-tier compute awake
// around the clock. Now a cron tick with no outbox work due returns BEFORE it
// touches the database, so Neon can scale to zero between real work.
//
// The due set is ONE Redis sorted set, `outbox:due`, scored by the epoch ms at
// which work becomes due:
//   • `due:<ms>`  — marked by pokeWorker (now) / pokeWorkerDelayed (now+d), in
//     their post-commit after(), and by every full run after its drain (the
//     earliest pending/failed next_attempt_at, or now if work was left over);
//   • `lease:<workerId>` — marked once per invocation at its first claim,
//     scored at the latest instant any lease it took can expire, and removed
//     when the invocation finishes normally. Only a KILLED invocation leaves it
//     behind, and that wakes a run exactly when its rows become reclaimable.
//
// What the gate may do: SKIP AN INVOCATION, never a row. Every committed row
// stays pending/failed/processing until a drain claims it, and three things
// guarantee a full run reaches it:
//   1. the unconditional BACKSTOP: every cron tick on :17 and :47 runs full
//      whatever the set says (so a lost marker costs ≤ 30 min of latency);
//   2. the heartbeat (GitHub, :17 hourly) runs full whenever the cron marker
//      is stale, so a dead Vercel cron still drains hourly;
//   3. FAIL-OPEN: any Redis error on the read path counts as "due" (full run);
//      a write error only loses a marker, which (1) and (4) cover;
//   4. the TIME-BASED backstop (R4 follow-up): `worker:lastFullAt` is written
//      at the end of every completed full run; a cron tick or heartbeat runs
//      full whenever it is missing, unreadable or older than 30 min — so a
//      skipped/late :17/:47 delivery cannot stretch the gap past ~31 min.
//      Rolling release: an old build never writes it, so the new build sees it
//      missing and runs full until its own first full run writes it.
// Dead-lettering counts genuine runs only (outbox-repo markFailed), so a
// skipped invocation can never make a row die sooner.

/** Minutes between unconditional full cron runs (the backstop). */
export const WORKER_BACKSTOP_PERIOD_MIN = 30;
/** The backstop minute offset: :17 and :47, aligned with the :17 GitHub heartbeat. */
const BACKSTOP_OFFSET_MIN = 17;
/** The sorted set key. */
export const DUE_KEY = 'outbox:due';
/** The last completed full run (ISO instant), shared by every instance. */
export const LAST_FULL_KEY = 'worker:lastFullAt';
/** A lastFullAt older than this forces a full run. */
export const LAST_FULL_MAX_AGE_MS = WORKER_BACKSTOP_PERIOD_MIN * 60_000;
/** Tolerated clock skew between instances: a lastFullAt further ahead is not trusted. */
const LAST_FULL_MAX_SKEW_MS = 60_000;
/** The marker outlives the window by a wide margin; its expiry just means "run full". */
const LAST_FULL_TTL_SEC = 24 * 60 * 60;
/** Upper bound on any single gate read/write: a slow Redis may only shorten a drain. */
const GATE_REDIS_TIMEOUT_MS = 2_000;

/**
 * The Upstash calls the gate uses: four sorted-set commands
 * (@upstash/redis 1.38.1 error-8y4qG0W2.d.ts:4800-4864) plus GET / SET for
 * the lastFullAt marker (same file, 4313 and 4636; automaticDeserialization is
 * off, so GET returns the raw string).
 */
export interface GateRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ex: number }): Promise<unknown>;
  zadd(key: string, scoreMember: { score: number; member: string }): Promise<number | null>;
  zcount(key: string, min: number | string, max: number | string): Promise<number>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zremrangebyscore(
    key: string,
    min: number | '-inf' | '+inf',
    max: number | '-inf' | '+inf',
  ): Promise<number>;
}

function warn(what: string, err: unknown): void {
  logWarn('worker.gate', `${what} failed (fail-open)`, { error: err instanceof Error ? err.message : String(err) });
}

/** Records that outbox work is (or becomes) due at `atMs`. Never throws. */
export async function markDue(redis: GateRedis, atMs: number): Promise<void> {
  const score = Math.floor(atMs);
  try {
    await redis.zadd(DUE_KEY, { score, member: `due:${score}` });
  } catch (err) {
    warn('due mark', err);
  }
}

/** One member per invocation: due at `untilMs`, the latest expiry of any lease it holds. Never throws. */
export async function markLease(redis: GateRedis, workerId: string, untilMs: number): Promise<void> {
  try {
    await redis.zadd(DUE_KEY, { score: Math.floor(untilMs), member: `lease:${workerId}` });
  } catch (err) {
    warn('lease mark', err);
  }
}

/** Normal completion: the invocation's leases are all settled. Never throws. */
export async function clearLease(redis: GateRedis, workerId: string): Promise<void> {
  try {
    await redis.zrem(DUE_KEY, `lease:${workerId}`);
  } catch (err) {
    warn('lease clear', err);
  }
}

/** Drops every member scored at or before `beforeMs`. Never throws. */
export async function trimDue(redis: GateRedis, beforeMs: number): Promise<void> {
  try {
    await redis.zremrangebyscore(DUE_KEY, '-inf', Math.floor(beforeMs));
  } catch (err) {
    warn('trim', err);
  }
}

/** Anything due at or before `nowMs`? A Redis error answers TRUE (run full). */
export async function isWorkDue(redis: GateRedis, nowMs: number): Promise<boolean> {
  try {
    return (await redis.zcount(DUE_KEY, '-inf', Math.floor(nowMs))) > 0;
  } catch (err) {
    warn('due read', err);
    return true;
  }
}

/** Records that a full run started at `atMs` completed. Never throws. */
export async function recordFullRun(redis: GateRedis, atMs: number): Promise<void> {
  try {
    await redis.set(LAST_FULL_KEY, new Date(atMs).toISOString(), { ex: LAST_FULL_TTL_SEC });
  } catch (err) {
    warn('lastFullAt write', err);
  }
}

/**
 * Did a full run complete within the last LAST_FULL_MAX_AGE_MS? Missing,
 * unparseable, more than a minute in the FUTURE (a bad write or clock skew
 * must never suppress the backstop) or a Redis error all answer FALSE (run
 * full: fail-open).
 */
export async function isLastFullFresh(redis: GateRedis, nowMs: number): Promise<boolean> {
  try {
    const raw = await redis.get(LAST_FULL_KEY);
    if (typeof raw !== 'string') return false;
    const ms = Date.parse(raw);
    return !Number.isNaN(ms) && ms <= nowMs + LAST_FULL_MAX_SKEW_MS && nowMs - ms <= LAST_FULL_MAX_AGE_MS;
  } catch (err) {
    warn('lastFullAt read', err);
    return false;
  }
}

/** The unconditional full-run minutes: :17 and :47 UTC. */
export function isBackstopMinute(now: Date): boolean {
  return now.getUTCMinutes() % WORKER_BACKSTOP_PERIOD_MIN === BACKSTOP_OFFSET_MIN % WORKER_BACKSTOP_PERIOD_MIN;
}

export interface GateInput {
  source: InvocationSource;
  /** isBackstopMinute(now). */
  backstop: boolean;
  /** isWorkDue (true on any Redis error). */
  due: boolean;
  /** The last-cron marker exists and is ≤ CRON_QUIET_MINUTES old. */
  cronFresh: boolean;
  /** isLastFullFresh (false when missing, unreadable, stale or on a Redis error). */
  lastFullFresh: boolean;
}

/**
 * Whether this invocation may skip the database entirely. A POST poke always
 * runs full. A cron tick is gated off the backstop minute when nothing is
 * due. The heartbeat is gated only while the cron is alive (fresh marker) and
 * nothing is due — so it runs full exactly when the Vercel cron is dead.
 * Either one runs full when no full run completed in the last 30 minutes.
 */
export function gateDecision(input: GateInput): 'gated' | 'full' {
  if (input.due) return 'full';
  if (!input.lastFullFresh) return 'full';
  if (input.source === 'cron') return input.backstop ? 'full' : 'gated';
  if (input.source === 'heartbeat') return input.cronFresh ? 'gated' : 'full';
  return 'full';
}

let cached: GateRedis | null = null;
/**
 * The gate's Upstash client: the same shape as worker-cadence's cadenceRedis()
 * (retry: false ⇒ at most two fetches, one shared 2 s abort in the FUNCTION
 * form so a cached client never carries a pre-fired signal). Throws when the
 * KV env is missing; every caller wraps it and treats that as fail-open.
 */
export function gateRedis(): GateRedis {
  if (!cached) {
    if (!env.kvUrl || !env.kvToken) throw new Error('KV env missing');
    cached = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
      retry: false,
      signal: () => AbortSignal.timeout(GATE_REDIS_TIMEOUT_MS),
    }) as unknown as GateRedis;
  }
  return cached;
}
