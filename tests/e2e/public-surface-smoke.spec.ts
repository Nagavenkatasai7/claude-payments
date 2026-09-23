import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// Program-Fix 41 — public-surface smoke. UNAUTHENTICATED and READ-ONLY: it
// needs no E2E_* secret (so it must never throw at module load), only sends
// anonymous GETs, and never opens a /pay link or follows a redirect into a
// gated page. It proves, on the deployed build: robots.txt and sitemap.xml are
// served, an unknown URL is a real 404 on the neutral page, x-powered-by is
// gone, /docs does not scroll sideways on a phone, and the two sign-in pages
// have one h1 and a skip link. Program-Fix 40 adds: the auth gate
// (src/middleware.ts) redirects an anonymous /admin-dashboard and /account to
// their sign-in pages and leaves /account/login public — the guard for the
// middleware → proxy rename. Program-Fix 47 adds: one enforced CSP per page
// with no 'unsafe-eval', and the report-only nonce CSP on the sign-in pages.

test('robots.txt is served and keeps crawlers off the pay links', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('Disallow: /pay');
  expect(body).toContain('Sitemap: https://smartremit.ai/sitemap.xml');
});

test('sitemap.xml is served', async ({ request }) => {
  const res = await request.get('/sitemap.xml');
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('<loc>https://smartremit.ai/docs</loc>');
});

test('an unknown URL is a 404 on the neutral "Page not found" page', async ({ page }) => {
  const res = await page.goto(`/no-such-page-${randomBytes(6).toString('hex')}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  // White-label safe: no SmartRemit name in the page or the tab title.
  await expect(page.locator('body')).not.toContainText(/smartremit/i);
  await expect(page).not.toHaveTitle(/smartremit/i);
});

test('the landing page sends no x-powered-by header', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  expect(res.headers()['x-powered-by']).toBeUndefined();
});

test.describe('at a 390px phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('/docs does not scroll sideways', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { level: 1, name: 'Partner integration guide' })).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

for (const path of ['/account/login', '/login']) {
  test(`${path} has exactly one h1 and a skip link to #main`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('a[href="#main"]')).toHaveCount(1);
    await expect(page.locator('#main')).toHaveCount(1);
  });
}

// Program-Fix 40 — the auth gate, anonymously. maxRedirects: 0 returns the
// redirect itself (APIRequestContext.get options, node_modules/playwright-core/
// types/types.d.ts:19305, "Pass `0` to not follow redirects"). The pathname is
// compared exactly: endsWith('/login') would also accept /account/login.
// Skipped when VERCEL_AUTOMATION_BYPASS_SECRET is set (Preview only): the
// config then sends x-vercel-set-bypass-cookie, and Vercel's docs do not say
// whether that answers with its own cookie-setting redirect, which maxRedirects: 0
// would see instead of the app's. The production smoke (no secret) is the guard.
const bypassActive = !!process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
for (const [path, signIn] of [
  ['/admin-dashboard', '/login'],
  ['/account', '/account/login'],
] as const) {
  test(`anonymous ${path} is redirected (307) to ${signIn}`, async ({ request, baseURL }) => {
    test.skip(bypassActive, 'preview bypass cookie may add its own redirect');
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status()).toBe(307);
    const location = res.headers()['location'];
    expect(location).toBeTruthy();
    expect(new URL(location, baseURL).pathname).toBe(signIn);
  });
}

test('anonymous /account/login stays public (200, no redirect)', async ({ request }) => {
  test.skip(bypassActive, 'preview bypass cookie may add its own redirect');
  const res = await request.get('/account/login', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
});

// Program-Fix 47 (PR1) — the Content-Security-Policy headers, anonymously.
// Every page carries exactly ONE enforced CSP (from next.config.ts), with no
// 'unsafe-eval'. headersArray() keeps duplicate headers apart (headers()
// merges them: node_modules/playwright-core/types/types.d.ts:19866-19870), and
// the single value must hold one default-src, so a comma-merged pair of
// policies is caught too. The dynamic sign-in pages also carry the REPORT-ONLY
// nonce policy from src/middleware.ts. The /pay check lives in
// pay-page-smoke.spec.ts: this spec never opens a /pay link.
function cspHeaders(res: { headersArray(): Array<{ name: string; value: string }> }, name: string) {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === name)
    .map((h) => h.value);
}

for (const path of ['/', '/about', '/login', '/account/login']) {
  test(`${path} has exactly one enforced CSP, without unsafe-eval`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const enforced = cspHeaders(res, 'content-security-policy');
    expect(enforced).toHaveLength(1);
    expect(enforced[0].match(/default-src/g)).toHaveLength(1);
    expect(enforced[0]).not.toContain('unsafe-eval');
    expect(enforced[0]).toContain("img-src 'self' data: blob: https:");
  });
}

for (const path of ['/login', '/account/login']) {
  test(`${path} carries the report-only nonce CSP`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const reportOnly = cspHeaders(res, 'content-security-policy-report-only');
    expect(reportOnly).toHaveLength(1);
    expect(reportOnly[0]).toContain("'nonce-");
    expect(reportOnly[0]).toContain("'strict-dynamic'");
    // Next actually stamped that nonce on its scripts. Raw HTML via request,
    // not a locator: browsers hide nonce attribute values from the DOM.
    const nonce = reportOnly[0].match(/'nonce-([^']+)'/)![1];
    const html = await res.text();
    expect(html).toContain(`nonce="${nonce}"`);
    expect(html).not.toContain('nonce\\":\\"$undefined');
  });
}
