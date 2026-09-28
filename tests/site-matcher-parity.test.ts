import { describe, it, expect } from 'vitest';
// 16.3.5 export name (next/dist/experimental/testing/server/middleware-testing-utils.d.ts); proxy.md's
// unstable_doesProxyMatch does not exist in the installed version.
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config } from '@/proxy';
import { parseSiteHost } from '@/lib/site-host';
import { SITE_HOSTS, APEX_HOSTS, REFUSED_HOSTS } from './site-host-corpus';

const LEGACY = { matcher: ['/admin-dashboard', '/admin-dashboard/:path*', '/account', '/account/:path*'] };
const PATHS = ['/', '/pay/abc', '/docs', '/login', '/api/worker', '/api/pay/x', '/partners/apply/t', '/robots.txt',
  '/sitemap.xml', '/admin-dashboard', '/admin-dashboard/x', '/account', '/account/login', '/site-inactive',
  '/docs-next', '/trust', '/api/docs/try-it', '/_next/data/x.json', '/about-poster.svgx', '/about-poster.svg/x', '/brandx'];
const STATIC = ['/_next/static/chunks/a.js', '/_next/image?url=x', '/brand/smartremit-lockup.png', '/flags/in.svg', '/about-poster.svg'];
const match = (cfg: { matcher: unknown }, host: string, url: string) =>
  unstable_doesMiddlewareMatch({ config: cfg as never, url, headers: { host } });

describe('proxy matcher (SPEC §7: no widening on apex; §8a: subdomains covered)', () => {
  it('the four legacy entries are byte-identical and come first; exactly two host-conditioned entries are added', () => {
    expect(config.matcher.slice(0, 4)).toEqual(LEGACY.matcher);
    expect(config.matcher).toHaveLength(6);
  });
  it.each(APEX_HOSTS)('apex host %j: the match set equals the pre-M1 matcher on every path', (host) => {
    for (const p of [...PATHS, ...STATIC]) expect(match(config, host, p), `${host}${p}`).toBe(match(LEGACY, host, p));
  });
  const SUB_HOSTS = [...SITE_HOSTS.map(([h]) => h), ...REFUSED_HOSTS];
  it.each(SUB_HOSTS)('subdomain host %s: every non-static path matches (page GETs, action POSTs, /api/*)', (host) => {
    for (const p of PATHS) expect(match(config, host, p), p).toBe(true);
  });
  it.each(SUB_HOSTS)('subdomain host %s: static assets are excluded by explicit, end-anchored pattern', (host) => {
    for (const p of STATIC) expect(match(config, host, p), p).toBe(false);
  });
  it('parity: the matcher fires for a non-legacy path IFF parseSiteHost says site or refused (one host contract)', () => {
    for (const host of [...APEX_HOSTS, ...SUB_HOSTS]) {
      expect(match(config, host, '/some/page'), host).toBe(parseSiteHost(host).kind !== 'apex');
    }
  });
  it('parity: the site entry ALONE fires IFF parseSiteHost says site (its reserved-label literal matches RESERVED_SLUGS)', () => {
    const siteOnly = { matcher: [config.matcher[4]] };
    for (const host of [...APEX_HOSTS, ...SUB_HOSTS]) {
      expect(match(siteOnly, host, '/some/page'), host).toBe(parseSiteHost(host).kind === 'site');
    }
  });
  it('a request with no Host header never fires the subdomain entry', () => {
    expect(unstable_doesMiddlewareMatch({ config: config as never, url: '/some/page', headers: {} })).toBe(false);
  });
});
