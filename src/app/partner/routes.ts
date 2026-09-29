import { PARTNER_ADMIN, PARTNER_ANY, PARTNER_MONEY_READ, PARTNER_OPS, PARTNER_TICKETS, type PartnerPolicy, type PartnerRole } from '@/lib/partner-access';
import type { MessageKey } from '@/lib/i18n';

// The ONE access table for /partner (UI redesign M3). Pages call
// requirePartnerStaff(PARTNER_ROUTES.<key>.policy); the shell renders partnerNav(role). The nav is
// derived from the same policy the page enforces, so it can never show a link the page refuses.
// Hiding a link is never the guard: every page re-gates. A later change adds its key here in the
// SAME change as its page.tsx (tests/partner-routes.test.ts fails on a key without a page).
export interface PartnerRoute {
  href: `/partner${string}`;
  labelKey: MessageKey;
  policy: PartnerPolicy;
  nav: boolean;
}

export const PARTNER_ROUTES = Object.freeze({
  home: { href: '/partner', labelKey: 'partner.nav.home', policy: PARTNER_ANY, nav: true },
  transfers: { href: '/partner/transfers', labelKey: 'partner.nav.transfers', policy: PARTNER_MONEY_READ, nav: true },
  customers: { href: '/partner/customers', labelKey: 'partner.nav.customers', policy: PARTNER_OPS, nav: true },
  support: { href: '/partner/support', labelKey: 'partner.nav.support', policy: PARTNER_TICKETS, nav: true },
  supportContact: { href: '/partner/support/contact', labelKey: 'partner.nav.supportContact', policy: PARTNER_TICKETS, nav: false },
  security: { href: '/partner/security', labelKey: 'partner.nav.security', policy: PARTNER_ANY, nav: true },
  staff: { href: '/partner/staff', labelKey: 'partner.nav.staff', policy: PARTNER_ADMIN, nav: true },
  audit: { href: '/partner/audit', labelKey: 'partner.nav.audit', policy: PARTNER_ADMIN, nav: true },
  branding: { href: '/partner/branding', labelKey: 'partner.nav.branding', policy: PARTNER_ADMIN, nav: true },
  integrations: { href: '/partner/integrations', labelKey: 'partner.nav.integrations', policy: PARTNER_ADMIN, nav: true },
  integrationsWhatsapp: { href: '/partner/integrations/whatsapp', labelKey: 'partner.integrations.whatsapp.title', policy: PARTNER_ADMIN, nav: false },
  integrationsApiKeys: { href: '/partner/integrations/api-keys', labelKey: 'partner.integrations.apiKeys.title', policy: PARTNER_ADMIN, nav: false },
} as const satisfies Record<string, PartnerRoute>);
export type PartnerRouteKey = keyof typeof PARTNER_ROUTES;

// Final order once every page exists: home, onboarding, transfers, customers, reports, support,
// staff, audit, integrations, branding, security.
const NAV_ORDER: readonly PartnerRouteKey[] = ['home', 'transfers', 'customers', 'support', 'staff', 'audit', 'integrations', 'branding', 'security'];

export function routeAllows(key: PartnerRouteKey, role: PartnerRole): boolean {
  return PARTNER_ROUTES[key].policy.roles.includes(role);
}

export function partnerNav(role: PartnerRole): PartnerRoute[] {
  return NAV_ORDER.filter((k) => PARTNER_ROUTES[k].nav && routeAllows(k, role)).map((k) => PARTNER_ROUTES[k]);
}
