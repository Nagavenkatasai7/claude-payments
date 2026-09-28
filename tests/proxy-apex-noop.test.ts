import { describe, it, expect, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { hasStaffSessionCookie, SESSION_COOKIE, LEGACY_SESSION_COOKIE } from '@/lib/session-cookie';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import { APEX_HOSTS } from './site-host-corpus';

const { resolver } = vi.hoisted(() => ({ resolver: vi.fn() })); // vi.mock factories are hoisted
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug: resolver }));
import { proxy } from '@/proxy';

// FROZEN copy of the pre-M1 src/proxy.ts body (lines 10-37 @ 96c8933, unchanged through 332ffa8).
// Do not edit: it is the SPEC §7 oracle that the apex path must keep matching byte for byte.
const PUBLIC_ACCOUNT_PATHS = ['/account/login', '/account/register', '/account/reset', '/account/verify'];
function legacyProxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/account' || pathname.startsWith('/account/')) {
    const isPublic = PUBLIC_ACCOUNT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    if (isPublic) return NextResponse.next();
    if (!req.cookies.get(CUSTOMER_SESSION_COOKIE)?.value) {
      const url = req.nextUrl.clone(); url.pathname = '/account/login'; return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }
  if (!hasStaffSessionCookie(req.cookies)) {
    const url = req.nextUrl.clone(); url.pathname = '/login'; return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

const GATED = ['/admin-dashboard', '/admin-dashboard/', '/admin-dashboard/transactions', '/admin-dashboard/partners/x',
  '/account', '/account/', '/account/history', '/account/login', '/account/register', '/account/reset/abc',
  '/account/verify/x', '/account/loginx'];
const COOKIES: Array<Record<string, string>> = [
  {}, { [SESSION_COOKIE]: 't' }, { [LEGACY_SESSION_COOKIE]: 't' }, { [CUSTOMER_SESSION_COOKIE]: 't' },
  { [SESSION_COOKIE]: 't', [CUSTOMER_SESSION_COOKIE]: 't' }, { [SESSION_COOKIE]: '' },
];
const snap = (r: Response) => ({ status: r.status, location: r.headers.get('location'), headers: [...r.headers.entries()].sort() });

describe('apex behaviour is byte-identical to pre-M1 (SPEC §7)', () => {
  it('sanity: NextRequest keeps an arbitrary Host header (else the corpus would not exercise the parser)', () => {
    expect(new NextRequest('https://smartremit.ai/x', { headers: { host: 'acme.smartremit.ai' } }).headers.get('host')).toBe('acme.smartremit.ai');
  });
  it.each([...APEX_HOSTS.filter(Boolean), null])('host %j: every gated path × cookie state matches the frozen proxy', (host) => {
    for (const path of GATED) for (const jar of COOKIES) for (const method of ['GET', 'POST']) {
      // Fixed base URL: some corpus hosts are not valid URL hosts. The proxy reads the Host HEADER only.
      const mk = () => {
        const r = new NextRequest(`https://smartremit.ai${path}`, { method, headers: host === null ? {} : { host } });
        for (const [k, v] of Object.entries(jar)) r.cookies.set(k, v);
        return r;
      };
      const got = proxy(mk());
      expect(got).not.toBeInstanceOf(Promise); // apex stays synchronous
      expect(snap(got as Response), `${host}${path} ${method} ${JSON.stringify(jar)}`).toEqual(snap(legacyProxy(mk())));
    }
  });
  it('the resolver is never loaded or called on apex', () => expect(resolver).not.toHaveBeenCalled());
  it('insurance: an apex request on a NON-gated path passes through (never the /login fallthrough)', () => {
    for (const p of ['/', '/pay/abc', '/docs', '/api/version', '/login', '/admin-dashboardx', '/accountx']) {
      const r = proxy(new NextRequest(`https://smartremit.ai${p}`, { headers: { host: 'smartremit.ai' } })) as Response;
      expect(r.headers.get('location'), p).toBeNull();
      expect(r.headers.get('x-middleware-next'), p).toBe('1');
      expect(r.headers.get('x-middleware-override-headers'), p).toBeNull();
    }
  });
  it('a forged tenant header on apex is stripped from the upstream request (gated and non-gated paths)', () => {
    for (const p of ['/admin-dashboard', '/account/login', '/', '/pay/x']) {
      const req = new NextRequest(`https://smartremit.ai${p}`, { headers: { host: 'smartremit.ai', 'x-sr-site-partner': 'evil', 'X-SR-Site-Slug': 'evil', 'x-keep': 'k' } });
      req.cookies.set(SESSION_COOKIE, 't');
      const r = proxy(req) as Response;
      expect(r.headers.get('x-middleware-next'), p).toBe('1');
      const overridden = r.headers.get('x-middleware-override-headers') ?? '';
      // An override list DELETES every request header not in it (resolve-routes.js), so a present list
      // without the tenant headers is the strip; the other headers are forwarded unchanged.
      expect(overridden, p).toContain('x-keep');
      expect(overridden, p).not.toContain('x-sr-site-partner');
      expect(overridden, p).not.toContain('x-sr-site-slug');
      expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBeNull();
      expect(r.headers.get('x-middleware-request-x-keep')).toBe('k');
    }
  });
  it('a forged tenant header on a gated apex path that redirects still redirects exactly as before', () => {
    const mk = () => new NextRequest('https://smartremit.ai/admin-dashboard', { headers: { host: 'smartremit.ai', 'x-sr-site-partner': 'evil' } });
    expect(snap(proxy(mk()) as Response)).toEqual(snap(legacyProxy(mk())));
  });
});
