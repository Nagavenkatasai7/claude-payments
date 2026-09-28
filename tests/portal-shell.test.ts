import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI redesign M2-5, Task 5.7: the portal shell and the sign-in page (render tests; the UI itself is
// verified by the env-gated smoke once DNS exists).

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  customer: null as null | Record<string, unknown>,
}));
vi.mock('@/lib/portal-site', () => ({
  getPortalSite: async () => h.site,
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/portal-auth', () => ({
  getPortalCustomer: async () => h.customer,
  requirePortalCustomer: async () => h.customer,
  safePortalNext: (v: unknown) => (v === '/portal/send' ? v : '/portal'),
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));

import PortalLayout from '@/app/portal/layout';
import PortalLoginPage from '@/app/portal/login/page';
import { portalNavItems, showLanguageSwitch } from '@/lib/portal-nav';

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SITE = { partnerId: 'pa', slug: 'acme', brand: 'Acme Remit', logo: LOGO, theme: { primary: '#0f766e', accent: '#1d4ed8', primaryFromPartner: true, accentFromPartner: true } };

async function renderLayout() {
  const el = await PortalLayout({ children: createElement('p', null, 'child') });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  h.site = { ...SITE };
  h.customer = null;
});
afterEach(() => vi.unstubAllEnvs());

describe('portal layout', () => {
  it('apex / portal off → the gate 404s before anything renders', async () => {
    h.site = null;
    await expect(PortalLayout({ children: null })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
  it('partner theme + brand logo (img alt = brand), lang, main landmark and skip link', async () => {
    const html = await renderLayout();
    expect(html).toContain('<style>.ds-site{--ds-primary:#0f766e');
    expect(html).toMatch(/<img[^>]*alt="Acme Remit"/);
    expect(html).toContain('class="ds-site" lang="en"');
    expect(html).toContain('id="main"');
    expect(html).toContain('href="#main"');
    expect(html).toContain('<p>child</p>');
  });
  it('no logo → the brand as text', async () => {
    h.site = { ...SITE, logo: null };
    expect(await renderLayout()).toContain('>Acme Remit</span>');
  });
  it('signed out: no nav, no sign-out (the sign-in page lives under the layout)', async () => {
    const html = await renderLayout();
    expect(html).not.toContain('sh-sidebar');
    expect(html).not.toContain('Sign out');
  });
  it('signed in: aside.sh-sidebar with the nav and a sign-out form; no Privacy link while the flag is off', async () => {
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    const html = await renderLayout();
    expect(html).toMatch(/<aside class="sh-sidebar[^"]*"/);
    for (const label of ['Home', 'Send', 'Transfers', 'Recipients', 'Schedules', 'Chat', 'Help', 'Profile', 'Notifications', 'Devices']) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html).not.toContain('/portal/privacy');
    expect(html).toContain('Sign out');
  });
  it('the Privacy link appears only with CUSTOMER_DATA_RIGHTS_ENABLED=1', async () => {
    vi.stubEnv('CUSTOMER_DATA_RIGHTS_ENABLED', '1');
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    expect(await renderLayout()).toContain('href="/portal/privacy"');
    expect(portalNavItems(false).some((i) => i.href === '/portal/privacy')).toBe(false);
  });
  it('D5: no language switch while only the en catalogue exists', async () => {
    expect(showLanguageSwitch()).toBe(false);
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    expect(await renderLayout()).not.toMatch(/lang(uage)?-switch|hreflang/i);
  });
});

describe('portal sign-in page', () => {
  it('renders the page title hook, the brand line and the phone step', async () => {
    const html = renderToStaticMarkup(await PortalLoginPage());
    expect(html).toContain('sh-page-title');
    expect(html).toContain('>Sign in</h1>');
    expect(html).toContain('from Acme Remit');
    expect(html).toContain('name="phone"');
    expect(html).toContain('type="tel"');
    expect(html).not.toContain('name="pending"');
  });
  it('an already signed-in customer is sent to /portal', async () => {
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    await expect(PortalLoginPage()).rejects.toThrow('REDIRECT:/portal');
  });
  it('apex → 404', async () => {
    h.site = null;
    await expect(PortalLoginPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
});
