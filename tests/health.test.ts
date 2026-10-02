import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  evaluateHealth,
  withTimeout,
  HEALTH_WORKER_STALE_MS,
  HEALTH_DB_TIMEOUT_MS,
  HEALTH_MEMO_MS,
} from '@/lib/health';
import { LAST_FULL_MAX_AGE_MS } from '@/lib/worker-gate';

// /api/health's decision table (the external dead-man's switch). Pure: the
// route feeds it the raw `worker:lastFullAt` read and, on the deep tier, the
// Neon probe outcome. The body is enum strings only.

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (ms: number) => ({ ok: true as const, raw: new Date(NOW - ms).toISOString() });

afterEach(() => {
  vi.useRealTimers();
});

describe('constants', () => {
  it('stale threshold = the 30-min gate backstop + 10 min slack; db probe under the 5 s pool acquire', () => {
    expect(HEALTH_WORKER_STALE_MS).toBe(LAST_FULL_MAX_AGE_MS + 10 * 60_000);
    expect(HEALTH_WORKER_STALE_MS).toBe(40 * 60_000);
    expect(HEALTH_DB_TIMEOUT_MS).toBe(4_000);
    expect(HEALTH_MEMO_MS).toBe(15_000);
  });
});

describe('evaluateHealth', () => {
  it('a fresh lastFullAt (5 min old) is 200 ok', () => {
    expect(evaluateHealth({ nowMs: NOW, lastFull: ago(5 * 60_000) })).toEqual({
      status: 200,
      body: { ok: true, redis: 'ok', worker: 'ok' },
    });
  });

  it('exactly the threshold old is ok; 1 ms older is 503 stale', () => {
    expect(evaluateHealth({ nowMs: NOW, lastFull: ago(HEALTH_WORKER_STALE_MS) }).body.worker).toBe('ok');
    const r = evaluateHealth({ nowMs: NOW, lastFull: ago(HEALTH_WORKER_STALE_MS + 1) });
    expect(r).toEqual({ status: 503, body: { ok: false, redis: 'ok', worker: 'stale' } });
  });

  it('a null or unparseable value is 503 missing', () => {
    expect(evaluateHealth({ nowMs: NOW, lastFull: { ok: true, raw: null } })).toEqual({
      status: 503,
      body: { ok: false, redis: 'ok', worker: 'missing' },
    });
    expect(evaluateHealth({ nowMs: NOW, lastFull: { ok: true, raw: 'not-a-date' } }).body.worker).toBe('missing');
  });

  it('more than 60 s in the future is 503 stale (mirrors isLastFullFresh); 60 s is tolerated', () => {
    expect(evaluateHealth({ nowMs: NOW, lastFull: ago(-60_000) }).body.worker).toBe('ok');
    const r = evaluateHealth({ nowMs: NOW, lastFull: ago(-60_001) });
    expect(r.status).toBe(503);
    expect(r.body.worker).toBe('stale');
  });

  it('a Redis failure is 503 redis:fail, worker:unknown', () => {
    expect(evaluateHealth({ nowMs: NOW, lastFull: { ok: false } })).toEqual({
      status: 503,
      body: { ok: false, redis: 'fail', worker: 'unknown' },
    });
  });

  it('db:fail is 503 even with a fresh worker; db omitted means no db key', () => {
    expect(evaluateHealth({ nowMs: NOW, lastFull: ago(60_000), db: 'fail' })).toEqual({
      status: 503,
      body: { ok: false, redis: 'ok', worker: 'ok', db: 'fail' },
    });
    expect(evaluateHealth({ nowMs: NOW, lastFull: ago(60_000), db: 'ok' })).toEqual({
      status: 200,
      body: { ok: true, redis: 'ok', worker: 'ok', db: 'ok' },
    });
    expect('db' in evaluateHealth({ nowMs: NOW, lastFull: ago(60_000) }).body).toBe(false);
  });
});

describe('withTimeout', () => {
  it("rejects with the fixed 'timeout' error after ms", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => {}), 1_000);
    const assertion = expect(p).rejects.toThrow(/^timeout$/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('resolves the inner value when it is faster', async () => {
    await expect(withTimeout(Promise.resolve(42), 1_000)).resolves.toBe(42);
  });

  it('passes the inner rejection through', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
  });
});
