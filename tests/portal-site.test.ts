import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// UI redesign M2-5, Task 5.1: the dark-by-default portal gate. getPortalSite() is non-null ONLY when
// the host is a partner site, CUSTOMER_PORTAL_ENABLED=1, the partner's portal_enabled_at is set and
// the partner is active. Any read that throws → null (fail closed).

const h = vi.hoisted(() => ({
  tenant: null as null | { partnerId: string; slug: string; host: string; custom: boolean },
  settings: { authTemplateName: 'login_otp', authTemplateLang: 'en', portalEnabledAt: new Date() as Date | null },
  partner: { id: 'pa', status: 'active', displayName: 'Acme Remit', logoUrl: undefined as string | undefined } as Record<string, unknown> | null,
  settingsThrows: false,
  partnerThrows: false,
  calls: [] as string[],
}));
vi.mock('@/lib/site-tenant', () => ({ getSiteTenant: async () => (h.calls.push('tenant'), h.tenant) }));
vi.mock('@/db/repos/portal-settings-repo', () => ({
  getPortalSettings: async () => {
    h.calls.push('settings');
    if (h.settingsThrows) throw new Error('db down');
    return h.settings;
  },
}));
vi.mock('@/lib/partner-store', () => ({
  getPartnerStore: () => ({
    getPartner: async () => {
      h.calls.push('partner');
      if (h.partnerThrows) throw new Error('db down');
      return h.partner;
    },
  }),
}));
vi.mock('@/db/repos/partner-site-repo', () => ({
  loadSiteTheme: async () => ({ primary: '#123456', accent: '#654321', primaryFromPartner: true, accentFromPartner: true }),
}));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));

import { getPortalSite, requirePortalSite } from '@/lib/portal-site';

beforeEach(() => {
  h.tenant = { partnerId: 'pa', slug: 'acme', host: 'acme.smartremit.ai', custom: false };
  h.settings = { authTemplateName: 'login_otp', authTemplateLang: 'en', portalEnabledAt: new Date() };
  h.partner = { id: 'pa', status: 'active', displayName: 'Acme Remit', logoUrl: undefined };
  h.settingsThrows = false;
  h.partnerThrows = false;
  h.calls = [];
  vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1');
});
afterEach(() => vi.unstubAllEnvs());

