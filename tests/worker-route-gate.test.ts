import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { fakeGateRedis, type FakeGateRedis } from './helpers-gate-redis';
import { CRON_MARKER_KEY } from '@/lib/worker-cadence';
import { DUE_KEY, LAST_FULL_KEY, isWorkDue, markDue, markLease } from '@/lib/worker-gate';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { Db } from '@/db/client';

// partner-demo R4 — /api/worker's Neon gate. A cron tick off the :17/:47
// backstop with nothing due in the Redis set returns BEFORE getDb()/getStore()
// (proved with THROWING mocks: a gated call that touched either would 500).
// The heartbeat is gated only while the cron marker is fresh; a POST poke
// always runs full; every Redis failure means a full run. After a full run the
// route marks the next due instant, clears its own lease member, and — if the
// drain threw — leaves the work marked due.

const SECRET = 'worker-gate-route-secret';
process.env.CRON_SECRET = SECRET;

const box = vi.hoisted(() => ({
  db: null as unknown,
  neonThrows: false,
  redis: null as unknown,
  gate: null as unknown,
  gateCtorThrows: false,
  drainThrows: false,
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return {
    ...real,
    getDb: () => {
      if (box.neonThrows) throw new Error('NEON TOUCHED on a gated call');
      return box.db;
    },
  };
});
vi.mock('@/lib/store', async (orig) => {
  const real = await orig<typeof import('@/lib/store')>();
  return {
    ...real,
    getStore: () => {
      if (box.neonThrows) throw new Error('STORE TOUCHED on a gated call');
      return real.getStore();
    },
  };
});
vi.mock('@/lib/worker-cadence', async (orig) => {
  const real = await orig<typeof import('@/lib/worker-cadence')>();
  return { ...real, cadenceRedis: () => box.redis };
});
vi.mock('@/lib/worker-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/worker-gate')>();
  return {
    ...real,
    gateRedis: () => {
      if (box.gateCtorThrows) throw new Error('KV env missing');
      return box.gate;
    },
  };
});
vi.mock('@/lib/outbox-worker', async (orig) => {
  const real = await orig<typeof import('@/lib/outbox-worker')>();
  return {
    ...real,
    drainOnce: (...args: Parameters<typeof real.drainOnce>) => {
      if (box.drainThrows) throw new Error('claimBatch: connection reset');
      return real.drainOnce(...args);
    },
  };
});
vi.mock('@/lib/aml-sweep', async (orig) => {
  const real = await orig<typeof import('@/lib/aml-sweep')>();
  const { fakeAmlRedis } = await import('./helpers-aml-redis');
  return { ...real, amlRedis: () => fakeAmlRedis() };
});

import { GET, POST } from '@/app/api/worker/route';

const AUTH = { authorization: `Bearer ${SECRET}` };
const CRON = { ...AUTH, 'x-vercel-cron-schedule': '* * * * *' };
const cronReq = () => new NextRequest('https://smartremit.test/api/worker', { method: 'GET', headers: CRON });
const heartbeatReq = () => new NextRequest('https://smartremit.test/api/worker', { method: 'GET', headers: AUTH });
const pokeReq = () => new NextRequest('https://smartremit.test/api/worker', { method: 'POST', headers: AUTH });

/** Real wall clock moved to minute `m` of the current UTC hour (DB now() stays within the hour). */
function atMinute(m: number): Date {
  const d = new Date();
  d.setUTCMinutes(m, 5, 0);
  return d;
}

/**
 * Moves the clock to minute `m` and seeds a FRESH `worker:lastFullAt` (a full
 * run a minute ago), so only the due set and the backstop minute decide —
 * the lastFullAt tests below then delete or age it.
 */
function at(m: number): void {
  vi.setSystemTime(atMinute(m));
  gate.strings.set(LAST_FULL_KEY, new Date(Date.now() - 60_000).toISOString());
}

