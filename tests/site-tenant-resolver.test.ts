import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
import { partners, partnerSites } from '@/db/schema';
import type { Db } from '@/db/client';
import { resolveSiteSlug, siteCacheKey, SITE_CACHE_TTL_SEC } from '@/lib/site-tenant-resolver';
import { findActivePartnerIdBySlug } from '@/db/repos/partner-site-repo';

describe('resolveSiteSlug', () => {
  let db: Db; let redis: ReturnType<typeof fakeRedis>;
  const limited = async () => false;
  const H = new Headers({ 'x-forwarded-for': '1.1.1.1' });
  beforeEach(async () => {
    db = await freshDb(); redis = fakeRedis();
    await db.insert(partners).values([
      { id: 'pa', name: 'A' }, { id: 'ps', name: 'S', status: 'suspended' }, { id: 'pd', name: 'D', status: 'disabled' },
    ]);
    await db.insert(partnerSites).values([
      { partnerId: 'pa', slug: 'acme' }, { partnerId: 'ps', slug: 'gone' }, { partnerId: 'pd', slug: 'off-co' },
    ]);
  });
  it('the cache is short (a disabled partner stops routing within a minute)', () => {
    expect(SITE_CACHE_TTL_SEC).toBe(60);
    expect(siteCacheKey('acme')).toBe('site:v1:slug:acme');
  });
  it('active slug → partner id, cached with the TTL, then served from cache', async () => {
    const setSpy = vi.spyOn(redis, 'set');
    expect(await resolveSiteSlug('acme', H, { redis, db, limited })).toBe('pa');
    expect(await redis.get(siteCacheKey('acme'))).toBe('pa');
    expect(setSpy).toHaveBeenCalledWith(siteCacheKey('acme'), 'pa', { ex: SITE_CACHE_TTL_SEC });
    const spyDb = { select: vi.fn() } as unknown as Db;
    expect(await resolveSiteSlug('acme', H, { redis, db: spyDb, limited })).toBe('pa');
    expect((spyDb as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });
  it('unknown, suspended and disabled slugs all → null (no oracle), negatively cached', async () => {
    expect(await resolveSiteSlug('nope', H, { redis, db, limited })).toBeNull();
    expect(await resolveSiteSlug('gone', H, { redis, db, limited })).toBeNull();
    expect(await resolveSiteSlug('off-co', H, { redis, db, limited })).toBeNull();
    expect(await redis.get(siteCacheKey('gone'))).toBe('-');
    expect(await redis.get(siteCacheKey('nope'))).toBe('-');
  });
  it('a negative cache entry answers null without the DB', async () => {
    await redis.set(siteCacheKey('acme'), '-');
    const spyDb = { select: vi.fn() } as unknown as Db;
    expect(await resolveSiteSlug('acme', H, { redis, db: spyDb, limited })).toBeNull();
  });
  it('disabling a partner stops routing once its cache entry expires (the join re-checks status)', async () => {
    expect(await resolveSiteSlug('acme', H, { redis, db, limited })).toBe('pa');
    await db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, 'pa'));
    await redis.del(siteCacheKey('acme')); // TTL elapsed
    expect(await resolveSiteSlug('acme', H, { redis, db, limited })).toBeNull();
  });
  it('Redis down → falls back to the DB', async () => {
    redis.get = async () => { throw new Error('down'); };
    redis.set = async () => { throw new Error('down'); };
    expect(await resolveSiteSlug('acme', H, { redis, db, limited })).toBe('pa');
  });
  it('a stalled Redis read is abandoned (treated as a miss) instead of hanging the request', async () => {
    redis.get = () => new Promise(() => {});
    expect(await resolveSiteSlug('acme', H, { redis, db, limited, redisTimeoutMs: 20 })).toBe('pa');
  });
  it('DB down → null (fail closed), with a warning and no throw, and NOTHING cached', async () => {
    const log = await import('@/lib/log');
    const warn = vi.spyOn(log, 'logWarn').mockImplementation(() => {});
    const brokenDb = { select: () => { throw new Error('db down'); } } as unknown as Db;
    expect(await resolveSiteSlug('acme', H, { redis, db: brokenDb, limited })).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('1.1.1.1'); // the slug only, never the IP
    expect(await redis.get(siteCacheKey('acme'))).toBeNull(); // a DB blip must not blank a live site for 60 s
    warn.mockRestore();
  });
  it('a stalled DB lookup is abandoned → null (fail closed), nothing cached', async () => {
    const log = await import('@/lib/log');
    const warn = vi.spyOn(log, 'logWarn').mockImplementation(() => {});
    const stalledDb = { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: () => new Promise(() => {}) }) }) }) }) } as unknown as Db;
    expect(await resolveSiteSlug('acme', H, { redis, db: stalledDb, limited, dbTimeoutMs: 20 })).toBeNull();
    expect(await redis.get(siteCacheKey('acme'))).toBeNull();
    warn.mockRestore();
  });
  it('a rate-limited IP on a cache miss → null without touching the DB, and nothing cached', async () => {
    const spyDb = { select: vi.fn() } as unknown as Db;
    expect(await resolveSiteSlug('acme', H, { redis, db: spyDb, limited: async () => true })).toBeNull();
    expect((spyDb as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
    expect(await redis.get(siteCacheKey('acme'))).toBeNull(); // one throttled IP must not blank the site for everyone
  });
  it('a throwing limiter fails open (the DB answers)', async () => {
    expect(await resolveSiteSlug('acme', H, { redis, db, limited: async () => { throw new Error('x'); } })).toBe('pa');
  });
  it('a cache hit never consults the limiter', async () => {
    await redis.set(siteCacheKey('acme'), 'pa');
    const lim = vi.fn(async () => true);
    expect(await resolveSiteSlug('acme', H, { redis, db, limited: lim })).toBe('pa');
    expect(lim).not.toHaveBeenCalled();
  });
  it('an invalid, reserved or ??-- slug never reaches Redis or the DB', async () => {
    const spyDb = { select: vi.fn() } as unknown as Db;
    const get = vi.spyOn(redis, 'get');
    for (const s of ['www', 'pay', 'xn--abc', 'ab--cd', 'ACME', 'a', '']) {
      expect(await resolveSiteSlug(s, H, { redis, db: spyDb, limited }), s).toBeNull();
    }
    expect((spyDb as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
  it('findActivePartnerIdBySlug joins partners and requires status active', async () => {
    expect(await findActivePartnerIdBySlug(db, 'acme')).toBe('pa');
    expect(await findActivePartnerIdBySlug(db, 'gone')).toBeNull();
    expect(await findActivePartnerIdBySlug(db, 'nope')).toBeNull();
  });
});
