import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { auditEvents } from '@/db/schema';
import { freshDb, seedPartner } from './helpers-db';
import { getPortalSettings, setPortalAuthTemplate, setPortalEnabled } from '@/db/repos/portal-settings-repo';
import { EMPTY_PARTNER_INTEGRATIONS, type PartnerIntegrations } from '@/lib/partner-integrations';

// UI redesign M2-5, Task 5.2: the per-partner portal settings (auth template name, enablement).
// Repo writers only; M3's go-live checklist (or the M2-14 platform-admin card) wires the UI.

const OWN: PartnerIntegrations = { ...EMPTY_PARTNER_INTEGRATIONS, whatsapp: { phoneNumberId: '1234', token: 'tok' } };
const SHARED: PartnerIntegrations = EMPTY_PARTNER_INTEGRATIONS;
const INCOMPLETE: PartnerIntegrations = { ...EMPTY_PARTNER_INTEGRATIONS, whatsapp: { phoneNumberId: '1234' } };
const deps = (i: PartnerIntegrations) => ({ getIntegrations: async () => i });

async function auditRows(db: Db, partnerId: string, action: string) {
  return db.select().from(auditEvents).where(and(eq(auditEvents.partnerId, partnerId), eq(auditEvents.action, action)));
}

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await seedPartner(db, 'pa');
  await seedPartner(db, 'pb');
});

describe('getPortalSettings', () => {
  it('no row → all null', async () => {
    expect(await getPortalSettings(db, 'pa')).toEqual({ authTemplateName: null, authTemplateLang: null, portalEnabledAt: null });
  });
});

describe('setPortalAuthTemplate', () => {
  it.each([
    [{ name: 'Login_OTP', lang: 'en' }],
    [{ name: 'login otp', lang: 'en' }],
    [{ name: '', lang: 'en' }],
    [{ name: 'a'.repeat(513), lang: 'en' }],
    [{ name: 'login_otp', lang: 'EN' }],
    [{ name: 'login_otp', lang: 'en-US' }],
    [{ name: 'login_otp', lang: 'en_us' }],
    [{ name: 42, lang: 'en' }],
  ])('rejects %j as invalid (nothing written)', async (input) => {
    expect(await setPortalAuthTemplate(db, 'pa', input as never, 'staff:alice')).toEqual({ ok: false, reason: 'invalid' });
    expect((await getPortalSettings(db, 'pa')).authTemplateName).toBeNull();
  });

  it('accepts a valid name/lang, upserts, audits in the same write; B is untouched', async () => {
    expect(await setPortalAuthTemplate(db, 'pa', { name: 'login_otp', lang: 'en_US' }, 'staff:alice')).toEqual({ ok: true });
    expect(await setPortalAuthTemplate(db, 'pa', { name: 'login_otp_v2', lang: 'en' }, 'staff:alice')).toEqual({ ok: true });
    const a = await getPortalSettings(db, 'pa');
    expect(a.authTemplateName).toBe('login_otp_v2');
    expect(a.authTemplateLang).toBe('en');
    expect(await getPortalSettings(db, 'pb')).toEqual({ authTemplateName: null, authTemplateLang: null, portalEnabledAt: null });
    const rows = await auditRows(db, 'pa', 'partner.portal.auth_template');
    expect(rows).toHaveLength(2);
    expect(rows[1].actor).toBe('staff:alice');
    expect(rows[1].meta).toEqual({ name: 'login_otp_v2', lang: 'en' });
    expect(await auditRows(db, 'pb', 'partner.portal.auth_template')).toHaveLength(0);
  });

  it('an unknown partner → not_found', async () => {
    expect(await setPortalAuthTemplate(db, 'nope', { name: 'login_otp', lang: 'en' }, 'staff:alice')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('setPortalEnabled', () => {
  it('refuses to enable without a template (even on an own channel)', async () => {
    expect(await setPortalEnabled(db, 'pa', true, 'staff:alice', deps(OWN))).toEqual({ ok: false, reason: 'not_ready' });
    expect((await getPortalSettings(db, 'pa')).portalEnabledAt).toBeNull();
  });

  it.each([
    ['shared', SHARED],
    ['incomplete', INCOMPLETE],
  ])('refuses to enable a non-default partner on a %s channel', async (_l, integ) => {
    await setPortalAuthTemplate(db, 'pa', { name: 'login_otp', lang: 'en' }, 'staff:alice');
    expect(await setPortalEnabled(db, 'pa', true, 'staff:alice', deps(integ))).toEqual({ ok: false, reason: 'not_ready' });
    expect((await getPortalSettings(db, 'pa')).portalEnabledAt).toBeNull();
  });

  it('the default tenant on the shared number is ready once its template is set', async () => {
    await setPortalAuthTemplate(db, 'default', { name: 'login_otp', lang: 'en' }, 'staff:alice');
    expect(await setPortalEnabled(db, 'default', true, 'staff:alice', deps(SHARED))).toEqual({ ok: true });
  });

  it('enables (own channel + template), keeps the first enable time, disables; audited; B untouched', async () => {
    await setPortalAuthTemplate(db, 'pa', { name: 'login_otp', lang: 'en' }, 'staff:alice');
    expect(await setPortalEnabled(db, 'pa', true, 'staff:alice', deps(OWN))).toEqual({ ok: true });
    const first = (await getPortalSettings(db, 'pa')).portalEnabledAt;
    expect(first).toBeInstanceOf(Date);
    expect(await setPortalEnabled(db, 'pa', true, 'staff:alice', deps(OWN))).toEqual({ ok: true });
    expect((await getPortalSettings(db, 'pa')).portalEnabledAt?.getTime()).toBe(first!.getTime());
    expect((await getPortalSettings(db, 'pb')).portalEnabledAt).toBeNull();
    expect(await setPortalEnabled(db, 'pa', false, 'staff:alice')).toEqual({ ok: true });
    expect((await getPortalSettings(db, 'pa')).portalEnabledAt).toBeNull();
    expect(await auditRows(db, 'pa', 'partner.portal.enabled')).toHaveLength(2);
    expect(await auditRows(db, 'pa', 'partner.portal.disabled')).toHaveLength(1);
  });

  it('an integrations read that throws refuses (fail closed)', async () => {
    await setPortalAuthTemplate(db, 'pa', { name: 'login_otp', lang: 'en' }, 'staff:alice');
    const boom = { getIntegrations: async () => { throw new Error('db down'); } };
    expect(await setPortalEnabled(db, 'pa', true, 'staff:alice', boom)).toEqual({ ok: false, reason: 'not_ready' });
  });

  it('an unknown partner → not_found', async () => {
    expect(await setPortalEnabled(db, 'nope', false, 'staff:alice')).toEqual({ ok: false, reason: 'not_found' });
  });
});
