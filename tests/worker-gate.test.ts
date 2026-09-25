import { describe, it, expect } from 'vitest';
import { fakeGateRedis } from './helpers-gate-redis';
import {
  DUE_KEY,
  LAST_FULL_KEY,
  LAST_FULL_MAX_AGE_MS,
  WORKER_BACKSTOP_PERIOD_MIN,
  clearLease,
  isLastFullFresh,
  recordFullRun,
  gateDecision,
  isBackstopMinute,
  isWorkDue,
  markDue,
  markLease,
  trimDue,
} from '@/lib/worker-gate';

// worker-gate (partner-demo R4): a Redis sorted set `outbox:due`, scored by
// the epoch ms at which outbox work becomes due, lets a cron tick with nothing
// due return BEFORE touching Neon. Everything here is FAIL-OPEN: a Redis error
// means "run full", never "skip".

const T = Date.parse('2026-09-25T10:03:00Z');

describe('markDue / isWorkDue / trimDue', () => {
  it('an empty set is not due', async () => {
    expect(await isWorkDue(fakeGateRedis(), T)).toBe(false);
  });

  it('a mark at or before now is due; a future mark is not due until its time', async () => {
    const r = fakeGateRedis();
    await markDue(r, T + 12_000);
    expect(await isWorkDue(r, T)).toBe(false);
    expect(await isWorkDue(r, T + 12_000)).toBe(true);
    await markDue(r, T - 1);
    expect(await isWorkDue(r, T)).toBe(true);
  });

  it('marks live under DUE_KEY; identical instants collapse to one member', async () => {
    const r = fakeGateRedis();
    await markDue(r, T);
    await markDue(r, T);
    expect(r.dump(DUE_KEY).size).toBe(1);
  });

  it('trimDue removes every member scored at or before the cutoff and keeps later ones', async () => {
    const r = fakeGateRedis();
    await markDue(r, T - 120_000);
    await markDue(r, T - 30_000);
    await markDue(r, T + 60_000);
    await trimDue(r, T - 60_000);
    expect([...r.dump(DUE_KEY).values()].sort()).toEqual([T - 30_000, T + 60_000]);
  });

  it('a Redis error counts as DUE (fail-open: run full)', async () => {
    const r = fakeGateRedis();
    r.failing = true;
    expect(await isWorkDue(r, T)).toBe(true);
  });

  it('writes never throw on a Redis error', async () => {
    const r = fakeGateRedis();
    r.failing = true;
    await expect(markDue(r, T)).resolves.toBeUndefined();
    await expect(trimDue(r, T)).resolves.toBeUndefined();
    await expect(markLease(r, 'w_1', T)).resolves.toBeUndefined();
    await expect(clearLease(r, 'w_1')).resolves.toBeUndefined();
  });
});

describe('markLease / clearLease', () => {
  it('a lease member makes work due at its expiry (a killed invocation is reclaimed on time)', async () => {
    const r = fakeGateRedis();
    await markLease(r, 'w_abc', T + 5 * 60_000);
    expect(r.dump(DUE_KEY).get('lease:w_abc')).toBe(T + 5 * 60_000);
    expect(await isWorkDue(r, T)).toBe(false);
    expect(await isWorkDue(r, T + 5 * 60_000)).toBe(true);
  });

  it('clearLease removes only that worker\'s member', async () => {
    const r = fakeGateRedis();
    await markLease(r, 'w_a', T);
    await markLease(r, 'w_b', T);
    await clearLease(r, 'w_a');
    expect([...r.dump(DUE_KEY).keys()]).toEqual(['lease:w_b']);
  });
});

