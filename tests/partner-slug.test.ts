import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
import { partners, partnerSites, auditEvents, partnerSlugTombstones } from '@/db/schema';
import type { Db } from '@/db/client';
import { setPartnerSlug, getPartnerSite, savePartnerTheme } from '@/db/repos/partner-site-repo';
import { siteCacheKey } from '@/lib/site-tenant-resolver';

describe('setPartnerSlug', () => {
  let db: Db; let redis: ReturnType<typeof fakeRedis>;
  beforeEach(async () => {
    db = await freshDb(); redis = fakeRedis();
    await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B' }, { id: 'ps', name: 'S', status: 'suspended' }]);
  });
  const slugAudits = (action: 'partner.slug.update' | 'partner.slug.claim' = 'partner.slug.update') =>
    db.select({ partnerId: auditEvents.partnerId, actor: auditEvents.actor, actorType: auditEvents.actorType, subjectId: auditEvents.subjectId, meta: auditEvents.meta })
      .from(auditEvents).where(eq(auditEvents.action, action));
  const allSlugAudits = () => db.select().from(auditEvents).where(inArray(auditEvents.action, ['partner.slug.update', 'partner.slug.claim']));

  it('claims a slug, audits in the same write, and clears the negative cache for it', async () => {
    await redis.set(siteCacheKey('acme'), '-');
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis })).toEqual({ ok: true });
    expect(await getPartnerSite(db, 'pa')).toMatchObject({ slug: 'acme' });
    expect(await redis.get(siteCacheKey('acme'))).toBeNull();
    expect(await slugAudits('partner.slug.claim')).toEqual([
      { partnerId: 'pa', actor: 'u', actorType: 'staff', subjectId: 'pa', meta: { slug: 'acme', previousSlug: null } },
    ]);
  });
  it('taken, reserved, ??-- and malformed all return the same "unavailable" (no oracle), and write nothing', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    for (const s of ['acme', 'www', 'pay', 'portal', 'xn--abc', 'ab--cd', 'Bad_Slug', 'ACME', 'ab', 'a'.repeat(31)]) {
      expect(await setPartnerSlug(db, 'pb', s, 'u', { redis }), s).toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(await getPartnerSite(db, 'pb')).toBeNull();
    expect(await allSlugAudits()).toHaveLength(1);
  });
  it('re-slugging (platform change) clears the old slug’s cache and records the previous slug', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await redis.set(siteCacheKey('acme'), 'pa');
    expect(await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis, mode: 'change' })).toEqual({ ok: true });
    expect(await redis.get(siteCacheKey('acme'))).toBeNull();
    expect((await slugAudits()).at(-1)?.meta).toEqual({ slug: 'acme-two', previousSlug: 'acme' });
  });
  it('a released slug is NEVER reusable by another partner (audit-history tombstone)', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis, mode: 'change' });
    expect(await setPartnerSlug(db, 'pb', 'acme', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await getPartnerSite(db, 'pb')).toBeNull();
  });
  it('a slug first written outside the writer (no claim audit) is still never reusable once released (previousSlug)', async () => {
    await db.insert(partnerSites).values({ partnerId: 'pa', slug: 'old-co' });
    expect(await setPartnerSlug(db, 'pa', 'new-co', 'u', { redis, mode: 'change' })).toEqual({ ok: true });
    expect(await setPartnerSlug(db, 'pb', 'old-co', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    // M3-18: never reused, not even by the partner that released it.
    expect(await setPartnerSlug(db, 'pa', 'old-co', 'u', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('M3-18: the same partner can NOT take back its own former slug (never reused)', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis, mode: 'change' });
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await getPartnerSite(db, 'pa')).toMatchObject({ slug: 'acme-two' });
  });
  it('a suspended partner keeps its slug: nobody else can claim it', async () => {
    await setPartnerSlug(db, 'ps', 'held', 'u', { redis });
    expect(await setPartnerSlug(db, 'pb', 'held', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('a slug held by a row written outside the writer (no audit) is still refused', async () => {
    await db.insert(partnerSites).values({ partnerId: 'pa', slug: 'direct' });
    expect(await setPartnerSlug(db, 'pb', 'direct', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('a unique-index race (SQLSTATE 23505) maps to the same unavailable; other errors propagate', async () => {
    const racing = { transaction: async () => { throw Object.assign(new Error('dup'), { code: '23505' }); } } as unknown as Db;
    expect(await setPartnerSlug(racing, 'pa', 'acme', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    const wrapped = { transaction: async () => { throw Object.assign(new Error('q'), { cause: { code: '23505' } }); } } as unknown as Db;
    expect(await setPartnerSlug(wrapped, 'pa', 'acme', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    const broken = { transaction: async () => { throw new Error('db down'); } } as unknown as Db;
    await expect(setPartnerSlug(broken, 'pa', 'acme', 'u', { redis })).rejects.toThrow('db down');
  });
  it('a platform change to the slug already held is a no-op success (no second audit row)', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis, mode: 'change' })).toEqual({ ok: true });
    expect(await allSlugAudits()).toHaveLength(1);
  });
  it('keeps the accent colour already on the site row', async () => {
    await savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, 'u');
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    expect(await getPartnerSite(db, 'pa')).toEqual({ slug: 'acme', accentColor: '#0e7490' });
  });
  it('a failing cache delete after commit still returns ok (the 60 s TTL bounds staleness)', async () => {
    redis.del = async () => { throw new Error('down'); };
    const log = await import('@/lib/log');
    const warn = vi.spyOn(log, 'logWarn').mockImplementation(() => {});
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis })).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('an unknown partner → not_found, nothing written', async () => {
    expect(await setPartnerSlug(db, 'zz', 'fresh', 'u', { redis })).toEqual({ ok: false, reason: 'not_found' });
    expect(await setPartnerSlug(db, 'zz', 'fresh', 'u', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await db.select().from(partnerSites)).toHaveLength(0);
    expect(await allSlugAudits()).toHaveLength(0);
  });

  // ── M3-18: claimed once, platform-only changes, never reused ────────────────────────────────
  const tombstones = () =>
    db.select({ slug: partnerSlugTombstones.slug, partnerId: partnerSlugTombstones.partnerId, releasedBy: partnerSlugTombstones.releasedBy })
      .from(partnerSlugTombstones);
  const claimAudits = () =>
    db.select({ partnerId: auditEvents.partnerId, actor: auditEvents.actor, meta: auditEvents.meta })
      .from(auditEvents).where(eq(auditEvents.action, 'partner.slug.claim'));

  it('M3-18 claim: the default mode is claim, audited as partner.slug.claim with the server actorScope', async () => {
    expect(await setPartnerSlug(db, 'pa', 'acme', 'pa-admin', { redis, actorScope: 'partner' })).toEqual({ ok: true });
    expect(await claimAudits()).toEqual([
      { partnerId: 'pa', actor: 'pa-admin', meta: { slug: 'acme', previousSlug: null, actorScope: 'partner' } },
    ]);
    expect(await slugAudits()).toHaveLength(0);
    expect(await tombstones()).toEqual([]);
  });
  it('M3-18 claim: a second claim (any slug, even the same one) → already_claimed, nothing written', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    for (const s of ['acme-two', 'acme']) {
      expect(await setPartnerSlug(db, 'pa', s, 'u', { redis }), s).toEqual({ ok: false, reason: 'already_claimed' });
    }
    expect(await getPartnerSite(db, 'pa')).toMatchObject({ slug: 'acme' });
    expect(await claimAudits()).toHaveLength(1);
    expect(await tombstones()).toEqual([]);
  });
  it('M3-18 claim: a site row with no slug yet (theme saved first) can still claim once', async () => {
    await savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, 'u');
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis })).toEqual({ ok: true });
    expect(await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis })).toEqual({ ok: false, reason: 'already_claimed' });
  });
  it('M3-18 change: claim acme, platform change to acme-two → a tombstone for acme in the same write', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'pa-admin', { redis });
    expect(
      await setPartnerSlug(db, 'pa', 'acme-two', 'ops', { redis, mode: 'change', actorScope: 'platform', reason: 'rebrand requested' }),
    ).toEqual({ ok: true });
    expect(await tombstones()).toEqual([{ slug: 'acme', partnerId: 'pa', releasedBy: 'ops' }]);
    expect((await slugAudits()).at(-1)).toMatchObject({
      actor: 'ops',
      meta: { slug: 'acme-two', previousSlug: 'acme', actorScope: 'platform', reason: 'rebrand requested' },
    });
  });
  it('M3-18: a tombstoned slug is unavailable to everyone (other partner, same partner, claim or change)', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis, mode: 'change' });
    expect(await setPartnerSlug(db, 'pb', 'acme', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await setPartnerSlug(db, 'pb', 'acme', 'u', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await getPartnerSite(db, 'pb')).toBeNull();
  });
  it('M3-18: a tombstone alone (no audit history, e.g. written by an operator) blocks the slug', async () => {
    await db.insert(partnerSlugTombstones).values({ slug: 'gone-co', partnerId: 'pa', releasedBy: 'ops' });
    expect(await setPartnerSlug(db, 'pb', 'gone-co', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await setPartnerSlug(db, 'pa', 'gone-co', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await db.select().from(partnerSites)).toHaveLength(0);
  });
  it('M3-18: a slug CLAIMED by another partner (partner.slug.claim history) is never reusable either', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    // An operator deletes the row by hand (no tombstone, no release audit): the claim history still holds it.
    await db.delete(partnerSites).where(eq(partnerSites.partnerId, 'pa'));
    expect(await setPartnerSlug(db, 'pb', 'acme', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('M3-18: the platform may set a first slug (no tombstone when there was none)', async () => {
    expect(await setPartnerSlug(db, 'pa', 'first-co', 'ops', { redis, mode: 'change', actorScope: 'platform' })).toEqual({ ok: true });
    expect(await tombstones()).toEqual([]);
    expect((await slugAudits()).at(-1)?.meta).toEqual({ slug: 'first-co', previousSlug: null, actorScope: 'platform' });
  });
  it('M3-18: a suspended partner’s slug stays held (row persists) and can not be taken', async () => {
    await setPartnerSlug(db, 'ps', 'held-co', 'u', { redis });
    expect(await getPartnerSite(db, 'ps')).toMatchObject({ slug: 'held-co' });
    expect(await setPartnerSlug(db, 'pb', 'held-co', 'u', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'unavailable' });
  });
  it('M3-18: a refused platform change writes no tombstone and keeps the old slug', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await setPartnerSlug(db, 'pb', 'bravo', 'u', { redis });
    expect(await setPartnerSlug(db, 'pa', 'bravo', 'ops', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await setPartnerSlug(db, 'pa', 'www', 'ops', { redis, mode: 'change' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await getPartnerSite(db, 'pa')).toMatchObject({ slug: 'acme' });
    expect(await tombstones()).toEqual([]);
  });
  it('M3-18 review: every write locks the partner row FOR NO KEY UPDATE (serialises slug writers; never blocks FK child inserts)', async () => {
    const { PgSelectBase } = await import('drizzle-orm/pg-core');
    const lock = vi.spyOn(PgSelectBase.prototype, 'for');
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis, mode: 'change' });
    expect(lock.mock.calls.map((c) => c[0])).toEqual(['no key update', 'no key update']);
    lock.mockRestore();
  });
});
