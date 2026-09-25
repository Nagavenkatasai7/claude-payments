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
//      a write error only loses a marker, which (1) covers.
// Dead-lettering counts genuine runs only (outbox-repo markFailed), so a
// skipped invocation can never make a row die sooner.

/** Minutes between unconditional full cron runs (the backstop). */
export const WORKER_BACKSTOP_PERIOD_MIN = 30;
/** The backstop minute offset: :17 and :47, aligned with the :17 GitHub heartbeat. */
const BACKSTOP_OFFSET_MIN = 17;
/** The sorted set key. */
export const DUE_KEY = 'outbox:due';
/** Upper bound on any single gate read/write: a slow Redis may only shorten a drain. */
const GATE_REDIS_TIMEOUT_MS = 2_000;

/** The four Upstash sorted-set calls the gate uses (@upstash/redis 1.38.1 error-8y4qG0W2.d.ts:4800-4864). */
export interface GateRedis {
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
}

/**
 * Whether this invocation may skip the database entirely. A POST poke always
 * runs full. A cron tick is gated off the backstop minute when nothing is
 * due. The heartbeat is gated only while the cron is alive (fresh marker) and
 * nothing is due — so it runs full exactly when the Vercel cron is dead.
 */
export function gateDecision(input: GateInput): 'gated' | 'full' {
  if (input.due) return 'full';
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
