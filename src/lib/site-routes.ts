// site-routes — the partner-subdomain ALLOWLIST. Any path not listed here is 404 on a subdomain.
//
// M1 shipped it EMPTY (plan conflict C4): /pay/** and /api/pay/** wait for the host-tenant check (H2).
// M2 adds EXACTLY the customer portal: '/' (rewritten to /portal), /portal/** and /api/portal/**
// (tests/site-routes-portal.test.ts). Apex-only surfaces (the docs-next and trust pages, the docs try-it
// API, /admin-dashboard, /login, /account, /terms, /privacy, other /api/*) must NEVER be listed here.
// Dark by default: src/proxy.ts consults this table only when CUSTOMER_PORTAL_ENABLED=1, and every
// portal page/action also calls requirePortalSite() (src/lib/portal-site.ts).
// PURE: imported by src/proxy.ts on every matched request.

export interface SiteRoute {
  /** Path prefix; matches `prefix` itself or `prefix + '/…'` (a segment boundary, never a raw startsWith). */
  prefix: string;
  /** Only `prefix` itself, no sub-paths. */
  exact?: boolean;
  /** Internal path to rewrite to (otherwise the request passes through unchanged). */
  rewriteTo?: string;
}

export const SITE_ROUTES: ReadonlyArray<SiteRoute> = [
  { prefix: '/', exact: true, rewriteTo: '/portal' },
  { prefix: '/portal' },
  { prefix: '/api/portal' },
];

export type SitePathClass = { kind: 'allow'; rewriteTo?: string } | { kind: 'deny' };

export function classifySitePath(pathname: string, table: ReadonlyArray<SiteRoute> = SITE_ROUTES): SitePathClass {
  for (const r of table) {
    const hit = pathname === r.prefix || (!r.exact && pathname.startsWith(`${r.prefix}/`));
    if (hit) return r.rewriteTo ? { kind: 'allow', rewriteTo: r.rewriteTo } : { kind: 'allow' };
  }
  return { kind: 'deny' };
}