let db: Db;
let redis: ReturnType<typeof fakeRedis>;
let gate: FakeGateRedis;
beforeEach(async () => {
  db = await freshDb(); // BEFORE fake timers (CLAUDE.md: PGlite + fake timers)
  redis = fakeRedis();
  gate = fakeGateRedis();
  Object.assign(box, { db, redis, gate, neonThrows: false, gateCtorThrows: false, drainThrows: false });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in test')));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function body(res: Response): Promise<Record<string, unknown>> {
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('cron tick', () => {
  it('off the backstop with nothing due: gated, ZERO Neon calls, marker still written', async () => {
    at(3);
    box.neonThrows = true;
    expect(await body(await GET(cronReq()))).toEqual({ ok: true, source: 'cron', gated: true });
    expect(await redis.get(CRON_MARKER_KEY)).not.toBeNull();
  });

  it('on the :17 backstop: runs full even with an empty due set', async () => {
    at(17);
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'unpoked' }, { dedupeKey: 'r4:unpoked' });
    const b = await body(await GET(cronReq()));
    // (the backstop minute also probes FX — network is stubbed off, so its alerts drain too)
    expect(b).toMatchObject({ ok: true, source: 'cron', gated: false });
    const r = await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'r4:unpoked'`);
    expect((r as unknown as { rows: Array<{ status: string }> }).rows[0].status).toBe('done');
  });

  it('on the :47 backstop: runs full', async () => {
    at(47);
    expect(await body(await GET(cronReq()))).toMatchObject({ source: 'cron', gated: false });
  });

  it('off the backstop with a due mark: runs full and drains the row', async () => {
    at(3);
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'poked' }, { dedupeKey: 'r4:poked' });
    await markDue(gate, Date.now() - 1_000);
    expect(await body(await GET(cronReq()))).toMatchObject({ gated: false, processed: 1 });
  });

  it('a future due mark does not wake the database yet', async () => {
    at(3);
    await markDue(gate, Date.now() + 12_000);
    box.neonThrows = true;
    expect(await body(await GET(cronReq()))).toMatchObject({ gated: true });
  });

  it('FAIL-OPEN: a failing gate Redis runs full', async () => {
    at(3);
    gate.failing = true;
    expect(await body(await GET(cronReq()))).toMatchObject({ source: 'cron', gated: false });
  });

  it('FAIL-OPEN: a gate client that cannot be constructed runs full', async () => {
    at(3);
    box.gateCtorThrows = true;
    expect(await body(await GET(cronReq()))).toMatchObject({ source: 'cron', gated: false });
  });
});

describe('worker:lastFullAt — the time-based backstop (R4 follow-up)', () => {
  it('missing: an off-backstop cron tick with nothing due runs FULL', async () => {
    at(3);
    gate.strings.delete(LAST_FULL_KEY);
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'lost mark' }, { dedupeKey: 'r4b:lost' });
    expect(await body(await GET(cronReq()))).toMatchObject({ source: 'cron', gated: false, processed: 1 });
  });

  it('older than 30 min: runs FULL; 30 min or younger: gated', async () => {
    at(3);
    gate.strings.set(LAST_FULL_KEY, new Date(Date.now() - 30 * 60_000 - 1_000).toISOString());
    expect(await body(await GET(cronReq()))).toMatchObject({ gated: false });
    gate.strings.set(LAST_FULL_KEY, new Date(Date.now() - 29 * 60_000).toISOString());
    box.neonThrows = true;
    expect(await body(await GET(cronReq()))).toEqual({ ok: true, source: 'cron', gated: true });
  });

  it('unreadable (garbage value): runs FULL', async () => {
    at(3);
    gate.strings.set(LAST_FULL_KEY, 'not-a-date');
    expect(await body(await GET(cronReq()))).toMatchObject({ gated: false });
  });

  it('stale on a heartbeat with a fresh cron marker: runs FULL', async () => {
    at(17);
    await redis.set(CRON_MARKER_KEY, new Date(Date.now() - 60_000).toISOString());
    gate.strings.delete(LAST_FULL_KEY);
    expect(await body(await GET(heartbeatReq()))).toMatchObject({ source: 'heartbeat', gated: false });
  });

  it('a completed full run records lastFullAt at its start, AFTER its due marks', async () => {
    at(3);
    gate.strings.delete(LAST_FULL_KEY);
    await createOutboxRepo(db).enqueue('rail.callback', { reference: 'later' }, { delayMs: 10 * 60_000, dedupeKey: 'r4b:later' });
    await body(await POST(pokeReq()));
    expect(gate.strings.get(LAST_FULL_KEY)).toBe(new Date(Date.now()).toISOString());
    const lastDue = gate.calls.map((c, i) => (c.startsWith('zadd:due:') ? i : -1)).filter((i) => i >= 0).pop()!;
    expect(lastDue).toBeGreaterThanOrEqual(0);
    expect(gate.calls.lastIndexOf(`set:${LAST_FULL_KEY}`)).toBeGreaterThan(lastDue);
  });

  it('a gated tick does not write it', async () => {
    at(3);
    const before = gate.strings.get(LAST_FULL_KEY);
    expect(await body(await GET(cronReq()))).toMatchObject({ gated: true });
    expect(gate.strings.get(LAST_FULL_KEY)).toBe(before);
    expect(gate.calls).not.toContain(`set:${LAST_FULL_KEY}`);
  });

  it('a drain that THROWS does not write it (the next tick is not held off)', async () => {
    at(3);
    gate.strings.delete(LAST_FULL_KEY);
    box.drainThrows = true;
    await expect(POST(pokeReq())).rejects.toThrow(/connection reset/);
    expect(gate.strings.has(LAST_FULL_KEY)).toBe(false);
  });
});

describe('heartbeat', () => {
  it('gated while the cron marker is fresh and nothing is due (zero Neon calls)', async () => {
    at(17);
    await redis.set(CRON_MARKER_KEY, new Date(Date.now() - 60_000).toISOString());
    box.neonThrows = true;
    expect(await body(await GET(heartbeatReq()))).toEqual({ ok: true, source: 'heartbeat', gated: true });
  });

  it('runs full when the cron marker is stale (the Vercel cron is dead) and raises cronquiet', async () => {
    at(17);
    await redis.set(CRON_MARKER_KEY, new Date(Date.now() - 45 * 60_000).toISOString());
    const b = await body(await GET(heartbeatReq()));
    expect(b).toMatchObject({ source: 'heartbeat', gated: false, cronQuiet: { breached: true } });
  });

  it('runs full when the cron marker is absent', async () => {
    at(17);
    expect(await body(await GET(heartbeatReq()))).toMatchObject({ source: 'heartbeat', gated: false });
  });

  it('runs full when work is due even with a fresh marker', async () => {
    at(17);
    await redis.set(CRON_MARKER_KEY, new Date(Date.now() - 60_000).toISOString());
    await markDue(gate, Date.now() - 1);
    expect(await body(await GET(heartbeatReq()))).toMatchObject({ source: 'heartbeat', gated: false });
  });
});

describe('poke', () => {
  it('a POST always runs full, even off the backstop with an empty due set', async () => {
    at(3);
    expect(await body(await POST(pokeReq()))).toMatchObject({ source: 'poke', gated: false });
  });
});

describe('post-drain marks', () => {
  it('a normal drain leaves NO lease member behind (no extra wake ~5 min later) and nothing due', async () => {
    at(3);
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'x' }, { dedupeKey: 'r4:x' });
    await markDue(gate, Date.now() - 90_000); // the poke's mark, older than the trim cutoff
    expect(await body(await POST(pokeReq()))).toMatchObject({ processed: 1 });
    const members = [...gate.dump(DUE_KEY).keys()];
    expect(members.filter((m) => m.startsWith('lease:'))).toEqual([]);
    expect(await isWorkDue(gate, Date.now() + 10 * 60_000)).toBe(false);
  });

  it('marks the next pending row\'s due time so the gated cron wakes exactly then', async () => {
    at(3);
    await createOutboxRepo(db).enqueue('rail.callback', { reference: 'later' }, { delayMs: 10 * 60_000, dedupeKey: 'r4:later' });
    await body(await POST(pokeReq()));
    const [dueRow] = (await db.execute(sql`SELECT next_attempt_at FROM outbox WHERE dedupe_key = 'r4:later'`) as unknown as {
      rows: Array<{ next_attempt_at: string }>;
    }).rows;
    const dueMs = new Date(dueRow.next_attempt_at).getTime();
    // The faked Date does not tick, so the route's clock is exactly Date.now();
    // the mark is clamped to ≥ that clock (the test shifts it within the hour).
    expect([...gate.dump(DUE_KEY).entries()]).toEqual([[`due:${Math.max(dueMs, Date.now())}`, Math.max(dueMs, Date.now())]]);
  });

  it('a KILLED invocation\'s lease member wakes the next cron tick, which reclaims the row', async () => {
    at(3);
    const outbox = createOutboxRepo(db);
    await outbox.enqueue('ops.alert', { message: 'stranded' }, { dedupeKey: 'r4:stranded' });
    const [row] = await outbox.claimBatch(1, 'w_killed');
    // The killed worker's lease expired, and so did its lease member.
    await db.execute(sql`UPDATE outbox SET lease_until = now() - interval '1 minute' WHERE id = ${row.id}`);
    await markLease(gate, 'w_killed', Date.now() - 30_000);
    expect(await body(await GET(cronReq()))).toMatchObject({ gated: false, processed: 1 });
    const r = await db.execute(sql`SELECT status FROM outbox WHERE id = ${row.id}`);
    expect((r as unknown as { rows: Array<{ status: string }> }).rows[0].status).toBe('done');
  });

  it('writes every due mark BEFORE the trim (R4 follow-up)', async () => {
    at(3);
    await createOutboxRepo(db).enqueue('rail.callback', { reference: 'later' }, { delayMs: 10 * 60_000, dedupeKey: 'r4b:order' });
    await body(await POST(pokeReq()));
    const trimAt = gate.calls.indexOf('trim');
    const dueAt = gate.calls.findIndex((c) => c.startsWith('zadd:due:'));
    expect(trimAt).toBeGreaterThanOrEqual(0);
    expect(dueAt).toBeGreaterThanOrEqual(0);
    expect(dueAt).toBeLessThan(trimAt);
    expect(gate.calls.slice(trimAt).some((c) => c.startsWith('zadd:due:'))).toBe(false);
  });

  it('a drain that THROWS leaves work marked due (the next tick retries, not the backstop)', async () => {
    at(3);
    box.drainThrows = true;
    await expect(POST(pokeReq())).rejects.toThrow(/connection reset/);
    expect(await isWorkDue(gate, Date.now() + 1_000)).toBe(true);
  });
});
