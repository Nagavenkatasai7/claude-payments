import { Redis } from '@upstash/redis';
import type { Db } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { env } from '@/lib/env';
import { logWarn } from '@/lib/log';
import type { RedisLike } from '@/lib/store';

// worker-cadence — the worker's CLOCK and its two alarms (Program-Fix 12 /
// Task 8). A Vercel cron (vercel.json, `* * * * *`) GETs /api/worker every
// minute; the hourly GitHub Actions heartbeat backs it up; the after() poke is
// the fast path. The outbox stays the system of record and the cron is only a
// clock: claims are FOR UPDATE SKIP LOCKED, so cron, heartbeat and poke may
// overlap, and Vercel may deliver a run twice or skip one (manage-cron-jobs,
// "Cron job delivery and idempotency") — the handlers are idempotent.
//
// Alarms (each a deduped ops.alert row with counts and ages only):
//   • cronquiet — a non-cron invocation finds the last-cron marker older than
//     CRON_QUIET_MINUTES. Detection latency is bounded by how often non-cron
//     calls arrive: on a quiet system with no pokes that is the hourly
//     heartbeat. An ABSENT marker never alarms (first deploy, rolling
//     release); the ops page and scripts/outbox-status.ts show it in red.
//   • draingap — the oldest claimable row has waited longer than
//     DRAIN_SLA_MINUTES (the drain is saturated, or nothing is draining).
//
// Redis is FAIL-OPEN: the marker write, the marker read and the quiet check
// are wrapped, log through logWarn, and never block or fail a drain.

/** Minutes between cron ticks — tests/worker-cadence.test.ts pins it to vercel.json. */
export const WORKER_CRON_PERIOD_MIN = 1;
/** A claimable row older than this raises `draingap:<hourBucket>`. */
export const DRAIN_SLA_MINUTES = 10;
/** A last-cron marker older than this raises `cronquiet:<hourBucket>`. */
export const CRON_QUIET_MINUTES = 10;
/** Redis key holding the ISO instant of the last cron-sourced invocation. */
export const CRON_MARKER_KEY = 'worker:last-cron';
const CRON_MARKER_TTL_SEC = 30 * 24 * 3600;
/** Upper bound on any single marker read/write: a slow Redis may only shorten a drain. */
const CADENCE_REDIS_TIMEOUT_MS = 2_000;

export type InvocationSource = 'cron' | 'heartbeat' | 'poke';

/**
 * Labels the invocation. Vercel sends every cron request as a GET carrying
 * `x-vercel-cron-schedule` (vercel.com/docs/cron-jobs, "How cron jobs work");
 * the GitHub heartbeat is a plain GET; the after() poke is a POST. The route is
 * Bearer-gated BEFORE this runs, so the header only labels — it authenticates
 * nothing.
 */
export function invocationSource(method: string, headers: Headers): InvocationSource {
  if (method.toUpperCase() === 'POST') return 'poke';
  return headers.get('x-vercel-cron-schedule') ? 'cron' : 'heartbeat';
}

/**
 * Whether this invocation dials Frankfurter for the FX health probe. The
 * heartbeat always does; the per-minute cron only on a :x0 minute (six probes
 * an hour, not 60); a poke never does (during an outage every poke would
 * otherwise re-dial 9 currencies).
 */
export function shouldProbeFx(source: InvocationSource, now: Date): boolean {
  if (source === 'heartbeat') return true;
  if (source === 'cron') return now.getUTCMinutes() % 10 === 0;
  return false;
}

type MarkerRedis = Pick<RedisLike, 'get' | 'set'>;