describe('getPortalSite', () => {
  it('all four hold → the site (tenant from the host, brand, theme)', async () => {
    const s = await getPortalSite();
    expect(s).toMatchObject({ partnerId: 'pa', slug: 'acme', brand: 'SmartRemit', logo: null });
    expect(s?.theme.primary).toBe('#0c5bd2');
  });
  it('a partner logo and colours never reach the portal (SmartRemit branding, 2026-10-04)', async () => {
    h.partner = { id: 'pa', status: 'active', displayName: 'Acme Remit', logoUrl: 'data:image/png;base64,AAAA', primaryColor: '#123456' };
    const s = await getPortalSite();
    expect(s).toMatchObject({ brand: 'SmartRemit', logo: null });
    expect(s?.theme).toEqual({ primary: '#0c5bd2', accent: '#0e7490', primaryFromPartner: false, accentFromPartner: false });
  });
  // Site skins (owner go 2026-11-09): tgfl.smartremit.ai is a LOOK over SmartRemit's own tenant.
  it('an ordinary site carries no skin', async () => {
    expect((await getPortalSite())?.skin).toBeNull();
  });
  it('the skin host served by the skin\'s tenant → the skin (name, logo, no colours yet), and the brand STAYS SmartRemit', async () => {
    h.tenant = { partnerId: 'default', slug: 'tgfl', host: 'tgfl.smartremit.ai', custom: false };
    h.partner = { id: 'default', status: 'active' };
    const s = await getPortalSite();
    // brand feeds the sign-in code text, the WhatsApp consent label, receipts and the MFA issuer:
    // they come from SmartRemit's number and mail, so they must keep naming SmartRemit.
    expect(s).toMatchObject({ partnerId: 'default', slug: 'tgfl', brand: 'SmartRemit', logo: null });
    expect(s?.skin).toEqual({ name: 'TGFL', logoSrc: '/brand/partners/tgfl.png', logoSize: { width: 150, height: 100 }, theme: null, demo: true });
    expect(s?.theme.primary).toBe('#0c5bd2');
  });
  it('a real partner that holds the skin slug gets NO skin (the partner wins)', async () => {
    h.tenant = { partnerId: 'pa', slug: 'tgfl', host: 'tgfl.smartremit.ai', custom: false };
    expect((await getPortalSite())?.skin).toBeNull();
  });
  it('the skin\'s tenant on its own address (send) gets no skin', async () => {
    h.tenant = { partnerId: 'default', slug: 'send', host: 'send.smartremit.ai', custom: false };
    h.partner = { id: 'default', status: 'active' };
    expect((await getPortalSite())?.skin).toBeNull();
  });
  it('the skin host follows the tenant\'s portal gate: tenant portal off or tenant suspended → null', async () => {
    h.tenant = { partnerId: 'default', slug: 'tgfl', host: 'tgfl.smartremit.ai', custom: false };
    h.partner = { id: 'default', status: 'active' };
    h.settings = { ...h.settings, portalEnabledAt: null };
    expect(await getPortalSite()).toBeNull();
    h.settings = { ...h.settings, portalEnabledAt: new Date() };
    h.partner = { id: 'default', status: 'suspended' };
    expect(await getPortalSite()).toBeNull();
  });
  // TGFL custom host (design D7): the canonical host travels from parseSiteHost through the tenant.
  it('the site carries the canonical host of the tenant', async () => {
    expect((await getPortalSite())?.host).toBe('acme.smartremit.ai');
  });
  it('send → host send.smartremit.ai, no skin', async () => {
    h.tenant = { partnerId: 'default', slug: 'send', host: 'send.smartremit.ai', custom: false };
    h.partner = { id: 'default', status: 'active' };
    const s = await getPortalSite();
    expect(s?.host).toBe('send.smartremit.ai');
    expect(s?.skin).toBeNull();
  });
  it('the custom host → the TGFL skin and host smartremitai.tgfl.org (the same logo)', async () => {
    h.tenant = { partnerId: 'default', slug: 'tgfl', host: 'smartremitai.tgfl.org', custom: true };
    h.partner = { id: 'default', status: 'active' };
    const s = await getPortalSite();
    expect(s).toMatchObject({ partnerId: 'default', slug: 'tgfl', host: 'smartremitai.tgfl.org', brand: 'SmartRemit', logo: null });
    expect(s?.skin).toEqual({ name: 'TGFL', logoSrc: '/brand/partners/tgfl.png', logoSize: { width: 150, height: 100 }, theme: null, demo: true });
    // `custom` stays on SiteTenant: PortalSite never carries it (design D2).
    expect(s && 'custom' in s).toBe(false);
  });
  it('apex host → null', async () => {
    h.tenant = null;
    expect(await getPortalSite()).toBeNull();
  });
  it('flag off → null, and no DB read happens (the Host is read first: request-time, never prerendered)', async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '');
    expect(await getPortalSite()).toBeNull();
    expect(h.calls).toEqual(['tenant']);
  });
  it('partner not enabled → null', async () => {
    h.settings = { ...h.settings, portalEnabledAt: null };
    expect(await getPortalSite()).toBeNull();
  });
  it.each(['suspended', 'disabled', 'pending'])('partner %s → null', async (status) => {
    h.partner = { ...h.partner, status };
    expect(await getPortalSite()).toBeNull();
  });
  it('partner missing → null', async () => {
    h.partner = null;
    expect(await getPortalSite()).toBeNull();
  });
  it('a settings or partner read that throws → null (fail closed)', async () => {
    h.settingsThrows = true;
    expect(await getPortalSite()).toBeNull();
    h.settingsThrows = false;
    h.partnerThrows = true;
    expect(await getPortalSite()).toBeNull();
  });
});

describe('requirePortalSite', () => {
  it('returns the site when open', async () => {
    expect((await requirePortalSite()).partnerId).toBe('pa');
  });
  it.each([
    ['apex', () => { h.tenant = null; }],
    ['flag off', () => vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '')],
    ['not enabled', () => { h.settings = { ...h.settings, portalEnabledAt: null }; }],
    ['suspended', () => { h.partner = { ...h.partner, status: 'suspended' }; }],
  ])('%s → 404', async (_l, arrange) => {
    arrange();
    await expect(requirePortalSite()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
