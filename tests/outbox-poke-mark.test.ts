import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeGateRedis, type FakeGateRedis } from './helpers-gate-redis';
import { DUE_KEY } from '@/lib/worker-gate';

// partner-demo R4: the enqueue-side marks live in the POKES (post-commit
// after()), never in outbox-repo.enqueue — enqueue runs inside money
// transactions and an Upstash round trip there would lengthen lock hold.
// pokeWorker marks due NOW; pokeWorkerDelayed(d) marks due at now+d, BEFORE
// its sleep (a killed after() still leaves the mark). Both stay fire-and-
// forget: a Redis failure never stops the poke.

const captured = vi.hoisted(() => ({ cbs: [] as Array<() => unknown> }));
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (cb: () => unknown) => void captured.cbs.push(cb) };
});
const gateBox = vi.hoisted(() => ({ gate: null as unknown, ctorThrows: false }));
vi.mock('@/lib/worker-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/worker-gate')>();
  return {
    ...real,
    gateRedis: () => {
      if (gateBox.ctorThrows) throw new Error('KV env missing');
      return gateBox.gate;
    },
  };
});

import { pokeWorker, pokeWorkerDelayed } from '@/lib/outbox';

let gate: FakeGateRedis;
const fetchMock = vi.fn();
const workerCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/worker')).length;
const T = Date.parse('2026-09-25T10:03:00Z');

beforeEach(() => {
  captured.cbs.length = 0;
  gate = fakeGateRedis();
  gateBox.gate = gate;
  gateBox.ctorThrows = false;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('pokeWorker', () => {
  it('marks due NOW and pokes', async () => {
    pokeWorker();
    expect(captured.cbs).toHaveLength(1);
    await captured.cbs[0]();
    expect([...gate.dump(DUE_KEY).values()]).toEqual([T]);
    expect(workerCalls()).toBe(1);
  });

  it('a failing Redis (or no client) never stops the poke', async () => {
    gate.failing = true;
    pokeWorker();
    await captured.cbs[0]();
    gateBox.ctorThrows = true;
    pokeWorker();
    await captured.cbs[1]();
    expect(workerCalls()).toBe(2);
  });
});

describe('pokeWorkerDelayed', () => {
  it('marks due at now+d BEFORE sleeping, then pokes after d', async () => {
    pokeWorkerDelayed(17_000);
    const run = Promise.resolve().then(captured.cbs[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect([...gate.dump(DUE_KEY).values()]).toEqual([T + 17_000]);
    expect(workerCalls()).toBe(0);
    await vi.advanceTimersByTimeAsync(17_000);
    await run;
    expect(workerCalls()).toBe(1);
  });
});
