import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// UI redesign M2-5, Task 5.1: the dark-by-default portal gate. getPortalSite() is non-null ONLY when
// the host is a partner site, CUSTOMER_PORTAL_ENABLED=1, the partner's portal_enabled_at is set and
// the partner is active. Any read that throws → null (fail closed).

const h = vi.hoisted(() => ({
  tenant: null as null | { partnerId: string; slug: string },
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
  loadSiteTheme: async () => ({ primary: '#0c5bd2', accent: '#0e7490', primaryFromPartner: false, accentFromPartner: false }),
}));
vi.mock('@/db/client', () => ({ getDb: () => ({}) }));

import { getPortalSite, requirePortalSite } from '@/lib/portal-site';

beforeEach(() => {
  h.tenant = { partnerId: 'pa', slug: 'acme' };
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
    expect(s).toMatchObject({ partnerId: 'pa', slug: 'acme', brand: 'Acme Remit', logo: null });
    expect(s?.theme.primary).toBe('#0c5bd2');
  });
  it('apex host → null', async () => {
    h.tenant = null;
    expect(await getPortalSite()).toBeNull();
  });
  it('flag off → null, and no DB read happens', async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '');
    expect(await getPortalSite()).toBeNull();
    expect(h.calls).not.toContain('settings');
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
