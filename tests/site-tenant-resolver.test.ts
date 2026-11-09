import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
import { partners, partnerSites, partnerSlugTombstones, auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import { resolveSiteSlug, siteCacheKey, skinCacheKey, SITE_CACHE_TTL_SEC } from '@/lib/site-tenant-resolver';
import { findActivePartnerIdBySlug } from '@/db/repos/partner-site-repo';
import { createFeatureFlagRepo } from '@/db/repos/feature-flag-repo';
import { invalidateFlagCache } from '@/lib/flags';

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

// Site skins (owner go 2026-11-09): tgfl.smartremit.ai is a LOOK over SmartRemit's own tenant
// (src/lib/site-skins.ts). The skin branch never uses the slug cache for its answer, so the
// "TGFL demo portal" switch (portal.skins) decides on EVERY call; a real partner that holds, or ever
// held, the slug always wins; every failure is the same null (the generic sheet).
describe('resolveSiteSlug: a skin slug (tgfl)', () => {
  let db: Db; let redis: ReturnType<typeof fakeRedis>;
  const limited = async () => false;
  const H = new Headers({ 'x-forwarded-for': '1.1.1.1' });
  const on = async () => true;
  const off = async () => false;
  beforeEach(async () => {
    db = await freshDb(); redis = fakeRedis();
    // freshDb seeds the 'default' partner (migration 0001): the skin's tenant.
    await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'ps', name: 'S', status: 'suspended' }]);
  });

  it('the status cache has its own key and the same short life as the slug cache', () => {
    expect(skinCacheKey('tgfl')).toBe('site:v1:skin:tgfl');
    expect(skinCacheKey('tgfl')).not.toBe(siteCacheKey('tgfl'));
  });
  it('switch on, tenant active, slug never held → the skin\'s tenant', async () => {
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBe('default');
  });
  it('switch off → null (the generic sheet)', async () => {
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: off })).toBeNull();
  });
  it('reads the real switch by default: off with no row, on with a global row, off again after it is turned off', async () => {
    invalidateFlagCache(db);
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited })).toBeNull();
    await createFeatureFlagRepo(db).upsert({ key: 'portal.skins', scopeType: 'global', scopeId: '', enabled: true, reason: 'demo for TGFL', updatedBy: 'admin' });
    invalidateFlagCache(db);
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited })).toBe('default');
    await createFeatureFlagRepo(db).upsert({ key: 'portal.skins', scopeType: 'global', scopeId: '', enabled: false, reason: 'demo over', updatedBy: 'admin' });
    invalidateFlagCache(db);
    // The status ("free, tenant active") is cached, the answer is not: the switch wins at once.
    expect(await redis.get(skinCacheKey('tgfl'))).toBe('ok');
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited })).toBeNull();
  });
  it('the answer never enters the slug cache, and a stale slug-cache entry never shadows the switch', async () => {
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBe('default');
    expect(await redis.get(siteCacheKey('tgfl'))).toBeNull();
    // An old negative entry (the host answered "inactive" before the switch went on) is ignored…
    await redis.set(siteCacheKey('tgfl'), '-');
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBe('default');
    // …and so is a positive one once the switch is off.
    await redis.set(siteCacheKey('tgfl'), 'default');
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: off })).toBeNull();
  });
  it('the switch is asked on every call, also when the status comes from the cache', async () => {
    const skinsOn = vi.fn(async () => true);
    await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn });
    const spyDb = { select: vi.fn(), execute: vi.fn() } as unknown as Db;
    expect(await resolveSiteSlug('tgfl', H, { redis, db: spyDb, limited, skinsOn })).toBe('default');
    expect(skinsOn).toHaveBeenCalledTimes(2);
    expect((spyDb as unknown as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
  });
  it('a real ACTIVE partner that holds the slug wins, whatever the switch says (the skin never blanks a partner)', async () => {
    await db.insert(partnerSites).values({ partnerId: 'pa', slug: 'tgfl' });
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBe('pa');
    await redis.del(siteCacheKey('tgfl')); await redis.del(skinCacheKey('tgfl'));
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: off })).toBe('pa');
    expect(await redis.get(skinCacheKey('tgfl'))).toBe('held');
  });
  it('a SUSPENDED partner that holds the slug keeps it: the skin does not take the host over', async () => {
    await db.insert(partnerSites).values({ partnerId: 'ps', slug: 'tgfl' });
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBeNull();
  });
  it('a slug a partner released (tombstone) is never served by the skin: old partner links must stay dead', async () => {
    await db.insert(partnerSlugTombstones).values({ slug: 'tgfl', partnerId: 'pa', releasedBy: 'admin', releasedAt: new Date() });
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBeNull();
  });
  it.each([
    ['claimed once', { slug: 'tgfl', previousSlug: null }],
    ['released', { slug: 'other', previousSlug: 'tgfl' }],
  ])('a slug in the slug audit history (%s) is never served by the skin', async (_label, meta) => {
    await db.insert(auditEvents).values({ partnerId: 'pa', actor: 'u', actorType: 'staff', action: 'partner.slug.update', subjectId: 'pa', meta });
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBeNull();
  });
  it('the skin\'s tenant is not active → null', async () => {
    await db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, 'default'));
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBeNull();
    expect(await redis.get(skinCacheKey('tgfl'))).toBe('inactive');
  });
  it('DB down on the status read → null (fail closed), a warning, and NOTHING cached', async () => {
    const log = await import('@/lib/log');
    const warn = vi.spyOn(log, 'logWarn').mockImplementation(() => {});
    const brokenDb = { execute: () => { throw new Error('db down'); } } as unknown as Db;
    expect(await resolveSiteSlug('tgfl', H, { redis, db: brokenDb, limited, skinsOn: on })).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('1.1.1.1');
    expect(await redis.get(skinCacheKey('tgfl'))).toBeNull();
    expect(await redis.get(siteCacheKey('tgfl'))).toBeNull();
    warn.mockRestore();
  });
  it('a stalled status read is abandoned → null, nothing cached', async () => {
    const log = await import('@/lib/log');
    const warn = vi.spyOn(log, 'logWarn').mockImplementation(() => {});
    const stalledDb = { execute: () => new Promise(() => {}) } as unknown as Db;
    expect(await resolveSiteSlug('tgfl', H, { redis, db: stalledDb, limited, skinsOn: on, dbTimeoutMs: 20 })).toBeNull();
    expect(await redis.get(skinCacheKey('tgfl'))).toBeNull();
    warn.mockRestore();
  });
  it('a stalled or throwing switch read → null (fail closed: the switch never reads as on by accident)', async () => {
    const log = await import('@/lib/log');
    const warn = vi.spyOn(log, 'logWarn').mockImplementation(() => {});
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: () => new Promise(() => {}), dbTimeoutMs: 20 })).toBeNull();
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: async () => { throw new Error('x'); } })).toBeNull();
    warn.mockRestore();
  });
  it('a rate-limited IP on a status-cache miss → null without the DB, nothing cached; a cached status skips the limiter', async () => {
    const spyDb = { select: vi.fn(), execute: vi.fn() } as unknown as Db;
    expect(await resolveSiteSlug('tgfl', H, { redis, db: spyDb, limited: async () => true, skinsOn: on })).toBeNull();
    expect((spyDb as unknown as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
    expect(await redis.get(skinCacheKey('tgfl'))).toBeNull();
    await redis.set(skinCacheKey('tgfl'), 'ok');
    const lim = vi.fn(async () => true);
    expect(await resolveSiteSlug('tgfl', H, { redis, db: spyDb, limited: lim, skinsOn: on })).toBe('default');
    expect(lim).not.toHaveBeenCalled();
  });
  it('Redis down → the DB decides (and the switch still applies)', async () => {
    redis.get = async () => { throw new Error('down'); };
    redis.set = async () => { throw new Error('down'); };
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: on })).toBe('default');
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: off })).toBeNull();
  });
  it('an unknown value in the status cache is treated as a miss (the DB decides)', async () => {
    await redis.set(skinCacheKey('tgfl'), 'default');
    expect(await resolveSiteSlug('tgfl', H, { redis, db, limited, skinsOn: off })).toBeNull();
    expect(await redis.get(skinCacheKey('tgfl'))).toBe('ok');
  });
  it('other slugs are untouched by the skin branch: the switch is never read for them', async () => {
    await db.insert(partnerSites).values({ partnerId: 'pa', slug: 'acme' });
    const skinsOn = vi.fn(async () => true);
    expect(await resolveSiteSlug('acme', H, { redis, db, limited, skinsOn })).toBe('pa');
    expect(await resolveSiteSlug('nope', H, { redis, db, limited, skinsOn })).toBeNull();
    expect(skinsOn).not.toHaveBeenCalled();
    expect(await redis.get(skinCacheKey('acme'))).toBeNull();
  });
});
