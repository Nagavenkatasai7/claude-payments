import { NextRequest, NextResponse } from 'next/server';
import { hasStaffSessionCookie } from '@/lib/session-cookie';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

// Edge gate for the two signed-in surfaces (Stage 3 expanded to /account).
// This is defense-in-depth ONLY — every page still runs its own require* and
// every server action self-gates (the server-action security checklist); the
// middleware just stops anonymous traffic from reaching protected trees.

/** /account sub-paths that must stay PUBLIC (they ARE the auth entry points). */
const PUBLIC_ACCOUNT_PATHS = ['/account/login', '/account/register', '/account/reset', '/account/verify'];

export function proxy(req: NextRequest) {
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

export const config = {
  matcher: [
    '/admin-dashboard',
    '/admin-dashboard/:path*',
    '/account',
    '/account/:path*',
    // UI redesign M1: partner subdomains ONLY (<slug>.smartremit.ai). Next lowercases the Host, strips
    // the port and tests ^value$ (next/dist/shared/lib/router/utils/prepare-destination.js:84-101), so
    // apex hosts never satisfy this `has` and the apex match set is unchanged
    // (tests/site-matcher-parity.test.ts). The value is a hand-written literal of the parseSiteHost
    // rules (reserved labels, ??-- labels, 3-30 char slug); the parity test fails if they drift.
    // Static assets are excluded explicitly.
    {
      source: '/((?!_next/static|_next/image|brand/|flags/|about-poster\\.svg).*)',
      has: [
        {
          type: 'host',
          value:
            '(?!(?:www|api|admin|partner|docs|trust|status|mail|app|smartremit|portal|pay|support|help|static|cdn|m|ops)\\.smartremit\\.ai$)(?!..--)[a-z0-9][a-z0-9-]{1,28}[a-z0-9]\\.smartremit\\.ai',
        },
      ],
    },
  ],
};
