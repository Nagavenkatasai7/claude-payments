import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Owner, 2026-10-11: "Contact us" on the portal. The page opens without sign-in (a visitor who cannot
// sign in still reaches the company), shows WhatsApp first, then the email and the mailing address
// as text, and offers a support request only to a signed-in customer whose partner has support on.

const h = vi.hoisted(() => ({
  site: null as null | Record<string, unknown>,
  customer: null as null | Record<string, unknown>,
  supportOn: true,
}));
vi.mock('@/lib/portal-site', () => ({
  requirePortalSite: async () => {
    if (!h.site) throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
    return h.site;
  },
}));
vi.mock('@/lib/portal-auth', () => ({ getPortalCustomer: async () => h.customer }));
vi.mock('@/lib/portal-tickets', () => ({ portalSupportEnabled: async () => h.supportOn }));

import PortalContactPage from '@/app/portal/contact/page';
import { WA_PHONE, formatWaPhone } from '@/app/landing/wa';

const SITE = { partnerId: 'pa', slug: 'acme', brand: 'SmartRemit' };
const render = async () => renderToStaticMarkup(await PortalContactPage());

beforeEach(() => {
  h.site = { ...SITE };
  h.customer = null;
  h.supportOn = true;
});

describe('/portal/contact', () => {
  it('apex / portal off → 404', async () => {
    h.site = null;
    await expect(PortalContactPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('signed out: the page title hook, WhatsApp first, then the email and the mailing address', async () => {
    const html = await render();
    expect(html).toContain('sh-page-title');
    expect(html).toContain('Contact us');
    const wa = html.indexOf(formatWaPhone(WA_PHONE));
    const email = html.indexOf('support@smartremit.ai');
    const address = html.indexOf('SR Technosolutions Inc');
    expect(wa).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(wa);
    expect(address).toBeGreaterThan(email);
    expect(html).toContain('16514 NW 3rd St');
    expect(html).toContain('Pembroke Pines, FL 33028');
    expect(html).toContain(`https://api.whatsapp.com/send/?phone=${WA_PHONE}`);
  });

  it('signed out: points to sign-in for a support request, never to the ticket form', async () => {
    const html = await render();
    expect(html).toContain('href="/portal/login?next=%2Fportal%2Fhelp"');
    expect(html).not.toContain('/portal/help/tickets/new');
  });

  it('signed in with support on: a new support request and the chat', async () => {
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    const html = await render();
    expect(html).toContain('href="/portal/help/tickets/new"');
    expect(html).toContain('href="/portal/chat"');
    expect(html).not.toContain('/portal/login');
  });

  it('signed in with support off: the chat only, no ticket form', async () => {
    h.customer = { customer: {}, session: {}, site: SITE, token: 'x' };
    h.supportOn = false;
    const html = await render();
    expect(html).not.toContain('/portal/help/tickets/new');
    expect(html).toContain('href="/portal/chat"');
  });

  it('shows the email as text, never as a mailto: link (email delivery is not confirmed)', async () => {
    expect(await render()).not.toContain('mailto:');
  });
});
