import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isRewrite, getRewrittenUrl } from 'next/experimental/testing/server';
import { classifySitePath, SITE_ROUTES } from '@/lib/site-routes';
const { resolveSiteSlug } = vi.hoisted(() => ({ resolveSiteSlug: vi.fn() })); // vi.mock factories are hoisted
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug }));
import { proxy } from '@/proxy';

describe('classifySitePath (SPEC §8a; M1 allowlist is empty, C4)', () => {
  it('M1 ships an empty allowlist', () => expect(SITE_ROUTES).toEqual([]));
  it.each(['/', '/admin-dashboard', '/admin-dashboard/x', '/partner', '/login', '/login/mfa', '/docs', '/partners/apply/t',
    '/account', '/account/login', '/pay/abc', '/pay/b2b/x', '/api/pay/abc', '/api/partner/v1/quote', '/api/partner-rail',
    '/api/whatsapp', '/api/worker', '/api/cron', '/api/version', '/api/persona-webhook', '/api/payment-webhook/x',
    '/robots.txt', '/sitemap.xml', '/site-inactive', '/%2e%2e/admin-dashboard',
    // M4 apex-only surfaces: docs-next, trust and the try-it API never serve on a subdomain
    '/docs-next', '/docs-next/getting-started', '/docs-next/api/quote', '/trust', '/api/docs/try-it'])('%s → deny on a subdomain', (p) =>
    expect(classifySitePath(p)).toEqual({ kind: 'deny' }));
  it('the prefix matcher (exercised with an injected table) requires a segment boundary', () => {
    const table = [{ prefix: '/portal' }, { prefix: '/p/home', exact: true, rewriteTo: '/site/home' }];
    expect(classifySitePath('/portal', table)).toEqual({ kind: 'allow' });
    expect(classifySitePath('/portal/x', table)).toEqual({ kind: 'allow' });
    expect(classifySitePath('/portalx', table)).toEqual({ kind: 'deny' });
    expect(classifySitePath('/p/home', table)).toEqual({ kind: 'allow', rewriteTo: '/site/home' });
    expect(classifySitePath('/p/home/x', table)).toEqual({ kind: 'deny' });
  });
});

const site = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new NextRequest(`https://acme.smartremit.ai${path}`, { method, headers: { host: 'acme.smartremit.ai', ...headers } });
const rewrittenPath = (r: Response) => new URL(getRewrittenUrl(r as never)!).pathname;

describe('proxy on a partner subdomain', () => {
  beforeEach(() => { resolveSiteSlug.mockReset(); });
  it('unknown/disabled slug → the generic inactive sheet on every path, identical', async () => {
    resolveSiteSlug.mockResolvedValue(null);
    const seen = new Set<string>();
    for (const p of ['/', '/admin-dashboard', '/account', '/api/worker', '/pay/x']) {
      const r = await proxy(site(p));
      expect(isRewrite(r as never), p).toBe(true);
      expect(rewrittenPath(r), p).toBe('/site-inactive');
      expect(r.headers.get('location'), p).toBeNull();
      seen.add(JSON.stringify([...r.headers.entries()].filter(([k]) => k !== 'x-middleware-rewrite').sort()));
    }
    expect(seen.size).toBe(1);
  });
  it('active slug + a denied path → 404 via a non-existent route (brand-neutral root not-found)', async () => {
    resolveSiteSlug.mockResolvedValue('pa');
    for (const p of ['/', '/admin-dashboard', '/admin-dashboard/x', '/account', '/login', '/partner', '/docs', '/api/worker',
      '/pay/x', '/api/pay/x', '/docs-next', '/trust', '/api/docs/try-it', '/robots.txt', '/sitemap.xml']) {
      const r = await proxy(site(p));
      expect(rewrittenPath(r), p).toBe('/_site-not-found');
      expect(r.headers.get('location'), p).toBeNull();
    }
  });
  it('HEAD is treated like GET (rewrite, not a bare 404)', async () => {
    resolveSiteSlug.mockResolvedValue(null);
    const r = await proxy(site('/', {}, 'HEAD'));
    expect(rewrittenPath(r)).toBe('/site-inactive');
  });
  it('a refused non-GET/HEAD (Server Action shape) gets a bare 404 from the proxy, never a rewrite', async () => {
    const post = (p: string, method: string) => new NextRequest(`https://acme.smartremit.ai${p}`,
      { method, headers: { host: 'acme.smartremit.ai', 'next-action': 'abc123', 'content-type': 'text/plain' }, body: '[]' });
    for (const resolved of [null, 'pa']) { // unknown slug and active-but-denied look identical
      resolveSiteSlug.mockResolvedValue(resolved);
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) for (const p of ['/', '/login', '/admin-dashboard', '/partners/apply/x', '/api/worker']) {
        const r = await proxy(post(p, method));
        expect(r.status, `${resolved} ${method} ${p}`).toBe(404);
        expect(isRewrite(r as never)).toBe(false);
        expect(r.headers.get('x-middleware-next')).toBeNull();
        expect(r.headers.get('location')).toBeNull();
        expect(await r.text()).toBe('');
      }
    }
  });
  it('/admin-dashboard and /account on a subdomain never reach the cookie redirects', async () => {
    for (const resolved of [null, 'pa']) {
      resolveSiteSlug.mockResolvedValue(resolved);
      for (const p of ['/admin-dashboard', '/account', '/account/history']) {
        expect((await proxy(site(p))).headers.get('location'), p).toBeNull();
      }
    }
  });
  it('an incoming forged tenant header never reaches upstream', async () => {
    for (const resolved of [null, 'pa']) {
      resolveSiteSlug.mockResolvedValue(resolved);
      const r = await proxy(site('/', { 'x-sr-site-partner': 'evil', 'x-sr-site-slug': 'acme' }));
      expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBeNull();
      expect(r.headers.get('x-middleware-request-x-sr-site-slug')).toBeNull();
      expect(r.headers.get('x-middleware-override-headers') ?? '').not.toContain('x-sr-site');
    }
  });
  it('the resolver receives the parsed slug and the (stripped) request headers', async () => {
    resolveSiteSlug.mockResolvedValue(null);
    await proxy(new NextRequest('https://x/', { headers: { host: 'ACME.SmartRemit.ai:443', 'x-forwarded-for': '203.0.113.9', 'x-sr-site-partner': 'evil' } }));
    const [slug, h] = resolveSiteSlug.mock.lastCall as [string, Headers];
    expect(slug).toBe('acme');
    expect(h.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(h.get('x-sr-site-partner')).toBeNull();
  });
  it('a resolver that throws still fails closed to the inactive sheet (GET) / bare 404 (POST)', async () => {
    resolveSiteSlug.mockImplementation(async () => { throw new Error('boom'); });
    expect(rewrittenPath(await proxy(site('/')))).toBe('/site-inactive');
    expect((await proxy(site('/', {}, 'POST'))).status).toBe(404);
  });
});
