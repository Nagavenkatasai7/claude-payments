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
vi.mock('@/lib/portal-auth', async (orig) => ({
  getPortalCustomer: async () => h.customer,
  requirePortalCustomer: async () => h.customer,
  // The REAL allow-list: the sign-in page's ?next= handling is pinned against it (C1).
  safePortalNext: (await orig<typeof import('@/lib/portal-auth')>()).safePortalNext,
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));

import PortalLayout, { dynamic as layoutDynamic } from '@/app/portal/layout';
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
  it('is request-time only (never prerendered: a build-time 404 would outlive the flag switch)', () => {
    expect(layoutDynamic).toBe('force-dynamic');
  });
  it('apex / portal off → the gate 404s before anything renders', async () => {
    h.site = null;
    await expect(PortalLayout({ children: null })).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
  // 2026-10-04: SmartRemit is the only brand. Even a site object carrying a partner theme, logo and
  // brand (portal-site no longer produces one) renders the SmartRemit.ai logo and no theme override.
  it('the SmartRemit.ai logo (never the partner logo, name or theme), lang, main landmark and skip link', async () => {
    const html = await renderLayout();
    expect(html).not.toContain('<style>');
    expect(html).toMatch(/<img[^>]*alt="SmartRemit.ai"/);
    expect(html).toContain('smartremit-lockup.png');
    expect(html).not.toContain('Acme Remit');
    expect(html).not.toContain(LOGO);
    expect(html).toContain('class="ds-site" lang="en"');
    expect(html).toContain('id="main"');
    expect(html).toContain('href="#main"');
    expect(html).toContain('<p>child</p>');
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
  const noQuery = () => ({ searchParams: Promise.resolve({}) });
  it('renders the page title hook, the brand line and the phone step', async () => {
    const html = renderToStaticMarkup(await PortalLoginPage(noQuery()));
    expect(html).toContain('sh-page-title');
    expect(html).toContain('>Sign in</h1>');
    expect(html).toContain('from Acme Remit');
    expect(html).toContain('name="phone"');
    expect(html).toContain('type="tel"');
    expect(html).not.toContain('name="pending"');
    expect(html).not.toContain('data-from-account');
  });
  it('?from=account (the legacy password sign-in handed over) shows the fixed passwords-retired notice', async () => {
    const html = renderToStaticMarkup(await PortalLoginPage({ searchParams: Promise.resolve({ from: 'account' }) }));
    expect(html).toContain('data-from-account');
    expect(html).toContain('Passwords are retired.');
    const other = renderToStaticMarkup(await PortalLoginPage({ searchParams: Promise.resolve({ from: '<b>x</b>' }) }));
    expect(other).not.toContain('data-from-account');
    expect(other).not.toContain('<b>x</b>');
  });
  it('an already signed-in customer is sent to /portal', async () => {
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    await expect(PortalLoginPage(noQuery())).rejects.toThrow('REDIRECT:/portal');
  });
  it('apex → 404', async () => {
    h.site = null;
    await expect(PortalLoginPage(noQuery())).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });
  it('C1: a signed-in customer with a safe ?next= goes there; a hostile one goes to /portal', async () => {
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    await expect(PortalLoginPage({ searchParams: Promise.resolve({ next: '/portal/transfers' }) })).rejects.toThrow('REDIRECT:/portal/transfers');
    await expect(PortalLoginPage({ searchParams: Promise.resolve({ next: '//evil.example' }) })).rejects.toThrow(/^REDIRECT:\/portal$/);
    await expect(PortalLoginPage({ searchParams: Promise.resolve({ next: ['/portal/help', '/portal/chat'] }) })).rejects.toThrow(/^REDIRECT:\/portal$/);
  });
  it('C1: the form carries the safe next as a hidden field, never a hostile one', async () => {
    const html = renderToStaticMarkup(await PortalLoginPage({ searchParams: Promise.resolve({ next: '/portal/help/tickets/tk_Abc-_1' }) }));
    expect(html).toContain('name="next" value="/portal/help/tickets/tk_Abc-_1"');
    const bad = renderToStaticMarkup(await PortalLoginPage({ searchParams: Promise.resolve({ next: 'https://evil.example/"><script>' }) }));
    expect(bad).toContain('name="next" value="/portal"');
    expect(bad).not.toContain('evil.example');
  });
});
