import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freshDb } from './helpers-db';
import { JOURNAL_ENTRIES } from '@/db/migration-status';

// GET /api/version/migrations: Bearer CRON_SECRET, fail-closed (401 when the
// secret is unset), answers whether prod has applied every migration the
// RUNNING build's bundled journal expects. The post-deploy smoke reads it.

const SECRET = 'migrations-route-test-secret';
const FULL = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const box = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/db/client', async (orig) => {
  const real = await orig<typeof import('@/db/client')>();
  return { ...real, getDb: () => box.db };
});

import * as route from '@/app/api/version/migrations/route';

function req(authorization?: string): Request {
  return new Request('https://smartremit.ai/api/version/migrations', {
    headers: authorization ? { authorization } : {},
  });
}

const fakeDb = (execute: () => Promise<unknown>) => ({ execute });
const allWhen = () => JOURNAL_ENTRIES.map((e) => ({ created_at: String(e.when) }));

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', FULL);
});
afterEach(() => {
  vi.unstubAllEnvs();
  box.db = null;
});

describe('GET /api/version/migrations: auth (fail-closed)', () => {
  it('401 without an Authorization header', async () => {
    box.db = fakeDb(async () => ({ rows: allWhen() }));
    const res = await route.GET(req());
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('401 with a wrong bearer', async () => {
    box.db = fakeDb(async () => ({ rows: allWhen() }));
    const res = await route.GET(req('Bearer nope'));
    expect(res.status).toBe(401);
  });

  it('401 when CRON_SECRET is unset, even for "Bearer " (no fail-open)', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const execute = vi.fn(async () => ({ rows: allWhen() }));
    box.db = fakeDb(execute);
    expect((await route.GET(req('Bearer '))).status).toBe(401);
    expect((await route.GET(req())).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('GET /api/version/migrations: status', () => {
  it('200 ok against a database migrated from the checked-in journal', async () => {
    box.db = await freshDb();
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({
      sha: 'a1b2c3d',
      ok: true,
      expected: JOURNAL_ENTRIES.length,
      applied: JOURNAL_ENTRIES.length,
      pending: [],
      unknownApplied: [],
    });
  });

  it('200 not ok, naming the pending tag, when the last migration is missing', async () => {
    box.db = fakeDb(async () => ({ rows: allWhen().slice(0, -1) }));
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.pending).toEqual([JOURNAL_ENTRIES.at(-1)?.tag]);
  });

  it('503 unreadable without leaking the database error', async () => {
    box.db = fakeDb(async () => {
      throw new Error('password authentication failed for user secret_role');
    });
    const res = await route.GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ sha: 'a1b2c3d', ok: false, error: 'unreadable' });
    expect(text).not.toContain('secret_role');
  });

  it('is forced dynamic and exports GET only', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(['POST', 'PUT', 'PATCH', 'DELETE'].filter((m) => m in route)).toEqual([]);
  });
});
