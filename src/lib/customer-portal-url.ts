// customer-portal-url (one customer portal, Oct 2) — where a partner's LIVE customer portal lives,
// so the legacy apex /account can hand its customers over to it.
//
// SERVER-ONLY (db + env). The origin is https://<slug>.smartremit.ai when ALL hold, else null:
//   1. CUSTOMER_PORTAL_ENABLED=1 (env.customerPortalEnabled; checked first, no db work when off);
//   2. partner_portal_settings.portal_enabled_at is set (as src/lib/portal-site.ts loadPortalSite);
//   3. the partner exists and is active (as portal-site.ts);
//   4. partner_sites has a servable slug (isHandoffSlug: the DB format and the DNS '??--' rule).
// Any error is null too: FAIL-CLOSED to "no portal", which keeps the legacy /account behaviour
// (answer 5: partners without a portal keep /account).
//
// Tenant safety: one partner, by the caller's server-derived partner id (a session or a ticket
// row, never request input), through the tenant-scoped readers. Read-only.
import { env } from '@/lib/env';
import { getDb, type DbOrTx } from '@/db/client';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { getPartnerSite } from '@/db/repos/partner-site-repo';
import { getPortalSettings } from '@/db/repos/portal-settings-repo';
import { isHandoffSlug } from '@/lib/send-handoff';
import { logWarn } from '@/lib/log';

/** The live portal origin for a partner, or null. Never throws. */
export async function resolveCustomerPortalOrigin(
  partnerId: string,
  deps: { enabled?: boolean; db?: DbOrTx } = {},
): Promise<string | null> {
  if (!(deps.enabled ?? env.customerPortalEnabled)) return null;
  try {
    const db = deps.db ?? getDb();
    const settings = await getPortalSettings(db, partnerId);
    if (!settings.portalEnabledAt) return null;
    const partner = await createPartnerRepo(db).getPartner(partnerId);
    if (!partner || partner.status !== 'active') return null;
    const slug = (await getPartnerSite(db, partnerId))?.slug;
    if (!isHandoffSlug(slug)) return null;
    return `https://${slug}.smartremit.ai`;
  } catch (err) {
    logWarn('customer-portal-url', err instanceof Error ? err.name : 'error');
    return null;
  }
}

/**
 * Per-instance memo TTL, the site resolver's cadence (SITE_CACHE_TTL_SEC in src/lib/site-host.ts):
 * the bot asks on every transfer-list reply, and a portal switch shows within a minute.
 */
export const CUSTOMER_PORTAL_TTL_MS = 60_000;

const memo = new Map<string, { at: number; value: Promise<string | null> }>();

/** Tests only: drop the memo. */
export function resetCustomerPortalOriginCache(): void {
  memo.clear();
}

/** What callers use: resolveCustomerPortalOrigin, memoised per partner (nulls included). */
export function customerPortalOrigin(
  partnerId: string,
  deps: { resolve?: (partnerId: string) => Promise<string | null>; now?: () => number } = {},
): Promise<string | null> {
  const now = (deps.now ?? Date.now)();
  const hit = memo.get(partnerId);
  if (hit && now - hit.at < CUSTOMER_PORTAL_TTL_MS) return hit.value;
  const value = (deps.resolve ?? ((id: string) => resolveCustomerPortalOrigin(id)))(partnerId);
  memo.set(partnerId, { at: now, value });
  return value;
}

/** origin + a /portal path. */
export function portalUrl(origin: string, path: `/portal${string}`): string {
  return `${origin}${path}`;
}

/** The apex base + an /account path (the legacy view, for partners without a portal). */
export function legacyCustomerUrl(appBaseUrl: string, path: `/account${string}`): string {
  return `${appBaseUrl}${path}`;
}

type LinkDeps = { origin?: (partnerId: string) => Promise<string | null>; appBaseUrl?: string };

/** The customer's "all my transfers" link: the portal's Transfers when live, else /account/history. */
export async function customerHistoryUrl(partnerId: string, deps: LinkDeps = {}): Promise<string> {
  const origin = await (deps.origin ?? customerPortalOrigin)(partnerId);
  return origin
    ? portalUrl(origin, '/portal/transfers')
    : legacyCustomerUrl(deps.appBaseUrl ?? env.appBaseUrl, '/account/history');
}

/** The customer's link to one support ticket: the portal's Help ticket when live, else /account/support/<id>. */
export async function customerTicketUrl(partnerId: string, ticketId: string, deps: LinkDeps = {}): Promise<string> {
  const id = encodeURIComponent(ticketId);
  const origin = await (deps.origin ?? customerPortalOrigin)(partnerId);
  return origin
    ? portalUrl(origin, `/portal/help/tickets/${id}`)
    : legacyCustomerUrl(deps.appBaseUrl ?? env.appBaseUrl, `/account/support/${id}`);
}
