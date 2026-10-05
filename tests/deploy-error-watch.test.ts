import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
import {
  deployErrorWatch, errorSpike, previousBaseline, WATCH_WINDOW_MS,
} from '@/lib/deploy-error-watch';
import { buildSha, countBuildError } from '@/lib/build-errors';
import type { Db } from '@/db/client';

// Release safety Batch 2 part D: the error watch after each release.

const OLD = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const T0 = Date.UTC(2026, 9, 5, 6, 0, 0);
const HOUR = 3_600_000;

let db: Db;
let redis: ReturnType<typeof fakeRedis>;

async function alerts(): Promise<Array<{ k: string; m: string }>> {
  const r = (await db.execute(sql`SELECT dedupe_key AS k, payload->>'message' AS m FROM outbox WHERE kind = 'ops.alert'`)) as unknown as {
    rows: Array<{ k: string; m: string }>;
  };
  return r.rows;
}

beforeEach(async () => {
  db = await freshDb();
  redis = fakeRedis();
});

describe('pure rules', () => {
  it('errorSpike needs more than 5 AND more than 3x the baseline', () => {
    expect(errorSpike(5, 0)).toBe(false);
    expect(errorSpike(6, 0)).toBe(true);
    expect(errorSpike(6, 2)).toBe(false);
    expect(errorSpike(7, 2)).toBe(true);
  });

  it('previousBaseline spreads the old count over its life', () => {
    expect(previousBaseline(40, 4 * WATCH_WINDOW_MS)).toBe(10);
    expect(previousBaseline(3, WATCH_WINDOW_MS / 2)).toBe(3);
    expect(previousBaseline(3, 0)).toBe(3);
  });

  it('buildSha accepts a full SHA only', () => {
    expect(buildSha(NEW)).toBe('2222222');
    expect(buildSha('2222222')).toBeNull();
    expect(buildSha(undefined)).toBeNull();
  });
});

describe('deployErrorWatch', { retry: 0 }, () => {
  it('alerts once when the new build spikes against the previous build', async () => {
    await deployErrorWatch(db, redis, T0, OLD); // old build first seen at T0
    await redis.set('builderr:1111111', '8'); // 8 errors over 2 h ⇒ 1 per 15 min
    await deployErrorWatch(db, redis, T0 + 2 * HOUR, NEW); // new build first seen
    await redis.set('builderr:2222222', '9');
    const r = await deployErrorWatch(db, redis, T0 + 2 * HOUR + 5 * 60_000, NEW);
    expect(r).toMatchObject({ kind: 'alerted', count: 9, baseline: 1 });
    await deployErrorWatch(db, redis, T0 + 2 * HOUR + 6 * 60_000, NEW);
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0].k).toBe('deployerrors:2222222');
    expect(a[0].m).toContain('2222222');
    expect(a[0].m).toContain('1111111');
  });

  it('no alert when the new build is close to the old rate', async () => {
    await deployErrorWatch(db, redis, T0, OLD);
    await redis.set('builderr:1111111', '24'); // 3 per 15 min
    await deployErrorWatch(db, redis, T0 + 2 * HOUR, NEW);
    await redis.set('builderr:2222222', '8'); // < 3 x 3
    expect((await deployErrorWatch(db, redis, T0 + 2 * HOUR + 60_000, NEW)).kind).toBe('ok');
    expect(await alerts()).toEqual([]);
  });

  it('stops watching after the window', async () => {
    await deployErrorWatch(db, redis, T0, NEW);
    await redis.set('builderr:2222222', '50');
    expect((await deployErrorWatch(db, redis, T0 + WATCH_WINDOW_MS + 1, NEW)).kind).toBe('outside-window');
    expect(await alerts()).toEqual([]);
  });

  it('after a rollback, the next build compares with the build it replaced', async () => {
    await deployErrorWatch(db, redis, T0, OLD);
    await deployErrorWatch(db, redis, T0 + HOUR, NEW);
    await deployErrorWatch(db, redis, T0 + 2 * HOUR, OLD); // rolled back to OLD
    const THIRD = '3333333ccccccccccccccccccccccccccccccccc';
    await deployErrorWatch(db, redis, T0 + 3 * HOUR, THIRD);
    expect(await redis.get('buildprev:3333333')).toBe('1111111');
  });

  it('no commit SHA: nothing to watch', async () => {
    expect((await deployErrorWatch(db, redis, T0, undefined)).kind).toBe('no-build');
  });
});

describe('countBuildError (edge-safe REST INCR)', () => {
  const ENV = { VERCEL_GIT_COMMIT_SHA: NEW, KV_REST_API_URL: 'https://kv.example.upstash.io', KV_REST_API_TOKEN: 'tok' };

  it('POSTs one INCR + EXPIRE pipeline for builderr:<sha7>', async () => {
    const f = vi.fn(async () => new Response('[]', { status: 200 }));
    expect(await countBuildError(ENV, f as unknown as typeof fetch)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://kv.example.upstash.io/pipeline');
    expect(JSON.parse(String(init.body))).toEqual([['INCR', 'builderr:2222222'], ['EXPIRE', 'builderr:2222222', '604800']]);
  });

  it('never throws: a fetch error, a missing env or a non-https URL is false', async () => {
    const boom = vi.fn(async () => { throw new Error('down'); });
    expect(await countBuildError(ENV, boom as unknown as typeof fetch)).toBe(false);
    expect(await countBuildError({ ...ENV, KV_REST_API_TOKEN: '' }, boom as unknown as typeof fetch)).toBe(false);
    expect(await countBuildError({ ...ENV, KV_REST_API_URL: 'http://kv' }, boom as unknown as typeof fetch)).toBe(false);
    expect(boom).toHaveBeenCalledTimes(1);
  });
});
