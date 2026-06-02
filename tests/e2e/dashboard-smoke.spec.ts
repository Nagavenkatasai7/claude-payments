import { test, expect } from '@playwright/test';

// `||` not `??`: GitHub Actions sets env vars to empty string when the
// referenced secret doesn't exist, and `??` only falls back on undefined.
const USERNAME = process.env.E2E_USERNAME || 'forextransfer';
const PASSWORD = process.env.E2E_PASSWORD || 'forex@123';

const PARTNER_USERNAME = process.env.E2E_PARTNER_USERNAME || '';
const PARTNER_PASSWORD = process.env.E2E_PARTNER_PASSWORD || '';
const PARTNER_ID = process.env.E2E_PARTNER_ID || '';

test('public landing page renders at / without auth and links to WhatsApp', async ({ page }) => {
  // `/` must be the public SmartRemit landing page — NOT a redirect to login.
  const res = await page.goto('/');
  expect(res?.status()).toBeLessThan(400);
  // Must stay on `/` (no auth bounce to /login or /admin-dashboard).
  await expect(page).toHaveURL(/\/$/);
  // The single landing <h1>.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // At least one WhatsApp CTA pointing at the bot number.
  const waCta = page
    .locator('a[href*="api.whatsapp.com/send/?phone=15556298293"]')
    .first();
  await expect(waCta).toBeVisible();
  await expect(waCta).toHaveAttribute('target', '_blank');
});

test('staff can log in and reach dashboard pages', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/username/i).fill(USERNAME);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/admin-dashboard/);
  await expect(page.getByText(/overview/i).first()).toBeVisible();

  await page.getByRole('link', { name: /analytics/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/analytics/);
  // Recharts renders SVGs; their existence proves the page hydrated.
  await expect(page.locator('svg').first()).toBeVisible();

  await page.getByRole('link', { name: /transactions/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/transactions/);
  await expect(
    page.getByRole('table').or(page.getByText(/no transfers/i)),
  ).toBeVisible();

  await page.getByRole('link', { name: /customers/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/customers/);
  await expect(
    page.getByRole('table').or(page.getByText(/no customers yet/i)),
  ).toBeVisible();
  // P1: assert the new Country column header exists
  await expect(page.getByRole('columnheader', { name: /country/i })).toBeVisible();

  // P2: navigate to /admin-dashboard/partners and assert the table renders
  await page.getByRole('link', { name: /partners/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/partners/);
  await expect(
    page.getByRole('table').or(page.getByText(/no partners yet/i)),
  ).toBeVisible();
});

test('partner-scoped staff is restricted to their partner', async ({ page }) => {
  const partnerEnvMissing = !PARTNER_USERNAME || !PARTNER_PASSWORD || !PARTNER_ID;
  // Fail loud in CI: a missing partner-seed secret is a misconfiguration, not a
  // reason to silently pass the most security-sensitive smoke check. Skip only
  // for local runs where the operator hasn't wired up a partner account.
  if (partnerEnvMissing && process.env.CI) {
    throw new Error(
      'E2E_PARTNER_USERNAME/_PASSWORD/_ID must be set in CI — partner-isolation smoke cannot be skipped.',
    );
  }
  test.skip(partnerEnvMissing, 'partner-seed env vars not configured (local run)');

  await page.goto('/login');
  await page.getByLabel(/username/i).fill(PARTNER_USERNAME);
  await page.getByLabel(/password/i).fill(PARTNER_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/admin-dashboard/);

  // Sidebar: should NOT contain "Partners" (list) or "Team" links.
  // (Stricter contains-text assertion avoids matching "My partner" via "Partners".)
  const sidebar = page.locator('aside.sh-sidebar');
  await expect(sidebar.getByRole('link', { name: /^team$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /^partners$/i })).toHaveCount(0);

  // Sidebar: SHOULD contain "My partner".
  await expect(sidebar.getByRole('link', { name: /my partner/i })).toBeVisible();

  // Visiting /admin-dashboard/partners redirects to /admin-dashboard/partners/<id>.
  await page.goto('/admin-dashboard/partners');
  await expect(page).toHaveURL(new RegExp(`/admin-dashboard/partners/${PARTNER_ID}$`));

  // Visiting /admin-dashboard/team redirects to /admin-dashboard.
  await page.goto('/admin-dashboard/team');
  await expect(page).toHaveURL(/\/admin-dashboard\/?$/);
});
