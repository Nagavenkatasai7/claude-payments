import { describe, it, expect } from 'vitest';
import { classifySitePath, SITE_ROUTES } from '@/lib/site-routes';

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