describe('isBackstopMinute', () => {
  it('the backstop period is 30 minutes', () => {
    expect(WORKER_BACKSTOP_PERIOD_MIN).toBe(30);
  });

  it('true on :17 and :47 (aligned with the :17 GitHub heartbeat), false elsewhere', () => {
    expect(isBackstopMinute(new Date('2026-09-25T10:17:00Z'))).toBe(true);
    expect(isBackstopMinute(new Date('2026-09-25T10:47:59Z'))).toBe(true);
    for (const m of [0, 10, 16, 18, 30, 46, 48, 59]) {
      expect(isBackstopMinute(new Date(Date.UTC(2026, 8, 25, 10, m))), `:${m}`).toBe(false);
    }
  });
});

describe('worker:lastFullAt — the time-based backstop (R4 follow-up)', () => {
  it('the key and the 30-minute window', () => {
    expect(LAST_FULL_KEY).toBe('worker:lastFullAt');
    expect(LAST_FULL_MAX_AGE_MS).toBe(30 * 60_000);
  });

  it('missing ⇒ not fresh (run full)', async () => {
    expect(await isLastFullFresh(fakeGateRedis(), T)).toBe(false);
  });

  it('recorded ⇒ fresh up to 30 min, stale after', async () => {
    const r = fakeGateRedis();
    await recordFullRun(r, T);
    expect(r.strings.get(LAST_FULL_KEY)).toBe(new Date(T).toISOString());
    expect(await isLastFullFresh(r, T)).toBe(true);
    expect(await isLastFullFresh(r, T + LAST_FULL_MAX_AGE_MS)).toBe(true);
    expect(await isLastFullFresh(r, T + LAST_FULL_MAX_AGE_MS + 1)).toBe(false);
  });

  it('a lastFullAt more than a minute in the future ⇒ not fresh (clock skew / bad write never suppresses the backstop)', async () => {
    const r = fakeGateRedis();
    r.strings.set(LAST_FULL_KEY, new Date(T + 60_000).toISOString());
    expect(await isLastFullFresh(r, T)).toBe(true); // within skew tolerance
    r.strings.set(LAST_FULL_KEY, new Date(T + 60_001).toISOString());
    expect(await isLastFullFresh(r, T)).toBe(false);
    r.strings.set(LAST_FULL_KEY, new Date(T + 365 * 24 * 3_600_000).toISOString());
    expect(await isLastFullFresh(r, T)).toBe(false);
  });

  it('an unparseable value ⇒ not fresh', async () => {
    const r = fakeGateRedis();
    r.strings.set(LAST_FULL_KEY, 'garbage');
    expect(await isLastFullFresh(r, T)).toBe(false);
  });

  it('a Redis error ⇒ not fresh (fail-open), and the write never throws', async () => {
    const r = fakeGateRedis();
    await recordFullRun(r, T);
    r.failing = true;
    expect(await isLastFullFresh(r, T)).toBe(false);
    await expect(recordFullRun(r, T)).resolves.toBeUndefined();
  });
});

describe('gateDecision', () => {
  const base = { backstop: false, due: false, cronFresh: true, lastFullFresh: true };

  it('a poke always runs full', () => {
    expect(gateDecision({ ...base, source: 'poke' })).toBe('full');
  });

  it('cron: gated only off the backstop minute with nothing due', () => {
    expect(gateDecision({ ...base, source: 'cron' })).toBe('gated');
    expect(gateDecision({ ...base, source: 'cron', due: true })).toBe('full');
    expect(gateDecision({ ...base, source: 'cron', backstop: true })).toBe('full');
  });

  it('heartbeat: gated only while the cron marker is fresh and nothing is due (a dead cron ⇒ full)', () => {
    expect(gateDecision({ ...base, source: 'heartbeat' })).toBe('gated');
    expect(gateDecision({ ...base, source: 'heartbeat', cronFresh: false })).toBe('full');
    expect(gateDecision({ ...base, source: 'heartbeat', due: true })).toBe('full');
  });

  it('a missing / unreadable / stale lastFullAt forces a full run for cron and heartbeat', () => {
    expect(gateDecision({ ...base, source: 'cron', lastFullFresh: false })).toBe('full');
    expect(gateDecision({ ...base, source: 'heartbeat', lastFullFresh: false })).toBe('full');
  });
});
