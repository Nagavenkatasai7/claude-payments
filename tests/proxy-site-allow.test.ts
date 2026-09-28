// The allow branch of the subdomain proxy. The route table is mocked here to prove what an allowlisted
// path gets: the proxy-set tenant headers (and only those). M2: the table is consulted only with
// CUSTOMER_PORTAL_ENABLED=1 (tests/proxy-portal.test.ts pins the flag-off side).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { isRewrite, getRewrittenUrl } from 'next/experimental/testing/server';
const { resolveSiteSlug, classifySitePath } = vi.hoisted(() => ({ resolveSiteSlug: vi.fn(), classifySitePath: vi.fn() }));
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug }));
vi.mock('@/lib/site-routes', () => ({ classifySitePath }));
import { proxy } from '@/proxy';

const site = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://acme.smartremit.ai${path}`, { headers: { host: 'acme.smartremit.ai', ...headers } });

describe('proxy allow branch', () => {
  beforeAll(() => vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1'));
  afterAll(() => vi.unstubAllEnvs());
  it('passes through with the resolved tenant headers, overwriting any forged value', async () => {
    resolveSiteSlug.mockResolvedValue('pa');
    classifySitePath.mockReturnValue({ kind: 'allow' });
    const r = await proxy(site('/portal', { 'x-sr-site-partner': 'evil', 'x-sr-site-slug': 'other' }));
    expect(r.headers.get('x-middleware-next')).toBe('1');
    expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBe('pa');
    expect(r.headers.get('x-middleware-request-x-sr-site-slug')).toBe('acme');
  });
  it('rewrites when the route says so, with the tenant headers', async () => {
    resolveSiteSlug.mockResolvedValue('pa');
    classifySitePath.mockReturnValue({ kind: 'allow', rewriteTo: '/site/home' });
    const r = await proxy(site('/'));
    expect(isRewrite(r as never)).toBe(true);
    expect(new URL(getRewrittenUrl(r as never)!).pathname).toBe('/site/home');
    expect(r.headers.get('x-middleware-request-x-sr-site-partner')).toBe('pa');
  });
  it('an unresolved slug never consults the route table', async () => {
    classifySitePath.mockClear();
    resolveSiteSlug.mockResolvedValue(null);
    await proxy(site('/portal'));
    expect(classifySitePath).not.toHaveBeenCalled();
  });
});
