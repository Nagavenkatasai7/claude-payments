import { test, expect } from '@playwright/test';

// UI redesign M4 PR-3: /docs-next is an UNLINKED preview of the partner docs until the
// post-demo swap (SPEC §7). UNAUTHENTICATED and READ-ONLY: anonymous GETs only (SPEC §6a),
// no E2E_* secret needed. It proves on the deployed build: the index and a guide render in
// the landing shell with one h1, a skip link and noindex; the MDX pipeline produced real
// tables (remark-gfm) and the code-backed blocks; an unknown guide is a 404; nothing links
// the preview; /docs is untouched; no page scrolls sideways at 375px; one enforced CSP.

test('/docs-next renders the docs index with one h1, a skip link and noindex', async ({ page }) => {
  const res = await page.goto('/docs-next');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Partner documentation' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('a[href="#main"]')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.getByRole('link', { name: 'Start on WhatsApp' }).first()).toBeVisible();
  await expect(page.locator('main h2 a[href="/docs-next/webhooks"]')).toBeVisible();
});

test('a guide renders its MDX body, the code-backed blocks and gfm tables', async ({ page }) => {
  const res = await page.goto('/docs-next/errors');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Errors' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // <ErrorStatusTable /> renders one row per Partner API operation from openapi.yaml.
  await expect(page.locator('main tr[data-op]')).toHaveCount(11);
  await expect(page.locator('main table').first()).toBeVisible();

  for (const [slug, text] of [
    ['webhooks', 'x-smartremit-signature'],
    ['whatsapp-setup', 'transfer_delivered'],
    ['idempotency', 'b2binvoice:'],
  ] as const) {
    const r = await page.goto(`/docs-next/${slug}`);
    expect(r?.status()).toBe(200);
    await expect(page.locator('main')).toContainText(text);
  }
});

test('an unknown guide is a 404', async ({ request }) => {
  expect((await request.get('/docs-next/no-such-guide')).status()).toBe(404);
});

test('the landing page does not link /docs-next or /trust (SPEC §7)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a[href^="/docs-next"], a[href="/trust"]')).toHaveCount(0);
});

test('/docs is untouched: still the Partner integration guide', async ({ page }) => {
  await page.goto('/docs');
  await expect(page.getByRole('heading', { level: 1, name: 'Partner integration guide' })).toBeVisible();
});

test.describe('at a 375px phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  for (const path of ['/docs-next', '/docs-next/whatsapp-setup', '/docs-next/errors', '/docs-next/webhooks']) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      // Measure the revealed page, not the loading skeleton the segment boundary shows first.
      await expect(page.locator('h1')).toBeVisible();
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }
});

test.describe('tables at a 375px phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('/docs-next/errors tables keep one-line headers (they scroll inside, never squeeze)', async ({ page }) => {
    await page.goto('/docs-next/errors');
    await expect(page.locator('main table').first()).toBeVisible();
    const heights = await page.locator('main table th').evaluateAll((ths) => ths.map((th) => th.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(2);
    for (const h of heights) expect(h).toBeLessThan(40);
  });
});

test('/docs-next carries exactly one enforced CSP', async ({ request }) => {
  for (const path of ['/docs-next', '/docs-next/webhooks']) {
    const res = await request.get(path);
    const csp = res.headersArray().filter((h) => h.name.toLowerCase() === 'content-security-policy');
    expect(csp).toHaveLength(1);
    expect(csp[0].value).toContain("connect-src 'self'");
    expect(csp[0].value).toContain("object-src 'none'");
    expect(csp[0].value).not.toContain('unsafe-eval');
  }
});
