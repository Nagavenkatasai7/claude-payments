import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { freshDb } from './helpers-db';
import { fakeGateRedis, type FakeGateRedis } from './helpers-gate-redis';
import { LAST_FULL_KEY } from '@/lib/worker-gate';
import { HEALTH_DB_TIMEOUT_MS, HEALTH_MEMO_MS } from '@/lib/health';

// GET /api/health — the external dead-man's switch. The anonymous tier reads
// `worker:lastFullAt` from the gate Redis ONLY (getDb is a throwing mock, so
// any Neon touch would surface as a 500/throw), memoised 15 s per instance.
// A Bearer header selects the deep tier, fail-closed: a wrong bearer or an
// unset CRON_SECRET is 401 before any Redis or DB call.

const SECRET = 'health-route-secret';

const box = vi.hoisted(() => ({
  db: null as unknown,
  dbMode: 'real' as 'real' | 'throw' | 'hang' | 'neon-touched',
  gate: null as unknown,
  gateCtorThrows: false,
  getDbCalls: 0,
}));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return {
    ...real,
    getDb: () => {
      box.getDbCalls += 1;
      if (box.dbMode === 'neon-touched') throw new Error('NEON TOUCHED on the anonymous tier');
      if (box.dbMode === 'throw') return { execute: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.1:5432')) };
      if (box.dbMode === 'hang') return { execute: () => new Promise(() => {}) };
      return box.db;
    },
  };
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

type RouteModule = typeof import('@/app/api/health/route');
let route: RouteModule;
let gate: FakeGateRedis;

const anon = () => new NextRequest('https://smartremit.test/api/health');
const withAuth = (value: string) => new NextRequest('https://smartremit.test/api/health', { headers: { authorization: value } });
const gets = () => gate.calls.filter((c) => c === `get:${LAST_FULL_KEY}`).length;

beforeEach(async () => {
  const db = await freshDb(); // BEFORE fake timers (CLAUDE.md: PGlite + fake timers)
  gate = fakeGateRedis();
  Object.assign(box, { db, dbMode: 'neon-touched', gate, gateCtorThrows: false, getDbCalls: 0 });
  gate.strings.set(LAST_FULL_KEY, new Date(Date.now() - 5 * 60_000).toISOString());
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.resetModules(); // a fresh module = an empty per-instance memo
  route = await import('@/app/api/health/route');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function read(res: Response): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

describe('anonymous tier (Redis only, never Neon)', () => {
  it('fresh lastFullAt: 200 and getDb is never called', async () => {
    const r = await read(await route.GET(anon()));
    expect(r).toMatchObject({ status: 200, body: { ok: true, redis: 'ok', worker: 'ok' } });
    expect(r.body).not.toHaveProperty('db');
    expect(box.getDbCalls).toBe(0);
  });

  it('missing lastFullAt: 503 worker:missing', async () => {
    gate.strings.delete(LAST_FULL_KEY);
    expect(await read(await route.GET(anon()))).toMatchObject({ status: 503, body: { ok: false, worker: 'missing' } });
  });

  it('41 min old: 503 worker:stale', async () => {
    gate.strings.set(LAST_FULL_KEY, new Date(Date.now() - 41 * 60_000).toISOString());
    expect(await read(await route.GET(anon()))).toMatchObject({ status: 503, body: { worker: 'stale' } });
  });

  it('a failing gate Redis: 503 redis:fail, and the route does not throw', async () => {
    gate.failing = true;
    expect(await read(await route.GET(anon()))).toMatchObject({ status: 503, body: { redis: 'fail', worker: 'unknown' } });
  });

  it('a gate client that cannot be constructed: 503 redis:fail', async () => {
    box.gateCtorThrows = true;
    expect(await read(await route.GET(anon()))).toMatchObject({ status: 503, body: { redis: 'fail', worker: 'unknown' } });
  });

  it('is memoised: two calls within 15 s make ONE Redis GET; the next after 15 s makes a second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await route.GET(anon());
    vi.setSystemTime(Date.now() + HEALTH_MEMO_MS - 1);
    expect((await route.GET(anon())).status).toBe(200);
    expect(gets()).toBe(1);
    vi.setSystemTime(Date.now() + 2);
    await route.GET(anon());
    expect(gets()).toBe(2);
  });

  it('the memo serves a fresh Response each time (status and body intact)', async () => {
    gate.strings.delete(LAST_FULL_KEY);
    const a = await read(await route.GET(anon()));
    const b = await read(await route.GET(anon()));
    expect(b).toEqual(a);
    expect(b.status).toBe(503);
  });
});

describe('deep tier (Bearer CRON_SECRET, adds Neon select 1)', () => {
  it('a wrong bearer: 401, no Redis or DB touch', async () => {
    const res = await route.GET(withAuth('Bearer nope'));
    expect(res.status).toBe(401);
    expect(gate.calls).toEqual([]);
    expect(box.getDbCalls).toBe(0);
  });

  it('a bearer while CRON_SECRET is unset: 401 (fail-closed, never downgraded to anonymous)', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await route.GET(withAuth('Bearer '));
    expect(res.status).toBe(401);
    expect(gate.calls).toEqual([]);
    expect(box.getDbCalls).toBe(0);
  });

  it('the correct bearer: 200 db:ok against PGlite, and it bypasses the memo', async () => {
    box.dbMode = 'real';
    await route.GET(anon());
    const r = await read(await route.GET(withAuth(`Bearer ${SECRET}`)));
    expect(r).toMatchObject({ status: 200, body: { ok: true, redis: 'ok', worker: 'ok', db: 'ok' } });
    expect(gets()).toBe(2);
    expect(box.getDbCalls).toBe(1);
  });

  it('a throwing DB: 503 db:fail', async () => {
    box.dbMode = 'throw';
    const r = await read(await route.GET(withAuth(`Bearer ${SECRET}`)));
    expect(r).toMatchObject({ status: 503, body: { ok: false, worker: 'ok', db: 'fail' } });
    expect(r.text).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });

  it('a hanging DB: 503 db:fail after HEALTH_DB_TIMEOUT_MS', async () => {
    box.dbMode = 'hang';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = route.GET(withAuth(`Bearer ${SECRET}`));
    await vi.advanceTimersByTimeAsync(HEALTH_DB_TIMEOUT_MS);
    expect(await read(await pending)).toMatchObject({ status: 503, body: { db: 'fail' } });
  });
});

describe('response contract', () => {
  it('Cache-Control: no-store on 200, 503 and 401', async () => {
    expect((await route.GET(anon())).headers.get('cache-control')).toBe('no-store');
    expect((await route.GET(withAuth('Bearer nope'))).headers.get('cache-control')).toBe('no-store');
    gate.failing = true;
    vi.resetModules();
    route = await import('@/app/api/health/route');
    expect((await route.GET(anon())).headers.get('cache-control')).toBe('no-store');
  });

  it('is forced dynamic and exports GET only', () => {
    expect(route.dynamic).toBe('force-dynamic');
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].filter((m) => m in route);
    expect(methods).toEqual([]);
  });

  it('the body never carries the secret, the KV value or the database URL', async () => {
    box.dbMode = 'real';
    const raw = gate.strings.get(LAST_FULL_KEY)!;
    for (const res of [await route.GET(anon()), await route.GET(withAuth(`Bearer ${SECRET}`))]) {
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(raw);
      if (process.env.DATABASE_URL) expect(text).not.toContain(process.env.DATABASE_URL);
    }
  });
});
