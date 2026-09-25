import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { fakeRedis } from './helpers';
import { fakeGateRedis } from './helpers-gate-redis';
import { freshDb } from './helpers-db';
import { CRON_MARKER_KEY } from '@/lib/worker-cadence';
import type { Db } from '@/db/client';

// /api/worker's Bearer gate (Program-Fix 12 review follow-up): fail-closed and
// constant-time (src/lib/cron-auth.ts). The positive path proves the label:
// a GET carrying x-vercel-cron-schedule past the gate is `cron` and writes the
// last-cron marker; a POST is `poke`. Vercel sends exactly
// `Authorization: Bearer <CRON_SECRET>` (manage-cron-jobs, "Securing cron jobs").

const SECRET = 'worker-route-test-secret';
process.env.CRON_SECRET = SECRET;

const box = vi.hoisted(() => ({ db: null as unknown, redis: null as unknown }));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => box.db };
});
vi.mock('@/lib/worker-cadence', async (orig) => {
  const real = await orig<typeof import('@/lib/worker-cadence')>();
  return { ...real, cadenceRedis: () => box.redis };
});
// partner-demo R4: the Neon gate's due set → an in-memory stand-in (an
// unmocked client would only pass by failing open against the stubbed fetch).
const gateBox = vi.hoisted(() => ({ gate: null as unknown }));
vi.mock('@/lib/worker-gate', async (orig) => {
  const real = await orig<typeof import('@/lib/worker-gate')>();
  return { ...real, gateRedis: () => gateBox.gate };
});

// Program-Fix 43: the AML sweep's own Upstash client → an in-memory stand-in.
const amlBox = vi.hoisted(() => ({ throwOnce: false }));
vi.mock('@/lib/aml-sweep', async (orig) => {
  const real = await orig<typeof import('@/lib/aml-sweep')>();
  const { fakeAmlRedis } = await import('./helpers-aml-redis');
  return {
    ...real,
    amlRedis: () => {
      if (amlBox.throwOnce) {
        amlBox.throwOnce = false;
        throw new Error('aml redis construction failed');
      }
      return fakeAmlRedis();
    },
  };
});

import { GET, POST } from '@/app/api/worker/route';

function req(method: 'GET' | 'POST', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://smartremit.test/api/worker', { method, headers });
}

let db: Db;
let redis: ReturnType<typeof fakeRedis>;
beforeEach(async () => {
  db = await freshDb();
  redis = fakeRedis();
  box.db = db;
  box.redis = redis;
  gateBox.gate = fakeGateRedis();
  // No outbound network: the FX probe (cron on a :x0 minute) and any Graph send are stubbed out.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network disabled in test')));
});
afterEach(() => vi.unstubAllGlobals());

describe('/api/worker Bearer gate', () => {
  it('401 with no Authorization header (GET and POST)', async () => {
    expect((await GET(req('GET'))).status).toBe(401);
    expect((await POST(req('POST'))).status).toBe(401);
  });

  it('401 with a wrong secret, a same-length near miss, a prefix, and the bare secret', async () => {
    for (const auth of [
      'Bearer nope',
      `Bearer ${SECRET.slice(0, -1)}X`,
      `Bearer ${SECRET.slice(0, -1)}`,
      SECRET,
    ]) {
      expect((await GET(req('GET', { authorization: auth }))).status, auth).toBe(401);
    }
  });

  it('a refused request never touches the cron marker, even with x-vercel-cron-schedule', async () => {
    const res = await GET(req('GET', { authorization: 'Bearer nope', 'x-vercel-cron-schedule': '* * * * *' }));
    expect(res.status).toBe(401);
    expect(await redis.get(CRON_MARKER_KEY)).toBeNull();
  });

  it('the right Bearer + x-vercel-cron-schedule is `cron` and writes the marker', async () => {
    // Pinned to the :17 backstop minute so the cron tick runs full (R4 gate).
    const at = new Date();
    at.setUTCMinutes(17, 5, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    try {
      const res = await GET(req('GET', { authorization: `Bearer ${SECRET}`, 'x-vercel-cron-schedule': '* * * * *' }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; source: string; cronQuiet: unknown };
      expect(body).toMatchObject({ ok: true, source: 'cron', gated: false, cronQuiet: null });
      const marker = await redis.get(CRON_MARKER_KEY);
      expect(marker).not.toBeNull();
      expect(Math.abs(Date.parse(marker!) - Date.now())).toBeLessThan(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the right Bearer on a POST is a `poke` and does not write the marker', async () => {
    const res = await POST(req('POST', { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, source: 'poke' });
    expect(await redis.get(CRON_MARKER_KEY)).toBeNull();
  });
});

// Program-Fix 32 (neon-10): the worker runs the stuck-paid escalation ladder
// beside the other sweeps and reports the count of fresh rungs.
describe('/api/worker — stuck-paid escalation (Program-Fix 32)', () => {
  it('a transfer paid 2 h ago gets its recon:<id>:1h alert on a poke; the body carries `escalated`', async () => {
    const { sql } = await import('drizzle-orm');
    const { seedLedgerSpend } = await import('./helpers-db');
    const id = await seedLedgerSpend(db, { partnerId: 'default', phone: '15550001111', amountUsd: 50, status: 'paid' });
    await db.execute(sql`UPDATE transfers SET paid_at = now() - interval '2 hours' WHERE id = ${id}`);
    const res = await POST(req('POST', { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, escalated: 1 });
    const r = await db.execute(sql`SELECT dedupe_key FROM outbox WHERE dedupe_key = ${`recon:${id}:1h`}`);
    expect((r as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });
});

// Program-Fix 43: the worker runs the behavioural AML sweep beside the other
// sweeps (alerts only) and a sweep failure never blocks the drain.
describe('/api/worker — AML sweep wiring (Program-Fix 43)', () => {
  it('a poke runs the sweep: a first-ever $600 send older than 2 minutes raises its alert', async () => {
    const { sql } = await import('drizzle-orm');
    const { seedLedgerSpend } = await import('./helpers-db');
    const id = await seedLedgerSpend(db, {
      partnerId: 'default', phone: '15550003333', amountUsd: 600, createdAt: new Date(Date.now() - 10 * 60_000),
    });
    const res = await POST(req('POST', { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; aml: { scanned: number; alerts: number } };
    expect(body.ok).toBe(true);
    expect(body.aml).toMatchObject({ scanned: 1, alerts: 1 });
    const r = await db.execute(sql`SELECT kind FROM outbox WHERE dedupe_key = ${`aml:first_transfer:${id}`}`);
    expect((r as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it('a throwing sweep is swallowed: the drain still runs (a due row is processed) and aml is null', async () => {
    const { sql } = await import('drizzle-orm');
    const { createOutboxRepo } = await import('@/db/repos/outbox-repo');
    await createOutboxRepo(db).enqueue('ops.alert', { message: 'route test: due row' }, { dedupeKey: 'route-test:due' });
    amlBox.throwOnce = true;
    const res = await POST(req('POST', { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; aml: unknown; processed: number };
    expect(body).toMatchObject({ ok: true, aml: null });
    expect(body.processed).toBeGreaterThanOrEqual(1);
    const r = await db.execute(sql`SELECT status FROM outbox WHERE dedupe_key = 'route-test:due'`);
    expect((r as unknown as { rows: Array<{ status: string }> }).rows[0].status).toBe('done');
  });
});
