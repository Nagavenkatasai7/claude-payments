import { test, expect } from '@playwright/test';

// UI redesign M4 PR-6: /trust in the landing shell. Public, indexed and linked from the footer
// since the owner's go of 2026-10-25 (Raj's website brief).
// UNAUTHENTICATED and READ-ONLY: anonymous GETs only (SPEC §6a), no E2E_* secret needed. It proves
// on the deployed build: the page renders in the landing shell with one h1, a skip link, no
// noindex and the honest compliance wording; the landing footer links it; no sideways scroll at
// 375px; one CSP.

test('/trust renders with one h1, a skip link, no noindex and the honest status', async ({ page }) => {
  const res = await page.goto('/trust');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Trust & security' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('a[href="#main"]')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
  const main = page.locator('main');
  await expect(main).toContainText('We have not undergone a SOC 2 examination');
  await expect(main.locator('tr[data-subprocessor]').first()).toBeVisible();
  await expect(main.locator('#disclosure a[href^="mailto:"]')).toHaveCount(1);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\bcompliant\b/i);
  expect(text).not.toMatch(/\bOFAC\b/);
});

test('the landing footer links /trust as "Security & compliance"', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('footer a[href="/trust"]')).toHaveText('Security & compliance');
});

test.describe('at a 375px phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('/trust does not scroll sideways (tables scroll inside their wrapper)', async ({ page }) => {
    const res = await page.goto('/trust');
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1')).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    // The shell clips overflow, so also prove the main column itself fits the viewport.
    const mainRight = await page.locator('main article').evaluate((el) => el.getBoundingClientRect().right);
    expect(mainRight).toBeLessThanOrEqual(375);
  });
});

test('/trust carries exactly one enforced CSP', async ({ request }) => {
  const res = await request.get('/trust');
  const csp = res.headersArray().filter((h) => h.name.toLowerCase() === 'content-security-policy');
  expect(csp).toHaveLength(1);
  expect(csp[0].value).toContain("connect-src 'self'");
  expect(csp[0].value).toContain("object-src 'none'");
  expect(csp[0].value).not.toContain('unsafe-eval');
});
