import { test, expect } from '@playwright/test';

// UI redesign M2-5: the customer portal on a partner subdomain. UNAUTHENTICATED and READ-ONLY (SPEC
// §6a: no login bypass, no OTP, no account creation). It runs only once DNS exists and the owner sets
// E2E_PORTAL_ORIGIN (https://<test-partner-slug>.smartremit.ai) for the owner's test partner, whose
// portal is enabled. Until then every case is skipped, so the apex smoke is unaffected.
const ORIGIN = process.env.E2E_PORTAL_ORIGIN;

test.describe('customer portal on a partner subdomain', () => {
  test.skip(!ORIGIN, 'E2E_PORTAL_ORIGIN is not set (no portal wildcard yet)');

  test('/ renders the sign-in page', async ({ page }) => {
    const res = await page.goto(`${ORIGIN}/`);
    expect(res?.status()).toBe(200);
    await expect(page.locator('.sh-page-title')).toHaveText('Sign in');
    await expect(page.locator('input[name="phone"]')).toBeVisible();
  });

  test('a protected page without a cookie lands on the sign-in page', async ({ page }) => {
    await page.goto(`${ORIGIN}/portal`);
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  test('a forged portal cookie is not a session', async ({ page, context }) => {
    // `url` (not `domain`) makes it host-only, as the __Host- prefix requires.
    await context.addCookies([{ name: '__Host-sr_portal', value: 'deadbeef', url: `${ORIGIN}/`, secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${ORIGIN}/portal`);
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  test('apex-only surfaces are 404 on the subdomain', async ({ request }) => {
    for (const path of ['/admin-dashboard', '/account', '/login', '/pay/x']) {
      const res = await request.get(`${ORIGIN}${path}`, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
  });
});
