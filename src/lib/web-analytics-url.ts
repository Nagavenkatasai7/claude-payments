// web-analytics-url — the page URL that Vercel Web Analytics may store.
//
// <Analytics beforeSend> (src/components/web-analytics.tsx) passes every page
// view URL through redactAnalyticsUrl before the script sends it
// (node_modules/@vercel/analytics/dist/next/index.d.mts:1-13: the event is
// { type, url }; returning null drops it). Page URLs carry bearer secrets: the
// /pay/l/<token> payment link, /partner/invite/<token>, /partners/apply/<token>,
// and ?token= on the portal verify pages. Transfer, ticket and customer ids are
// in paths too. So the path keeps only folder names that src/app defines; every
// other segment becomes [id]. The query string and hash are dropped, except the
// utm_* campaign tags. Import-free, so it runs in the browser bundle.

/**
 * Static folder names under src/app that form page URLs.
 * tests/web-analytics-url.test.ts fails when a page folder is missing here.
 */
export const STATIC_PAGE_SEGMENTS: ReadonlySet<string> = new Set([
  '.well-known', 'about', 'account', 'admin-dashboard', 'ai-apps', 'analytics', 'api-keys', 'apply',
  'audit', 'authorize', 'b2b',
  'branding', 'chat', 'compliance', 'contact', 'continue', 'conversation', 'corridors',
  'customers', 'delete', 'devices', 'docs', 'docs-next', 'documents', 'download', 'edit',
  'employee-questions', 'export', 'help', 'history', 'integrations', 'invite', 'invoices', 'kyc',
  'l', 'landing', 'legal', 'live', 'login', 'mfa', 'my-queue', 'new', 'notifications', 'oauth',
  'oauth-authorization-server', 'oauth-protected-resource', 'onboard',
  'onboarding', 'ops', 'partner', 'partner-requests', 'partners', 'pay', 'payees',
  'payment-links', 'portal', 'privacy', 'profile', 'rates', 'receipt', 'recipients',
  'referral-rewards', 'referrals', 'refunds', 'register', 'reports', 'reset', 'review',
  'reviews', 'revoke', 'rewards', 'schedules', 'security', 'seller', 'send', 'settings', 'signout',
  'site-inactive', 'staff', 'statement', 'support', 'switches', 'team', 'terms', 'tickets',
  'token', 'transactions', 'transfers', 'trust', 'verify', 'waitlist', 'webhooks', 'whatsapp',
]);

const REDACTED = '[id]';

/** The URL with unknown path segments replaced and the query and hash dropped; null if unparseable. */
export function redactAnalyticsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (segment === '' || STATIC_PAGE_SEGMENTS.has(segment) ? segment : REDACTED))
    .join('/');
  const utm = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('utm_')) utm.append(key, value);
  }
  const query = utm.toString();
  return `${url.origin}${path}${query ? `?${query}` : ''}`;
}
