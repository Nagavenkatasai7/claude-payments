import { cache } from 'react';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { loadSiteTheme } from '@/db/repos/partner-site-repo';
import { getSiteTenant } from './site-tenant';
import { getPortalSettings } from '@/db/repos/portal-settings-repo';
import { getPartnerStore } from './partner-store';
import { resolvePartnerBranding } from './partner-config';
import { env } from './env';
import type { SiteTheme } from './ui/theme';
import type { PartnerId } from './types';

/**
 * portal-site — the customer portal's DARK-BY-DEFAULT gate (UI redesign M2-5, Task 5.1).
 *
 * getPortalSite() is non-null only when ALL hold:
 *  1. the Host is a partner site (getSiteTenant(): the tenant is a function of the Host alone);
 *  2. CUSTOMER_PORTAL_ENABLED=1 (env.customerPortalEnabled);
 *  3. partner_portal_settings.portal_enabled_at is set for that partner;
 *  4. the partner is `active`.
 * Any read that throws → null (fail closed). The partner is NEVER read from a query, body, cookie
 * field or route param.
 *
 * Every portal page, layout, action and route handler calls requirePortalSite() FIRST; notFound()
 * works in Server Components, Server Functions and Route Handlers
 * (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/not-found.md:15).
 *
 * `cache()` dedupes the reads within one server render (layout + page).
 */

export interface PortalSite {
  partnerId: PartnerId;
  slug: string;
  /** The end-customer brand (displayName → brandName → SmartRemit). */
  brand: string;
  /** The stored logo value; SiteBrand re-checks it before it becomes an <img src>. */
  logo: unknown;
  theme: SiteTheme;
}

async function loadPortalSite(): Promise<PortalSite | null> {
  if (!env.customerPortalEnabled) return null;
  const tenant = await getSiteTenant();
  if (!tenant) return null;
  try {
    const db = getDb();
    const settings = await getPortalSettings(db, tenant.partnerId);
    if (!settings.portalEnabledAt) return null;
    const partner = await getPartnerStore().getPartner(tenant.partnerId);
    if (!partner || partner.status !== 'active') return null;
    const theme = await loadSiteTheme(db, tenant.partnerId);
    return {
      partnerId: tenant.partnerId,
      slug: tenant.slug,
      brand: resolvePartnerBranding(partner).brand,
      logo: partner.logoUrl ?? null,
      theme,
    };
  } catch {
    return null;
  }
}

export const getPortalSite: () => Promise<PortalSite | null> = cache(loadPortalSite);

/** getPortalSite() or a 404 (apex, flag off, not enabled, suspended, or any error). */
export async function requirePortalSite(): Promise<PortalSite> {
  return (await getPortalSite()) ?? notFound();
}
