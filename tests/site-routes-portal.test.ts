import { describe, it, expect } from 'vitest';
import { classifySitePath, SITE_ROUTES } from '@/lib/site-routes';

// UI redesign M2-5, Task 5.1: the customer portal's subdomain routes. EXACTLY three entries;
// every M1 apex-only surface stays denied (the list below is M1's, minus '/').

describe('SITE_ROUTES (customer portal)', () => {
  it('has exactly the three portal entries', () => {
    expect(SITE_ROUTES).toEqual([
      { prefix: '/', exact: true, rewriteTo: '/portal' },
      { prefix: '/portal' },
      { prefix: '/api/portal' },
    ]);
  });
  it('/ rewrites to /portal', () => expect(classifySitePath('/')).toEqual({ kind: 'allow', rewriteTo: '/portal' }));
  it.each(['/portal', '/portal/login', '/portal/transfers/x', '/api/portal', '/api/portal/chat'])('%s → allow', (p) =>
    expect(classifySitePath(p)).toEqual({ kind: 'allow' }));
  it.each(['/portalx', '/api/portalx', '/portal-x', '/api/portal-chat', '//portal', '/Portal'])('%s → deny (segment boundary)', (p) =>
    expect(classifySitePath(p)).toEqual({ kind: 'deny' }));
  it.each(['/admin-dashboard', '/admin-dashboard/x', '/partner', '/login', '/login/mfa', '/docs', '/partners/apply/t',
    '/account', '/account/login', '/pay/abc', '/pay/b2b/x', '/api/pay/abc', '/api/partner/v1/quote', '/api/partner-rail',
    '/api/whatsapp', '/api/worker', '/api/cron', '/api/version', '/api/persona-webhook', '/api/payment-webhook/x',
    '/robots.txt', '/sitemap.xml', '/site-inactive', '/%2e%2e/admin-dashboard',
    '/docs-next', '/docs-next/getting-started', '/docs-next/api/quote', '/trust', '/api/docs/try-it',
    '/terms', '/privacy', '/about', '/onboard/seller/x'])('%s stays denied on a subdomain', (p) =>
    expect(classifySitePath(p)).toEqual({ kind: 'deny' }));
});
