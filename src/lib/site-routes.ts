// site-routes — the partner-subdomain ALLOWLIST. Any path not listed here is 404 on a subdomain.
//
// M1 ships it EMPTY (plan conflict C4): /pay/** and /api/pay/** wait for the host-tenant check (H2),
// and M2 appends the portal routes. Apex-only surfaces (/docs-next/**, /trust, /api/docs/try-it,
// /admin-dashboard, /login, /api/*) must NEVER be listed here; tests/proxy-site.test.ts pins them.
// PURE: imported by src/proxy.ts on every matched request.

export interface SiteRoute {
  /** Path prefix; matches `prefix` itself or `prefix + '/…'` (a segment boundary, never a raw startsWith). */
  prefix: string;
  /** Only `prefix` itself, no sub-paths. */
  exact?: boolean;
  /** Internal path to rewrite to (otherwise the request passes through unchanged). */
  rewriteTo?: string;
}

export const SITE_ROUTES: ReadonlyArray<SiteRoute> = [];

export type SitePathClass = { kind: 'allow'; rewriteTo?: string } | { kind: 'deny' };

export function classifySitePath(pathname: string, table: ReadonlyArray<SiteRoute> = SITE_ROUTES): SitePathClass {
  for (const r of table) {
    const hit = pathname === r.prefix || (!r.exact && pathname.startsWith(`${r.prefix}/`));
    if (hit) return r.rewriteTo ? { kind: 'allow', rewriteTo: r.rewriteTo } : { kind: 'allow' };
  }
  return { kind: 'deny' };
}
