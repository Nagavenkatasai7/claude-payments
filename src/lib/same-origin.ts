/**
 * same-origin — the CSRF check for mutating ROUTE HANDLERS (UI redesign M2-2).
 *
 * Server actions already get Next's Origin-vs-Host check (node_modules/next/dist/
 * docs/01-app/02-guides/data-security.md:550-552), as long as next.config sets no
 * `serverActions.allowedOrigins` (pinned by tests/next-config-no-allowed-origins).
 * Route handlers get nothing, so every portal route handler that changes state calls
 * this first.
 *
 * NON-GET/HEAD handlers ONLY. Browsers omit the Origin header on same-origin GET and
 * HEAD requests, and this helper fails closed on a missing Origin, so wiring it onto a
 * GET would refuse every legitimate page load. A GET handler must not change state;
 * it relies on the session cookie (SameSite=Lax) and the host-bound session instead.
 *
 * The rule mirrors Next's action check and src/app/admin-dashboard/waitlist/export/
 * route.ts: the Origin's host (with port, case-insensitive) must equal the first
 * `x-forwarded-host` when present, else `host`. Unlike Next, a MISSING Origin fails
 * CLOSED: browsers send Origin on every POST, so its absence means a non-browser
 * caller. `Origin: null` (sandboxed frames, some redirects) also fails.
 *
 * Exact host equality means one partner's subdomain never passes for another's,
 * nor the apex for a subdomain.
 */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = headers.get('x-forwarded-host')?.split(',')[0].trim() || headers.get('host') || '';
  return host !== '' && originHost !== '' && originHost.toLowerCase() === host.toLowerCase();
}
