// site-host — the ONE host contract for partner subdomains (<slug>.smartremit.ai).
//
// PURE and dependency-free: src/proxy.ts imports it on every matched request, so it must never pull
// Redis, the DB or anything with I/O into the proxy's hot path.
//
// Three results:
// - site:    EXACTLY `<valid slug>.smartremit.ai` (after lowercasing and stripping a port).
// - apex:    the platform itself (smartremit.ai and www.smartremit.ai, with or without a trailing
//            dot) and every host outside smartremit.ai (*.vercel.app previews, localhost, IPs,
//            look-alike domains, a missing Host). Apex runs the legacy app unchanged.
// - refused: every other *.smartremit.ai host (reserved labels, ??-- labels, bad lengths or edges,
//            multi-label names, the trailing-dot form of a slug). The proxy answers 404; the apex
//            app is never served on such a host.
// The compiled proxy matcher in src/proxy.ts carries literal copies of these rules;
// tests/site-matcher-parity.test.ts fails if the two ever disagree.

/** Labels that can never be a partner slug (spec §1.8 plus the Q5 additions). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'www', 'api', 'admin', 'partner', 'docs', 'trust', 'status', 'mail', 'app', 'smartremit',
  'portal', 'pay', 'support', 'help', 'static', 'cdn', 'm', 'ops',
  // Platform, mail-infrastructure and security-sensitive names (security review round 1).
  'mta-sts', 'autodiscover', 'autoconfig', 'login', 'auth', 'sso', 'account', 'dashboard', 'staging',
  'dev', 'preview', 'sandbox', 'demo', 'webhooks', 'billing', 'security', 'abuse', 'postmaster', 'www2',
]);

/** Same as the partner_sites_slug_format CHECK (migration 0026): 3-30 chars, [a-z0-9-], no edge hyphen. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
/** Same as the partner_sites_slug_not_reserved CHECK: '--' in positions 3-4 (xn-- and every ??-- label). */
const RESERVED_DNS_LABEL = /^..--/;

const SITE_HOST = /^([a-z0-9-]+)\.smartremit\.ai$/;
/** Any subdomain of smartremit.ai (trailing dot allowed) except www — same literal as the proxy matcher. */
const ANY_SUBDOMAIN = /^(?!www\.smartremit\.ai\.?$).+\.smartremit\.ai\.?$/;

export const SITE_HEADERS = { partner: 'x-sr-site-partner', slug: 'x-sr-site-slug' } as const;

export type SiteHost = { kind: 'apex' } | { kind: 'site'; slug: string } | { kind: 'refused' };

export function isValidSiteSlug(s: string): boolean {
  return typeof s === 'string' && SLUG_PATTERN.test(s) && !RESERVED_DNS_LABEL.test(s) && !RESERVED_SLUGS.has(s);
}

/**
 * Exactly what Next's `has: host` matcher compares (next/dist/shared/lib/router/utils/prepare-destination.js:87-90
 * in 16.3.5): everything before the FIRST ':' (the port), lowercased. An IPv6 literal (`[::1]`) becomes '[' and is
 * never a site host. No trimming: the matcher does not trim either.
 */
function hostnameOf(host: string): string {
  return host.split(':', 1)[0].toLowerCase();
}

export function parseSiteHost(host: string | null | undefined): SiteHost {
  if (typeof host !== 'string') return { kind: 'apex' };
  const hostname = hostnameOf(host);
  const m = SITE_HOST.exec(hostname);
  if (m && isValidSiteSlug(m[1])) return { kind: 'site', slug: m[1] };
  return ANY_SUBDOMAIN.test(hostname) ? { kind: 'refused' } : { kind: 'apex' };
}

/** A COPY of `h` without either tenant header (Headers names are case-insensitive). */
export function stripSiteHeaders(h: Headers): Headers {
  const out = new Headers(h);
  out.delete(SITE_HEADERS.partner);
  out.delete(SITE_HEADERS.slug);
  return out;
}

/** Cache TTL of a slug → partner answer. Also the bound on how long a disabled partner keeps routing. */
export const SITE_CACHE_TTL_SEC = 60;
/** Redis key of the slug → partnerId ('-' = no active partner) cache. Lives here (pure) so the writer can clear it. */
export const siteCacheKey = (slug: string) => `site:v1:slug:${slug}`;
