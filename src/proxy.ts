import { NextRequest, NextResponse } from 'next/server';
import { hasStaffSessionCookie } from '@/lib/session-cookie';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import { parseSiteHost, stripSiteHeaders, SITE_HEADERS } from '@/lib/site-host';
import { classifySitePath } from '@/lib/site-routes';

// Edge gate for the two signed-in surfaces (Stage 3 expanded to /account).
// This is defense-in-depth ONLY — every page still runs its own require* and
// every server action self-gates (the server-action security checklist); the
// middleware just stops anonymous traffic from reaching protected trees.
//
// UI redesign M1: a partner subdomain (<slug>.smartremit.ai, see src/lib/site-host.ts) is dispatched
// FIRST to siteProxy, before any cookie gate; any other smartremit.ai subdomain except www is refused
// (404), so the apex app is never served on it. The apex (smartremit.ai, www, previews, localhost)
// runs the unchanged legacy gate, synchronously (tests/proxy-apex-noop.test.ts pins it against a frozen copy). The tenant
// headers are stripped from every request this proxy sees; only siteProxy sets them.

/** /account sub-paths that must stay PUBLIC (they ARE the auth entry points). */
const PUBLIC_ACCOUNT_PATHS = ['/account/login', '/account/register', '/account/reset', '/account/verify'];

const isLegacyGatedPath = (p: string) =>
  p === '/admin-dashboard' || p.startsWith('/admin-dashboard/') || p === '/account' || p.startsWith('/account/');

const hasSiteHeader = (h: Headers) => h.has(SITE_HEADERS.partner) || h.has(SITE_HEADERS.slug);

export function proxy(req: NextRequest): NextResponse | Promise<NextResponse> {
  const site = parseSiteHost(req.headers.get('host'));
  if (site.kind === 'site') return siteProxy(req, site.slug);
  if (site.kind === 'refused') return refuse(req);
  if (!isLegacyGatedPath(req.nextUrl.pathname)) {
    // Only reachable if the platform ever dropped the host condition: never the /login fallthrough.
    return hasSiteHeader(req.headers)
      ? NextResponse.next({ request: { headers: stripSiteHeaders(req.headers) } })
      : NextResponse.next();
  }
  const res = legacyProxy(req);
  if (hasSiteHeader(req.headers) && res.headers.get('x-middleware-next') === '1') {
    return NextResponse.next({ request: { headers: stripSiteHeaders(req.headers) } });
  }
  return res;
}

function legacyProxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (pathname === '/account' || pathname.startsWith('/account/')) {
    const isPublic = PUBLIC_ACCOUNT_PATHS.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    );
    if (isPublic) return NextResponse.next();
    if (!req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value) {
      const url = req.nextUrl.clone();
      url.pathname = '/account/login';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // Staff dashboard. Program-Fix 45 P1: either the __Host- cookie or the
  // legacy one (a session minted before the rename) passes the edge gate.
  if (!hasStaffSessionCookie(req.cookies)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// A refused non-GET/HEAD (e.g. a POST carrying a Server Action id) gets a bare 404 from the proxy, so
// NO app code runs. Rewriting it to a real page would let Next's action handler forward the action to
// the worker that owns it (next/dist/server/app-render/action-handler.js, createForwardedActionResponse).
const isRead = (m: string) => m === 'GET' || m === 'HEAD';
const bare404 = () => new NextResponse(null, { status: 404 });

/** Read → the brand-neutral root 404 (a route that does not exist); anything else → a bare 404. */
function refuse(req: NextRequest, headers: Headers = stripSiteHeaders(req.headers)): NextResponse {
  return isRead(req.method) ? NextResponse.rewrite(new URL('/_site-not-found', req.url), { request: { headers } }) : bare404();
}

async function siteProxy(req: NextRequest, slug: string): Promise<NextResponse> {
  const headers = stripSiteHeaders(req.headers);
  let partnerId: string | null = null;
  try {
    const { resolveSiteSlug } = await import('@/lib/site-tenant-resolver'); // lazy: apex never loads it
    partnerId = await resolveSiteSlug(slug, headers);
  } catch {
    partnerId = null; // fail closed: the same sheet as an unknown slug
  }
  // Unknown, disabled, throttled and errored all look identical (no oracle).
  if (!partnerId) {
    return isRead(req.method) ? NextResponse.rewrite(new URL('/site-inactive', req.url), { request: { headers } }) : bare404();
  }
  const route = classifySitePath(req.nextUrl.pathname);
  if (route.kind === 'deny') return refuse(req, headers);
  headers.set(SITE_HEADERS.partner, partnerId);
  headers.set(SITE_HEADERS.slug, slug);
  return route.rewriteTo
    ? NextResponse.rewrite(new URL(route.rewriteTo, req.url), { request: { headers } })
    : NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    '/admin-dashboard',
    '/admin-dashboard/:path*',
    '/account',
    '/account/:path*',
    // UI redesign M1: subdomains of smartremit.ai ONLY. Next lowercases the Host, strips the port and
    // tests ^value$ (next/dist/shared/lib/router/utils/prepare-destination.js:84-101), so the apex
    // (smartremit.ai, www.smartremit.ai) and every non-smartremit.ai host never satisfy either `has`,
    // and the apex match set is unchanged (tests/site-matcher-parity.test.ts). The values are
    // hand-written literals of the parseSiteHost rules; the parity test fails if they drift.
    // Static assets are excluded explicitly (end-anchored).
    // (1) <valid slug>.smartremit.ai: a partner site.
    {
      source: '/((?!_next/static|_next/image|brand/|flags/|about-poster\\.svg$).*)',
      has: [
        {
          type: 'host',
          value:
            '(?!(?:www|api|admin|partner|docs|trust|status|mail|app|smartremit|portal|pay|support|help|static|cdn|m|ops|mta-sts|autodiscover|autoconfig|login|auth|sso|account|dashboard|staging|dev|preview|sandbox|demo|webhooks|billing|security|abuse|postmaster|www2)\\.smartremit\\.ai$)(?!..--)[a-z0-9][a-z0-9-]{1,28}[a-z0-9]\\.smartremit\\.ai',
        },
      ],
    },
    // (2) every other smartremit.ai subdomain except www (reserved labels, invalid labels, the
    // trailing-dot form): the proxy refuses it, so the apex app is never served there.
    {
      source: '/((?!_next/static|_next/image|brand/|flags/|about-poster\\.svg$).*)',
      has: [{ type: 'host', value: '(?!www\\.smartremit\\.ai\\.?$).+\\.smartremit\\.ai\\.?' }],
    },
  ],
};
