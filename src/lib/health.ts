import { LAST_FULL_MAX_AGE_MS } from '@/lib/worker-gate';

// health — the decision table behind GET /api/health, the external dead-man's
// switch. Every alarm the worker raises (cronquiet, draingap, dead-letter) is
// delivered BY the worker, so a dead worker cannot report itself; an outside
// monitor polling this endpoint can. The signal is `worker:lastFullAt`, which
// the gate writes after every COMPLETED full run (src/lib/worker-gate.ts) and
// forces at least every 30 min — fresh means clock, Neon and drain all worked.
// The body is enum strings only: no ages, SHA, env values or error text.

/** lastFullAt older than this is 503: the 30-min gate backstop + 10 min slack. */
export const HEALTH_WORKER_STALE_MS = LAST_FULL_MAX_AGE_MS + 10 * 60_000;
/** Deep-tier `select 1` bound: below the pool's 5 s connectionTimeoutMillis (src/db/client.ts). */
export const HEALTH_DB_TIMEOUT_MS = 4_000;
/** Per-instance memo of the anonymous answer: bounds Upstash reads however hard it is polled. */
export const HEALTH_MEMO_MS = 15_000;
/** Mirrors worker-gate's skew guard: a lastFullAt further in the future is not trusted. */
const LAST_FULL_MAX_SKEW_MS = 60_000;

export type LastFullRead = { ok: true; raw: string | null } | { ok: false };

export interface HealthBody {
  ok: boolean;
  redis: 'ok' | 'fail';
  worker: 'ok' | 'stale' | 'missing' | 'unknown';
  db?: 'ok' | 'fail';
}

export function evaluateHealth(input: {
  nowMs: number;
  lastFull: LastFullRead;
  /** Deep tier only; omitted ⇒ no `db` key in the body. */
  db?: 'ok' | 'fail';
}): { status: 200 | 503; body: HealthBody } {
  const { nowMs, lastFull, db } = input;
  let worker: HealthBody['worker'];
  if (!lastFull.ok) {
    worker = 'unknown';
  } else {
    const ms = typeof lastFull.raw === 'string' ? Date.parse(lastFull.raw) : NaN;
    if (Number.isNaN(ms)) worker = 'missing';
    else if (ms > nowMs + LAST_FULL_MAX_SKEW_MS || nowMs - ms > HEALTH_WORKER_STALE_MS) worker = 'stale';
    else worker = 'ok';
  }
  const redis = lastFull.ok ? 'ok' : 'fail';
  const ok = redis === 'ok' && worker === 'ok' && (db === undefined || db === 'ok');
  const body: HealthBody = { ok, redis, worker, ...(db === undefined ? {} : { db }) };
  return { status: ok ? 200 : 503, body };
}

/** Races `p` against a timer; rejects with a fixed 'timeout' error. The inner work is NOT cancelled. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, expire]).finally(() => clearTimeout(timer));
}