/** Records that a cron-sourced invocation reached the worker at `now`. Fail-open. */
export async function recordCronRun(redis: MarkerRedis, now: Date): Promise<void> {
  try {
    await redis.set(CRON_MARKER_KEY, now.toISOString(), { ex: CRON_MARKER_TTL_SEC });
  } catch (err) {
    logWarn('worker.cadence', 'cron marker write failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
  }
}

/** The last recorded cron instant, or null when absent, unparseable or Redis fails. */
export async function readLastCronAt(redis: MarkerRedis): Promise<Date | null> {
  try {
    const raw = await redis.get(CRON_MARKER_KEY);
    if (typeof raw !== 'string') return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : new Date(ms);
  } catch (err) {
    logWarn('worker.cadence', 'cron marker read failed (fail-open)', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function hourBucket(now: Date): number {
  return Math.floor(now.getTime() / 3_600_000);
}

function minutesBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.round((later.getTime() - earlier.getTime()) / 60_000));
}

export interface CronQuietResult {
  lastCronAt: Date | null;
  /** The marker exists and is older than CRON_QUIET_MINUTES. */
  breached: boolean;
  /** A NEW cronquiet alert row was enqueued by this call (deduped per hour bucket). */
  alerted: boolean;
}

/**
 * Non-cron invocations call this before the sweep. An absent marker never
 * alarms; a Redis failure never alarms and never throws.
 */
export async function checkCronQuiet(db: Db, redis: MarkerRedis, now: Date): Promise<CronQuietResult> {
  const lastCronAt = await readLastCronAt(redis);
  if (!lastCronAt) return { lastCronAt: null, breached: false, alerted: false };
  const ageMin = minutesBetween(lastCronAt, now);
  if (ageMin <= CRON_QUIET_MINUTES) return { lastCronAt, breached: false, alerted: false };
  const alerted = await createOutboxRepo(db).enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: the Vercel per-minute worker cron has been quiet for ${ageMin}m ` +
        `(threshold ${CRON_QUIET_MINUTES}m) — check the Vercel cron (Settings → Cron Jobs) and the GitHub heartbeat.`,
    },
    { dedupeKey: `cronquiet:${hourBucket(now)}` },
  );
  return { lastCronAt, breached: true, alerted };
}

export interface DrainGapResult {
  /** Rows the next drain would claim (due pending/failed + expired leases). */
  dueNow: number;
  oldestDueAt: Date | null;
  /** The oldest claimable row has waited longer than DRAIN_SLA_MINUTES. */
  breached: boolean;
  /** A NEW draingap alert row was enqueued by this call (deduped per hour bucket). */
  alerted: boolean;
}

/**
 * Runs in every invocation after the sweeps, before the drain loop. It lives
 * here and not in reconcileSweep so SweepResult and its full-literal tests are
 * untouched. The alert row it enqueues is drained by the same invocation.
 */
export async function sweepDrainGap(db: Db, now: Date): Promise<DrainGapResult> {
  const outbox = createOutboxRepo(db);
  const { dueNow, oldestDueAt } = await outbox.dueSummary();
  const waitedMin = oldestDueAt ? minutesBetween(oldestDueAt, now) : 0;
  if (!oldestDueAt || waitedMin <= DRAIN_SLA_MINUTES) return { dueNow, oldestDueAt, breached: false, alerted: false };
  const alerted = await outbox.enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: ${dueNow} outbox row(s) are claimable and the oldest has waited ${waitedMin}m ` +
        `(SLA ${DRAIN_SLA_MINUTES}m) — the drain is behind or not running; check the Vercel cron and the GitHub heartbeat.`,
    },
    { dedupeKey: `draingap:${hourBucket(now)}` },
  );
  return { dueNow, oldestDueAt, breached: true, alerted };
}

export interface CadenceSnapshot {
  dueNow: number;
  oldestDueAt: Date | null;
  lastCronAt: Date | null;
}

/** For the ops page and scripts/outbox-status.ts. Redis failure ⇒ lastCronAt null. */
export async function getCadenceSnapshot(db: Db, redis: MarkerRedis): Promise<CadenceSnapshot> {
  const { dueNow, oldestDueAt } = await createOutboxRepo(db).dueSummary();
  return { dueNow, oldestDueAt, lastCronAt: await readLastCronAt(redis) };
}

let cached: MarkerRedis | null = null;
/**
 * The marker client: NO retries (like ip-rate-limit.ts's limiterRedis — the
 * default client retries ~4 s a call in an outage) and a per-call abort. The
 * signal is the FUNCTION form (@upstash/redis error-8y4qG0W2.d.ts:132,
 * `signal?: AbortSignal | (() => AbortSignal)`): one shared AbortSignal on a
 * cached client would fire once and pre-abort every later call.
 */
export function cadenceRedis(): MarkerRedis {
  if (!cached) {
    cached = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
      retry: false,
      signal: () => AbortSignal.timeout(CADENCE_REDIS_TIMEOUT_MS),
    }) as unknown as MarkerRedis;
  }
  return cached;
}
