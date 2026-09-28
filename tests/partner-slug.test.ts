import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { fakeRedis } from './helpers';
import { partners, partnerSites, auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import { setPartnerSlug, getPartnerSite, savePartnerTheme } from '@/db/repos/partner-site-repo';
import { siteCacheKey } from '@/lib/site-tenant-resolver';

describe('setPartnerSlug', () => {
  let db: Db; let redis: ReturnType<typeof fakeRedis>;
  beforeEach(async () => {
    db = await freshDb(); redis = fakeRedis();
    await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B' }, { id: 'ps', name: 'S', status: 'suspended' }]);
  });
  const slugAudits = () =>
    db.select({ partnerId: auditEvents.partnerId, actor: auditEvents.actor, actorType: auditEvents.actorType, subjectId: auditEvents.subjectId, meta: auditEvents.meta })
      .from(auditEvents).where(eq(auditEvents.action, 'partner.slug.update'));

  it('claims a slug, audits in the same write, and clears the negative cache for it', async () => {
    await redis.set(siteCacheKey('acme'), '-');
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis })).toEqual({ ok: true });
    expect(await getPartnerSite(db, 'pa')).toMatchObject({ slug: 'acme' });
    expect(await redis.get(siteCacheKey('acme'))).toBeNull();
    expect(await slugAudits()).toEqual([
      { partnerId: 'pa', actor: 'u', actorType: 'staff', subjectId: 'pa', meta: { slug: 'acme', previousSlug: null } },
    ]);
  });
  it('taken, reserved, ??-- and malformed all return the same "unavailable" (no oracle), and write nothing', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    for (const s of ['acme', 'www', 'pay', 'portal', 'xn--abc', 'ab--cd', 'Bad_Slug', 'ACME', 'ab', 'a'.repeat(31)]) {
      expect(await setPartnerSlug(db, 'pb', s, 'u', { redis }), s).toEqual({ ok: false, reason: 'unavailable' });
    }
    expect(await getPartnerSite(db, 'pb')).toBeNull();
    expect(await slugAudits()).toHaveLength(1);
  });
  it('re-slugging clears the old slug’s cache and records the previous slug', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await redis.set(siteCacheKey('acme'), 'pa');
    expect(await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis })).toEqual({ ok: true });
    expect(await redis.get(siteCacheKey('acme'))).toBeNull();
    expect((await slugAudits()).at(-1)?.meta).toEqual({ slug: 'acme-two', previousSlug: 'acme' });
  });
  it('a released slug is NEVER reusable by another partner (audit-history tombstone)', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis });
    expect(await setPartnerSlug(db, 'pb', 'acme', 'u', { redis })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await getPartnerSite(db, 'pb')).toBeNull();
  });
  it('the same partner may take back its own former slug', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    await setPartnerSlug(db, 'pa', 'acme-two', 'u', { redis });
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis })).toEqual({ ok: true });
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
  it('setting the same slug again is a no-op success (no second audit row)', async () => {
    await setPartnerSlug(db, 'pa', 'acme', 'u', { redis });
    expect(await setPartnerSlug(db, 'pa', 'acme', 'u', { redis })).toEqual({ ok: true });
    expect(await slugAudits()).toHaveLength(1);
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
    expect(await db.select().from(partnerSites)).toHaveLength(0);
    expect(await slugAudits()).toHaveLength(0);
  });
});
