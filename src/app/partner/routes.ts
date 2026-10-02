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
  // M3-20: the seven-step go-live checklist + request (admin only; SPEC §3.1).
  onboarding: { href: '/partner/onboarding', labelKey: 'partner.nav.onboarding', policy: PARTNER_ADMIN, nav: true },
  transfers: { href: '/partner/transfers', labelKey: 'partner.nav.transfers', policy: PARTNER_MONEY_READ, nav: true },
  customers: { href: '/partner/customers', labelKey: 'partner.nav.customers', policy: PARTNER_OPS, nav: true },
  // M3-16: the page is a money read; each report KIND is further gated by reportPolicy(kind).
  reports: { href: '/partner/reports', labelKey: 'partner.nav.reports', policy: PARTNER_MONEY_READ, nav: true },
  support: { href: '/partner/support', labelKey: 'partner.nav.support', policy: PARTNER_TICKETS, nav: true },
  supportContact: { href: '/partner/support/contact', labelKey: 'partner.nav.supportContact', policy: PARTNER_TICKETS, nav: false },
  security: { href: '/partner/security', labelKey: 'partner.nav.security', policy: PARTNER_ANY, nav: true },
  staff: { href: '/partner/staff', labelKey: 'partner.nav.staff', policy: PARTNER_ADMIN, nav: true },
  audit: { href: '/partner/audit', labelKey: 'partner.nav.audit', policy: PARTNER_ADMIN, nav: true },
  branding: { href: '/partner/branding', labelKey: 'partner.nav.branding', policy: PARTNER_ADMIN, nav: true },
  integrations: { href: '/partner/integrations', labelKey: 'partner.nav.integrations', policy: PARTNER_ADMIN, nav: true },
  integrationsWhatsapp: { href: '/partner/integrations/whatsapp', labelKey: 'partner.integrations.whatsapp.title', policy: PARTNER_ADMIN, nav: false },
  integrationsApiKeys: { href: '/partner/integrations/api-keys', labelKey: 'partner.integrations.apiKeys.title', policy: PARTNER_ADMIN, nav: false },
  integrationsWebhooks: { href: '/partner/integrations/webhooks', labelKey: 'partner.integrations.webhooks.title', policy: PARTNER_ADMIN, nav: false },
  // Merge plan 2d: charts over the tenant's live transfers (a money read).
  analytics: { href: '/partner/analytics', labelKey: 'partner.nav.analytics', policy: PARTNER_MONEY_READ, nav: true },
  // 2f: support portal, alert email, Reg E disclosure, read-only pricing margin (admin only).
  settings: { href: '/partner/settings', labelKey: 'partner.nav.settings', policy: PARTNER_ADMIN, nav: true },
  // Merge plan 2a/2b: money reads; every pause/resume/cancel and refund decision is PARTNER_ADMIN (D1).
  schedules: { href: '/partner/schedules', labelKey: 'partner.nav.schedules', policy: PARTNER_MONEY_READ, nav: true },
  refunds: { href: '/partner/refunds', labelKey: 'partner.nav.refunds', policy: PARTNER_MONEY_READ, nav: true },
} as const satisfies Record<string, PartnerRoute>);
export type PartnerRouteKey = keyof typeof PARTNER_ROUTES;

// The final order (UI M5): home, onboarding, transfers, refunds, schedules, reviews, customers, reports,
// analytics, support, staff, audit, integrations, branding, settings, security.
const NAV_ORDER: readonly PartnerRouteKey[] = ['home', 'onboarding', 'transfers', 'refunds', 'schedules', 'customers', 'reports', 'analytics', 'support', 'staff', 'audit', 'integrations', 'branding', 'settings', 'security'];

export function routeAllows(key: PartnerRouteKey, role: PartnerRole): boolean {
  return PARTNER_ROUTES[key].policy.roles.includes(role);
}

export function partnerNav(role: PartnerRole): PartnerRoute[] {
  return NAV_ORDER.filter((k) => PARTNER_ROUTES[k].nav && routeAllows(k, role)).map((k) => PARTNER_ROUTES[k]);
}
