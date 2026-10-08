import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { PARTNER_ROUTES, partnerNav, routeAllows } from '@/app/partner/routes';
import { KNOWN_PARTNER_ROLES } from '@/lib/partner-access';

// UI redesign M3-2: the ONE route/policy table for /partner. The nav is derived from it, so the
// nav can never show a link the page refuses, and every registered route must have a page.
const pageFile = (href: string) =>
  href === '/partner' ? 'src/app/partner/(app)/page.tsx' : `src/app/partner/(app)${href.slice('/partner'.length)}/page.tsx`;

describe('PARTNER_ROUTES', () => {
  it('every registered route has a page (no dead nav links)', () => {
    for (const r of Object.values(PARTNER_ROUTES)) expect(existsSync(pageFile(r.href)), r.href).toBe(true);
  });
  it('home and security allow every role (the gate fallbacks can never loop)', () => {
    for (const role of KNOWN_PARTNER_ROLES) {
      expect(routeAllows('home', role)).toBe(true);
      expect(routeAllows('security', role)).toBe(true);
    }
  });
  it('partnerNav only lists routes the role may open', () => {
    for (const role of KNOWN_PARTNER_ROLES) {
      const nav = partnerNav(role);
      expect(nav.length).toBeGreaterThan(0);
      for (const r of nav) expect(r.policy.roles).toContain(role);
    }
  });
  it('the webhooks page is admin-only and out of the nav (M3-15a)', () => {
    for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows('integrationsWebhooks', role)).toBe(role === 'admin');
    expect(PARTNER_ROUTES.integrationsWebhooks.nav).toBe(false);
  });
  it('partnerNav keeps the fixed order, home first', () => {
    expect(partnerNav('admin').map((r) => r.href)).toEqual(['/partner', '/partner/onboarding', '/partner/transfers', '/partner/refunds', '/partner/schedules', '/partner/customers', '/partner/reviews', '/partner/reports', '/partner/analytics', '/partner/support', '/partner/staff', '/partner/audit', '/partner/integrations', '/partner/branding', '/partner/rewards', '/partner/settings', '/partner/security']);
    expect(partnerNav('support').map((r) => r.href)).toEqual(['/partner', '/partner/support', '/partner/security']);
    for (const role of ['agent', 'support', 'finance'] as const) expect(partnerNav(role).map((r) => r.href)).not.toContain('/partner/branding');
    expect(partnerNav('agent').map((r) => r.href)).not.toContain('/partner/audit');
    expect(partnerNav('support').map((r) => r.href)).not.toContain('/partner/customers');
    for (const role of ['support', 'finance'] as const) expect(partnerNav(role).map((r) => r.href)).not.toContain('/partner/staff');
  });
  it('lost-features A13: agents open Staff (a read-only roster); support and finance never', () => {
    for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows('staff', role)).toBe(role === 'admin' || role === 'agent');
    expect(partnerNav('agent').map((r) => r.href)).toContain('/partner/staff');
  });
  it('lost-features A5 and A6: New customer and Business invoices are admin-only and out of the nav', () => {
    expect(PARTNER_ROUTES.customersNew).toMatchObject({ href: '/partner/customers/new', labelKey: 'partner.customers.new', nav: false });
    expect(PARTNER_ROUTES.invoices).toMatchObject({ href: '/partner/invoices', labelKey: 'partner.nav.invoices', nav: false });
    for (const key of ['customersNew', 'invoices'] as const) {
      for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows(key, role), `${key}/${role}`).toBe(role === 'admin');
      for (const role of KNOWN_PARTNER_ROLES) expect(partnerNav(role).map((r) => r.href)).not.toContain(PARTNER_ROUTES[key].href);
    }
  });
  it('lost-features A8: the conversation log is admin-only and out of the nav', () => {
    expect(PARTNER_ROUTES.customerConversation).toMatchObject({ href: '/partner/customers/conversation', nav: false });
    for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows('customerConversation', role)).toBe(role === 'admin');
  });
  it('M3-20: onboarding is admin-only, in the nav right after home', () => {
    for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows('onboarding', role)).toBe(role === 'admin');
    expect(partnerNav('admin')[1].href).toBe('/partner/onboarding');
    for (const role of ['agent', 'support', 'finance'] as const) expect(partnerNav(role).map((r) => r.href)).not.toContain('/partner/onboarding');
  });
  it('M3-16: Reports is a money read (admin, agent, finance); support never sees it', () => {
    for (const role of ['admin', 'agent', 'finance'] as const) expect(partnerNav(role).map((r) => r.href)).toContain('/partner/reports');
    expect(partnerNav('support').map((r) => r.href)).not.toContain('/partner/reports');
  });
  it('merge plan 2d: Analytics is a money read (admin, agent, finance); support never sees it', () => {
    expect(PARTNER_ROUTES.analytics).toMatchObject({ href: '/partner/analytics', labelKey: 'partner.nav.analytics', nav: true });
    for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows('analytics', role)).toBe(role !== 'support');
    for (const role of ['admin', 'agent', 'finance'] as const) expect(partnerNav(role).map((r) => r.href)).toContain('/partner/analytics');
    expect(partnerNav('support').map((r) => r.href)).not.toContain('/partner/analytics');
  });
  it('2f: Settings is admin-only, in the nav right before security', () => {
    for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows('settings', role)).toBe(role === 'admin');
    const hrefs = partnerNav('admin').map((r) => r.href);
    expect(hrefs[hrefs.indexOf('/partner/security') - 1]).toBe('/partner/settings');
    for (const role of ['agent', 'support', 'finance'] as const) expect(partnerNav(role).map((r) => r.href)).not.toContain('/partner/settings');
  });
  it('merge plan 2a/2b: Schedules and Refunds are money reads (admin, agent, finance); support never sees them', () => {
    expect(PARTNER_ROUTES.schedules).toMatchObject({ href: '/partner/schedules', labelKey: 'partner.nav.schedules', nav: true });
    expect(PARTNER_ROUTES.refunds).toMatchObject({ href: '/partner/refunds', labelKey: 'partner.nav.refunds', nav: true });
    for (const key of ['schedules', 'refunds'] as const) {
      for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows(key, role)).toBe(role !== 'support');
      for (const role of ['admin', 'agent', 'finance'] as const) expect(partnerNav(role).map((r) => r.href)).toContain(PARTNER_ROUTES[key].href);
      expect(partnerNav('support').map((r) => r.href)).not.toContain(PARTNER_ROUTES[key].href);
    }
  });
  it('2c: Reviews is an ops page (admin, agent), right after Customers; finance and support never see it', () => {
    expect(PARTNER_ROUTES.reviews).toMatchObject({ href: '/partner/reviews', labelKey: 'partner.nav.reviews', nav: true });
    for (const role of KNOWN_PARTNER_ROLES) expect(routeAllows('reviews', role)).toBe(role === 'admin' || role === 'agent');
    for (const role of ['admin', 'agent'] as const) {
      const hrefs = partnerNav(role).map((r) => r.href);
      expect(hrefs[hrefs.indexOf('/partner/customers') + 1]).toBe('/partner/reviews');
    }
    for (const role of ['finance', 'support'] as const) expect(partnerNav(role).map((r) => r.href)).not.toContain('/partner/reviews');
  });
  it('an unknown role gets no nav at all (fails closed)', () => {
    expect(partnerNav('root' as never)).toEqual([]);
  });
  it('M3-6: finance gets home + security, and only routes whose policy admits finance', () => {
    const hrefs = partnerNav('finance').map((r) => r.href);
    expect(hrefs[0]).toBe('/partner');
    expect(hrefs).toContain('/partner/security');
    for (const r of partnerNav('finance')) expect(r.policy.roles).toContain('finance');
  });
  it('hrefs are static paths (no tenant, no query string)', () => {
    for (const r of Object.values(PARTNER_ROUTES)) expect(r.href).toMatch(/^\/partner(\/[a-z-]+)*$/);
  });
  it('the table is frozen (no runtime additions)', () => {
    expect(Object.isFrozen(PARTNER_ROUTES)).toBe(true);
  });
});
