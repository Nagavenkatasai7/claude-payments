import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import { buildCsp, makeNonce } from '@/lib/csp';

// Two jobs, kept apart:
//
// 1. Edge gate for the two signed-in surfaces (Stage 3 expanded to /account).
//    Defense-in-depth ONLY — every page still runs its own require* and every
//    server action self-gates; the middleware just stops anonymous traffic
//    from reaching protected trees. The staff redirect applies to
//    /admin-dashboard ONLY: /pay, /login and the onboarding links are public.
//
// 2. Program-Fix 47 PR1: a per-request nonce CSP, REPORT-ONLY, on the
//    dynamically rendered trees in the matcher. The nonce policy goes on the
//    REQUEST (Next reads it during render and stamps its own scripts:
//    node_modules/next/dist/server/app-render/app-render.js:209, guide
//    01-app/02-guides/content-security-policy.md:68) and on the RESPONSE
//    (the browser reports violations without blocking). The ENFORCED policy
//    still comes from next.config.ts on every route. PR1 never sets an
//    enforced `content-security-policy` request header: app-render reads it
//    BEFORE the report-only one, and one without our nonce would win.

/** /account sub-paths that must stay PUBLIC (they ARE the auth entry points). */
const PUBLIC_ACCOUNT_PATHS = ['/account/login', '/account/register', '/account/reset', '/account/verify'];

const REPORT_ONLY = 'content-security-policy-report-only';
const ENFORCED = 'content-security-policy';

function inTree(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = makeNonce();
  const policy = buildCsp({ nonce, isDev: process.env.NODE_ENV === 'development' });

  // Pass through, forwarding every incoming header (the pay page's per-IP
  // limiter reads them via headers()) plus the nonce policy.
  const pass = () => {
    const headers = new Headers(req.headers);
    // A client-sent enforced header would be read first by app-render.
    headers.delete(ENFORCED);
    headers.set(REPORT_ONLY, policy);
    headers.set('x-nonce', nonce);
    const res = NextResponse.next({ request: { headers } });
    res.headers.set(REPORT_ONLY, policy);
    return res;
  };

  const redirectTo = (target: string) => {
    const url = req.nextUrl.clone();
    url.pathname = target;
    const res = NextResponse.redirect(url);
    res.headers.set(REPORT_ONLY, policy);
    return res;
  };

  if (inTree(pathname, '/account')) {
    const isPublic = PUBLIC_ACCOUNT_PATHS.some((p) => inTree(pathname, p));
    if (isPublic) return pass();
    if (!req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value) return redirectTo('/account/login');
    return pass();
  }

  if (inTree(pathname, '/admin-dashboard')) {
    if (!req.cookies.get(SESSION_COOKIE)?.value) return redirectTo('/login');
    return pass();
  }

  // /login, /pay/**, /onboard/seller/**, /partners/apply/**: public, CSP only.
  return pass();
}

// Literal constants only: the matcher is statically analysed at build time and
// variables are ignored (01-app/03-api-reference/03-file-conventions/proxy.md:136).
export const config = {
  matcher: [
    '/admin-dashboard',
    '/admin-dashboard/:path*',
    '/account',
    '/account/:path*',
    '/login',
    '/pay/:path*',
    '/onboard/seller/:path*',
    '/partners/apply/:path*',
  ],
};
