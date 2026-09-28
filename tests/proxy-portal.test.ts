import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isRewrite, getRewrittenUrl } from 'next/experimental/testing/server';
const { resolveSiteSlug } = vi.hoisted(() => ({ resolveSiteSlug: vi.fn() }));
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug }));
import { proxy } from '@/proxy';
import { PORTAL_SESSION_COOKIE } from '@/lib/portal-session-cookie';

// UI redesign M2-5: the proxy side of the customer portal.
// - Dark by default: with CUSTOMER_PORTAL_ENABLED unset the portal paths are DENIED on a subdomain
//   (so a POST naming a foreign server-action id never reaches app code while the portal is off).
// - With the flag on, '/' is rewritten to /portal for GET AND for a POST (a Home-page server action).
// - Cookie refresh on activity (review L1): a well-formed portal cookie is re-set on GET/HEAD of an
//   allowed path; NEVER on a POST (a sign-out action deletes it) and never on the apex.

const TOKEN = 'a'.repeat(64);
const site = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
  new NextRequest(`https://acme.smartremit.ai${path}`, {
    method,
    headers: { host: 'acme.smartremit.ai', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '[]' }),
  });
const rewrittenPath = (r: Response) => new URL(getRewrittenUrl(r as never)!).pathname;
const setCookies = (r: Response) => r.headers.getSetCookie().filter((c) => c.startsWith(`${PORTAL_SESSION_COOKIE}=`));

beforeEach(() => {
  resolveSiteSlug.mockReset();
  resolveSiteSlug.mockResolvedValue('pa');
});
afterEach(() => vi.unstubAllEnvs());

describe('portal routes are dark until CUSTOMER_PORTAL_ENABLED=1', () => {
  it.each(['/', '/portal', '/portal/login', '/api/portal/chat'])('flag off: GET %s → the root 404', async (p) => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '');
    expect(rewrittenPath(await proxy(site(p)))).toBe('/_site-not-found');
  });
  it('flag off: a POST with a server-action id → bare 404', async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '');
    for (const p of ['/', '/portal', '/portal/login']) {
      const r = await proxy(site(p, 'POST', { 'next-action': 'abc123', 'content-type': 'text/plain' }));
      expect(r.status).toBe(404);
      expect(isRewrite(r as never)).toBe(false);
    }
  });
  it("any value but '1' is off", async () => {
    vi.stubEnv('CUSTOMER_PORTAL_ENABLED', 'true');
    expect(rewrittenPath(await proxy(site('/portal')))).toBe('/_site-not-found');
  });
});

describe('flag on', () => {
  beforeEach(() => vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1'));
  it('GET / → rewrite to /portal with the tenant headers', async () => {
    const r = await proxy(site('/'));
    expect(rewrittenPath(r)).toBe('/portal');
    expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBe('pa');
  });
  it('POST / (a Home-page server action) is REWRITTEN to /portal, not refused', async () => {
    const r = await proxy(site('/', 'POST', { 'next-action': 'abc123', 'content-type': 'text/plain' }));
    expect(isRewrite(r as never)).toBe(true);
    expect(rewrittenPath(r)).toBe('/portal');
    expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBe('pa');
  });
  it('/portal/** passes through; apex-only paths stay denied', async () => {
    expect((await proxy(site('/portal/login'))).headers.get('x-middleware-next')).toBe('1');
    for (const p of ['/admin-dashboard', '/account', '/login', '/pay/x', '/terms']) {
      expect(rewrittenPath(await proxy(site(p))), p).toBe('/_site-not-found');
    }
  });
  it('an unresolved slug is still the inactive sheet', async () => {
    resolveSiteSlug.mockResolvedValue(null);
    expect(rewrittenPath(await proxy(site('/portal')))).toBe('/site-inactive');
  });

  describe('cookie refresh on activity (L1)', () => {
    it('GET and HEAD of an allowed path re-set a well-formed cookie with the portal options', async () => {
      for (const [p, m] of [['/', 'GET'], ['/portal/transfers', 'GET'], ['/portal', 'HEAD']] as const) {
        const c = setCookies(await proxy(site(p, m, { cookie: `${PORTAL_SESSION_COOKIE}=${TOKEN}` })));
        expect(c, `${m} ${p}`).toHaveLength(1);
        const v = c[0].toLowerCase();
        expect(v).toContain(`=${TOKEN}`);
        for (const a of ['httponly', 'secure', 'samesite=lax', 'path=/', 'max-age=2592000']) expect(v).toContain(a);
        expect(v).not.toContain('domain=');
      }
    });
    it('never on a POST (a sign-out action deletes the cookie)', async () => {
      const r = await proxy(site('/portal', 'POST', { cookie: `${PORTAL_SESSION_COOKIE}=${TOKEN}`, 'next-action': 'x', 'content-type': 'text/plain' }));
      expect(setCookies(r)).toEqual([]);
    });
    it('never for a malformed value, never on a denied path, never without a cookie', async () => {
      for (const v of ['deadbeef', 'A'.repeat(64), `${TOKEN}0`, '']) {
        expect(setCookies(await proxy(site('/portal', 'GET', { cookie: `${PORTAL_SESSION_COOKIE}=${v}` }))), v).toEqual([]);
      }
      expect(setCookies(await proxy(site('/admin-dashboard', 'GET', { cookie: `${PORTAL_SESSION_COOKIE}=${TOKEN}` })))).toEqual([]);
      expect(setCookies(await proxy(site('/portal')))).toEqual([]);
    });
    it('never on the apex', async () => {
      const r = await proxy(new NextRequest('https://smartremit.ai/account', { headers: { host: 'smartremit.ai', cookie: `${PORTAL_SESSION_COOKIE}=${TOKEN}` } }));
      expect(setCookies(r)).toEqual([]);
    });
    it('flag off: no refresh', async () => {
      vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '');
      expect(setCookies(await proxy(site('/portal', 'GET', { cookie: `${PORTAL_SESSION_COOKIE}=${TOKEN}` })))).toEqual([]);
    });
  });
});
