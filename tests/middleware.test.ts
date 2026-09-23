import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { middleware, config } from '@/middleware';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

describe('middleware', () => {
  it('redirects to /login when no session cookie is present', () => {
    const req = new NextRequest('https://app.test/admin-dashboard');
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('allows the request through when a session cookie exists', () => {
    const req = new NextRequest('https://app.test/admin-dashboard');
    req.cookies.set(SESSION_COOKIE, 'some-token');
    const res = middleware(req);
    // NextResponse.next() has no redirect location
    expect(res.headers.get('location')).toBeNull();
  });
});

// Program-Fix 47 (PR1) — a REPORT-ONLY nonce CSP on the dynamic trees. The
// enforced CSP still comes from next.config.ts on every route; the middleware
// must never add an enforced one (app-render.js:209 reads
// `content-security-policy` BEFORE `-report-only`, so an enforced request
// header without a nonce would stop Next stamping nonces).
//
// NextResponse.next({ request: { headers } }) encodes the forwarded request
// headers as `x-middleware-request-<name>` plus a comma list in
// `x-middleware-override-headers` (node_modules/next/dist/server/web/
// spec-extension/response.js:34-39).

const REPORT_ONLY = 'content-security-policy-report-only';
const ENFORCED = 'content-security-policy';

function overrideList(res: Response): string[] {
  return (res.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean);
}

function noEnforcedCsp(res: Response) {
  expect(res.headers.get(ENFORCED)).toBeNull();
  // Exact token match: `content-security-policy-report-only` contains the
  // enforced name as a substring.
  expect(overrideList(res)).not.toContain(ENFORCED);
  expect(res.headers.get(`x-middleware-request-${ENFORCED}`)).toBeNull();
}

function nonceOf(policy: string | null): string {
  const m = policy?.match(/'nonce-([A-Za-z0-9+/_-]+={0,2})'/);
  expect(m).toBeTruthy();
  return m![1];
}

// Every public page in a matched tree: no redirect (a /login redirect loops),
// report-only nonce policy on the response AND forwarded on the request.
const PUBLIC_NONCE_PATHS = [
  '/pay/x',
  '/pay/b2b/x',
  '/login',
  '/onboard/seller/x',
  '/partners/apply/x',
  '/account/login',
];

describe('middleware — report-only nonce CSP (Program-Fix 47 PR1)', () => {
  for (const path of PUBLIC_NONCE_PATHS) {
    it(`${path}: no redirect, report-only nonce CSP on the response and the request`, () => {
      const res = middleware(new NextRequest(`https://app.test${path}`));
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-next')).toBe('1');

      const policy = res.headers.get(REPORT_ONLY);
      expect(policy).toContain("'nonce-");
      expect(policy).toContain("'strict-dynamic'");
      expect(policy).not.toContain('unsafe-eval');

      expect(overrideList(res)).toContain(REPORT_ONLY);
      expect(res.headers.get(`x-middleware-request-${REPORT_ONLY}`)).toBe(policy);
      expect(res.headers.get('x-middleware-request-x-nonce')).toBe(nonceOf(policy));
      noEnforcedCsp(res);
    });
  }

  it('keeps the incoming request headers (the pay page per-IP limiter reads them)', () => {
    const req = new NextRequest('https://app.test/pay/x', {
      headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
    });
    const res = middleware(req);
    expect(res.headers.get('x-middleware-request-x-forwarded-for')).toBe('203.0.113.9');
    expect(res.headers.get('x-middleware-request-x-real-ip')).toBe('203.0.113.9');
  });

  it('drops a client-supplied enforced CSP request header so it cannot pick the nonce', () => {
    const req = new NextRequest('https://app.test/pay/x', {
      headers: { [ENFORCED]: "script-src 'nonce-attacker'" },
    });
    const res = middleware(req);
    noEnforcedCsp(res);
    expect(res.headers.get('x-middleware-request-x-nonce')).not.toBe('attacker');
  });

  it('two requests get different nonces', () => {
    const a = middleware(new NextRequest('https://app.test/pay/x'));
    const b = middleware(new NextRequest('https://app.test/pay/x'));
    expect(nonceOf(a.headers.get(REPORT_ONLY))).not.toBe(nonceOf(b.headers.get(REPORT_ONLY)));
  });

  it('/admin-dashboard without a cookie still redirects to /login, with the report-only header', () => {
    const res = middleware(new NextRequest('https://app.test/admin-dashboard/transfers'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    expect(res.headers.get(REPORT_ONLY)).toContain("'nonce-");
    noEnforcedCsp(res);
  });

  it('/admin-dashboard with a cookie passes with the nonce forwarded', () => {
    const req = new NextRequest('https://app.test/admin-dashboard');
    req.cookies.set(SESSION_COOKIE, 't');
    const res = middleware(req);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get(`x-middleware-request-${REPORT_ONLY}`)).toContain("'nonce-");
    noEnforcedCsp(res);
  });

  it('/account without a customer cookie redirects to /account/login, with the report-only header', () => {
    const res = middleware(new NextRequest('https://app.test/account'));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/account/login');
    expect(res.headers.get(REPORT_ONLY)).toContain("'nonce-");
    noEnforcedCsp(res);
  });

  it('/account with a customer cookie passes with the nonce forwarded', () => {
    const req = new NextRequest('https://app.test/account/chat');
    req.cookies.set(CUSTOMER_SESSION_COOKIE, 't');
    const res = middleware(req);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get(`x-middleware-request-${REPORT_ONLY}`)).toContain("'nonce-");
    noEnforcedCsp(res);
  });

  it('a staff cookie alone does not open /account (the two gates stay separate)', () => {
    const req = new NextRequest('https://app.test/account');
    req.cookies.set(SESSION_COOKIE, 't');
    expect(new URL(middleware(req).headers.get('location')!).pathname).toBe('/account/login');
  });
});

describe('middleware matcher (Program-Fix 47 PR1)', () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it('covers the dynamic nonce trees', () => {
    for (const path of [
      '/admin-dashboard',
      '/admin-dashboard/transfers',
      '/account',
      '/account/login',
      '/login',
      '/pay/x',
      '/pay/b2b/x',
      '/onboard/seller/x',
      '/partners/apply/x',
    ]) {
      expect({ path, matched: matches(path) }).toEqual({ path, matched: true });
    }
  });

  it('leaves the static / ISR pages and the API alone', () => {
    for (const path of ['/', '/about', '/docs', '/partners', '/api/version', '/robots.txt']) {
      expect({ path, matched: matches(path) }).toEqual({ path, matched: false });
    }
  });
});
