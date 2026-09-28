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

  test('the transfers pages without a cookie land on the sign-in page (M2-7)', async ({ page }) => {
    for (const path of ['/portal/transfers', '/portal/transfers/AbCdEf123456', '/portal/transfers/AbCdEf123456/receipt']) {
      await page.goto(`${ORIGIN}${path}`);
      await expect(page, path).toHaveURL(/\/portal\/login$/);
    }
  });

  test('the profile and notifications pages without a cookie land on the sign-in page (M2-11)', async ({ page }) => {
    for (const path of ['/portal/profile', '/portal/notifications']) {
      await page.goto(`${ORIGIN}${path}`);
      await expect(page, path).toHaveURL(/\/portal\/login$/);
    }
  });

  test('the email verify link signed out asks to sign in and never renders the token (M2-11)', async ({ page }) => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE';
    await page.goto(`${ORIGIN}/portal/notifications/verify?token=${token}`);
    await expect(page.locator('.sh-page-title')).toHaveText('Verify your email');
    await expect(page.locator('body')).toContainText('Sign in first');
    await expect(page.locator(`input[value="${token}"]`)).toHaveCount(0);
  });

  test('a forged portal cookie is not a session', async ({ page, context }) => {
    // `url` (not `domain`) makes it host-only, as the __Host- prefix requires.
    await context.addCookies([{ name: '__Host-sr_portal', value: 'deadbeef', url: `${ORIGIN}/`, secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await page.goto(`${ORIGIN}/portal`);
    await expect(page).toHaveURL(/\/portal\/login$/);
  });

  // UI redesign M2-12: the chat endpoint refuses a POST without a same-origin Origin (403) and one
  // without a portal session (401). Read-only: neither reaches the agent.
  test('POST /api/portal/chat: no Origin → 403; same origin, no session → 401', async ({ request }) => {
    const noOrigin = await request.post(`${ORIGIN}/api/portal/chat`, { headers: { 'content-type': 'application/json' }, data: { message: 'hi' } });
    expect(noOrigin.status()).toBe(403);
    const noSession = await request.post(`${ORIGIN}/api/portal/chat`, {
      headers: { origin: new URL(ORIGIN!).origin, 'content-type': 'application/json' },
      data: { message: 'hi' },
    });
    expect(noSession.status()).toBe(401);
  });

  test('help and chat pages without a cookie land on the sign-in page', async ({ page }) => {
    for (const path of ['/portal/help', '/portal/help/tickets', '/portal/chat']) {
      await page.goto(`${ORIGIN}${path}`);
      await expect(page, path).toHaveURL(/\/portal\/login$/);
    }
  });

  test('apex-only surfaces are 404 on the subdomain', async ({ request }) => {
    for (const path of ['/admin-dashboard', '/account', '/login', '/pay/x']) {
      const res = await request.get(`${ORIGIN}${path}`, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
  });
});
