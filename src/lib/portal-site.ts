import { cache } from 'react';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { getSiteTenant } from './site-tenant';
import { getPortalSettings } from '@/db/repos/portal-settings-repo';
import { getPartnerStore } from './partner-store';
import { resolvePartnerBranding } from './partner-config';
import { env } from './env';
import { resolveSiteTheme, type SiteTheme } from './ui/theme';
import { siteSkinFor } from './site-skins';
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
 *
 * Site skins (owner go 2026-11-09, src/lib/site-skins.ts): on a skin host (tgfl.smartremit.ai) the
 * tenant is the skin's EXISTING tenant, and the same four checks apply to that tenant. The site then
 * carries `skin`, which only the portal chrome reads (layout header, demo line, footer line, tab
 * title). `brand`, `logo` and `theme` do not change: every text that names the sender of a code, a
 * message or a receipt keeps saying SmartRemit.
 */

/** What a skin host shows in the portal chrome. Display only: never a tenant, never a sender name. */
export interface PortalSkin {
  name: string;
  /** A path under /brand/partners/ (the layout re-checks it with skinLogoSrc), or null for text. */
  logoSrc: string | null;
  /** Skin colours (the layout re-validates them), or null for SmartRemit's. */
  theme: { primary: string; accent: string } | null;
  /** true shows the demo line on every portal page. */
  demo: boolean;
}

export interface PortalSite {
  partnerId: PartnerId;
  slug: string;
  /**
   * The canonical public host from parseSiteHost's code table (`<slug>.smartremit.ai`, or a custom
   * skin host such as smartremitai.tgfl.org), never the raw header: the OAuth issuer, the MCP
   * resource, verify links and the credential binding use it.
   */
  host: string;
  /** The end-customer brand: always SmartRemit (resolvePartnerBranding, 2026-10-04), on a skin host too. */
  brand: string;
  /** Always null: a PARTNER's logo is never shown (2026-10-04). A skin's logo lives in `skin`. */
  logo: unknown;
  /** Always the SmartRemit default colours: a partner's colours are not applied (2026-10-04). */
  theme: SiteTheme;
  /**
   * The skin of this host, or null. getPortalSite() always sets it; it is optional only so objects
   * built elsewhere (tests) need not name it. Read it as "no skin" when absent.
   */
  skin?: PortalSkin | null;
}

async function loadPortalSite(): Promise<PortalSite | null> {
  // The Host read comes FIRST: it makes every portal route request-time (a flag check first would
  // let the build prerender the 404 statically and serve it after the flag is switched on).
  const tenant = await getSiteTenant();
  if (!tenant || !env.customerPortalEnabled) return null;
  try {
    const db = getDb();
    const settings = await getPortalSettings(db, tenant.partnerId);
    if (!settings.portalEnabledAt) return null;
    const partner = await getPartnerStore().getPartner(tenant.partnerId);
    if (!partner || partner.status !== 'active') return null;
    // Only when the host resolved to the skin's own tenant: a real partner on that slug gets none.
    const skin = siteSkinFor(tenant.slug, tenant.partnerId);
    return {
      partnerId: tenant.partnerId,
      slug: tenant.slug,
      host: tenant.host,
      brand: resolvePartnerBranding(partner).brand,
      logo: null,
      theme: resolveSiteTheme({}),
      skin: skin ? { name: skin.name, logoSrc: skin.logoSrc, theme: skin.theme, demo: skin.demo } : null,
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
