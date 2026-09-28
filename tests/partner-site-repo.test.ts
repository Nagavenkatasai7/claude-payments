import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import { partners, partnerSites, auditEvents } from '@/db/schema';
import type { Db } from '@/db/client';
import { getPartnerSite, savePartnerTheme, loadSiteTheme } from '@/db/repos/partner-site-repo';
import { DEFAULT_THEME } from '@/lib/ui/tokens';

describe('partner-site-repo', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    await db.insert(partners).values([{ id: 'pa', name: 'A' }, { id: 'pb', name: 'B', primaryColor: '#123456' }]);
  });
  const primaryOf = async (id: string) =>
    (await db.select({ c: partners.primaryColor }).from(partners).where(eq(partners.id, id)))[0]?.c;
  const themeAudits = () =>
    db.select({ partnerId: auditEvents.partnerId, actor: auditEvents.actor, actorType: auditEvents.actorType, subjectId: auditEvents.subjectId, meta: auditEvents.meta })
      .from(auditEvents).where(eq(auditEvents.action, 'partner.theme.update'));
  const siteRows = () => db.select({ partnerId: partnerSites.partnerId, slug: partnerSites.slug, accentColor: partnerSites.accentColor }).from(partnerSites);

  it('savePartnerTheme validates before writing, then writes A only, with an audit row', async () => {
    expect(await savePartnerTheme(db, 'pa', { primaryColor: '#25d366', accentColor: '#0e7490' }, 'u'))
      .toEqual({ ok: false, field: 'primaryColor', reason: 'contrast' });
    expect(await siteRows()).toHaveLength(0);
    expect(await savePartnerTheme(db, 'pa', { primaryColor: '#7A1FA2', accentColor: '#0e7490' }, 'u')).toEqual({ ok: true });
    expect(await primaryOf('pa')).toBe('#7a1fa2');
    expect(await primaryOf('pb')).toBe('#123456');
    expect(await getPartnerSite(db, 'pa')).toEqual({ slug: null, accentColor: '#0e7490' });
    expect(await getPartnerSite(db, 'pb')).toBeNull();
    expect(await themeAudits()).toEqual([
      { partnerId: 'pa', actor: 'u', actorType: 'staff', subjectId: 'pa', meta: { primaryColor: '#7a1fa2', accentColor: '#0e7490' } },
    ]);
  });
  it('an invalid accent refuses the whole write: primary untouched, no site row, no audit', async () => {
    expect(await savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: 'red;}body{x}' }, 'u'))
      .toEqual({ ok: false, field: 'accentColor', reason: 'format' });
    expect(await savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: '#0d9488' }, 'u'))
      .toEqual({ ok: false, field: 'accentColor', reason: 'contrast' });
    expect(await savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: undefined }, 'u'))
      .toEqual({ ok: false, field: 'accentColor', reason: 'format' });
    expect(await primaryOf('pa')).toBeNull();
    expect(await siteRows()).toHaveLength(0);
    expect(await db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(0);
  });
  it('uppercase accent input is stored lowercase (the DB CHECK is lowercase-only)', async () => {
    expect(await savePartnerTheme(db, 'pa', { primaryColor: '#7A1FA2', accentColor: '#0E7490' }, 'u')).toEqual({ ok: true });
    expect(await getPartnerSite(db, 'pa')).toEqual({ slug: null, accentColor: '#0e7490' });
  });
  it('an unknown partner is not_found (no site row, no audit)', async () => {
    expect(await savePartnerTheme(db, 'zz', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, 'u')).toEqual({ ok: false, reason: 'not_found' });
    expect(await siteRows()).toHaveLength(0);
    expect(await db.select({ id: auditEvents.id }).from(auditEvents)).toHaveLength(0);
  });
  it('a second save updates the same row and keeps the slug; B’s row is never touched', async () => {
    await db.insert(partnerSites).values([{ partnerId: 'pa', slug: 'acme' }, { partnerId: 'pb', slug: 'bee', accentColor: '#1f2937' }]);
    await savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, 'u');
    await savePartnerTheme(db, 'pa', { primaryColor: '#0c5bd2', accentColor: '#7a1fa2' }, 'u');
    expect(await getPartnerSite(db, 'pa')).toEqual({ slug: 'acme', accentColor: '#7a1fa2' });
    expect(await getPartnerSite(db, 'pb')).toEqual({ slug: 'bee', accentColor: '#1f2937' });
    expect(await primaryOf('pb')).toBe('#123456');
    expect(await themeAudits()).toHaveLength(2);
  });
  it('a suspended partner keeps its slug through a theme write (disabling never frees a slug)', async () => {
    await db.update(partners).set({ status: 'suspended' }).where(eq(partners.id, 'pb'));
    await db.insert(partnerSites).values({ partnerId: 'pb', slug: 'bee' });
    expect(await savePartnerTheme(db, 'pb', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, 'u')).toEqual({ ok: true });
    expect(await getPartnerSite(db, 'pb')).toEqual({ slug: 'bee', accentColor: '#0e7490' });
  });
  it('if the audit insert fails, both writes roll back (one transaction)', async () => {
    await expect(savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, null as unknown as string)).rejects.toThrow();
    expect(await primaryOf('pa')).toBeNull();
    expect(await siteRows()).toHaveLength(0);
  });
  it('M3-17: an optional actorScope is recorded in the audit meta (partner-surface writers)', async () => {
    expect(await savePartnerTheme(db, 'pa', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, 'u', { actorScope: 'partner' })).toEqual({ ok: true });
    expect((await themeAudits())[0]!.meta).toEqual({ primaryColor: '#7a1fa2', accentColor: '#0e7490', actorScope: 'partner' });
  });
  it('runs on a caller transaction without nesting', async () => {
    await db.transaction(async (tx) => {
      expect(await savePartnerTheme(tx, 'pa', { primaryColor: '#7a1fa2', accentColor: '#0e7490' }, 'u')).toEqual({ ok: true });
    });
    expect(await getPartnerSite(db, 'pa')).toEqual({ slug: null, accentColor: '#0e7490' });
  });
  it('loadSiteTheme re-validates legacy stored values (trim-only save path)', async () => {
    await db.update(partners).set({ primaryColor: 'red;}body{x}' }).where(eq(partners.id, 'pb'));
    expect(await loadSiteTheme(db, 'pb')).toMatchObject({ primary: DEFAULT_THEME.primary, primaryFromPartner: false });
    for (const legacy of ['#fff', '#25D366', '</style><script>', 'url(x)', ' #7a1fa2 ']) {
      await db.update(partners).set({ primaryColor: legacy }).where(eq(partners.id, 'pb'));
      expect(await loadSiteTheme(db, 'pb')).toEqual({ primary: DEFAULT_THEME.primary, accent: DEFAULT_THEME.accent, primaryFromPartner: false, accentFromPartner: false });
    }
  });
  it('loadSiteTheme is tenant-scoped: A never sees B’s colours', async () => {
    await savePartnerTheme(db, 'pb', { primaryColor: '#7a1fa2', accentColor: '#1f2937' }, 'u');
    expect(await loadSiteTheme(db, 'pa')).toEqual({ primary: DEFAULT_THEME.primary, accent: DEFAULT_THEME.accent, primaryFromPartner: false, accentFromPartner: false });
    expect(await loadSiteTheme(db, 'pb')).toEqual({ primary: '#7a1fa2', accent: '#1f2937', primaryFromPartner: true, accentFromPartner: true });
    expect(await loadSiteTheme(db, 'zz')).toMatchObject({ primaryFromPartner: false, accentFromPartner: false });
  });
});
