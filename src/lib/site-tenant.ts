import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { parseSiteHost, SITE_HEADERS } from './site-host';

export interface SiteTenant {
  partnerId: string;
  slug: string;
  /** The canonical public host from parseSiteHost (rebuilt from the slug or the skin table), never the raw header. */
  host: string;
  /** true only on a custom skin host outside smartremit.ai (site-skins.ts `hosts`). */
  custom: boolean;
}

/**
 * The partner for THIS request's host, or null. Never read the tenant any other way.
 *
 * The proxy sets the x-sr-site-* headers; this reader trusts neither of them on its own:
 * - it re-parses Host, so any header on an apex / preview / localhost request is ignored (and the
 *   resolver is never called on apex);
 * - on a subdomain it requires the header slug to equal the Host slug (proof the proxy ran, so its
 *   route allowlist applied), then RE-RESOLVES the slug through the cached resolver and returns the
 *   tenant only if the header partner equals the resolved one. The tenant is therefore a function of
 *   Host alone, even if the platform ever skipped the proxy.
 * The re-resolve shares the proxy's 60 s cache (so a disabled partner is dropped within the TTL) and
 * uses a no-op limiter so the IP is not counted twice. Any failure → null (fail closed).
 * A custom skin host re-resolves skin-only (resolveSkinHost), exactly as the proxy does.
 */
export async function getSiteTenant(): Promise<SiteTenant | null> {
  const h = await headers();
  const site = parseSiteHost(h.get('host'));
  if (site.kind !== 'site') return null;
  const claimed = h.get(SITE_HEADERS.partner);
  if (!claimed || h.get(SITE_HEADERS.slug) !== site.slug) return null;
  try {
    const { resolveSiteSlug, resolveSkinHost } = await import('./site-tenant-resolver');
    const resolve = site.custom ? resolveSkinHost : resolveSiteSlug;
    const resolved = await resolve(site.slug, new Headers(h), { limited: async () => false });
    if (!resolved || resolved !== claimed) return null;
    return { partnerId: resolved, slug: site.slug, host: site.host, custom: site.custom };
  } catch {
    return null;
  }
}

/** getSiteTenant() or a 404 (apex, unknown, disabled, or a request the proxy did not vouch for). */
export async function requireSiteTenant(): Promise<SiteTenant> {
  return (await getSiteTenant()) ?? notFound();
}
