import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// Program-Fix 41 — public-surface smoke. UNAUTHENTICATED and READ-ONLY: it
// needs no E2E_* secret (so it must never throw at module load), only GETs
// public pages, and never opens a /pay or /admin-dashboard link. It proves, on
// the deployed build: robots.txt and sitemap.xml are served, an unknown URL is
// a real 404 on the neutral page, x-powered-by is gone, /docs does not scroll
// sideways on a phone, and the two sign-in pages have one h1 and a skip link.

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
