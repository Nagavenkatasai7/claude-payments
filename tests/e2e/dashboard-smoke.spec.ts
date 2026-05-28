import { test, expect } from '@playwright/test';

// `||` not `??`: GitHub Actions sets env vars to empty string when the
// referenced secret doesn't exist, and `??` only falls back on undefined.
const USERNAME = process.env.E2E_USERNAME || 'forextransfer';
const PASSWORD = process.env.E2E_PASSWORD || 'forex@123';

const PARTNER_USERNAME = process.env.E2E_PARTNER_USERNAME || '';
const PARTNER_PASSWORD = process.env.E2E_PARTNER_PASSWORD || '';
const PARTNER_ID = process.env.E2E_PARTNER_ID || '';

test('staff can log in and reach dashboard pages', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel(/username/i).fill(USERNAME);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/overview/i).first()).toBeVisible();

  await page.getByRole('link', { name: /analytics/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/analytics/);
  // Recharts renders SVGs; their existence proves the page hydrated.
  await expect(page.locator('svg').first()).toBeVisible();

  await page.getByRole('link', { name: /transactions/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/transactions/);
  await expect(
    page.getByRole('table').or(page.getByText(/no transfers/i)),
  ).toBeVisible();

  await page.getByRole('link', { name: /customers/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/customers/);
  await expect(
    page.getByRole('table').or(page.getByText(/no customers yet/i)),
  ).toBeVisible();
  // P1: assert the new Country column header exists
  await expect(page.getByRole('columnheader', { name: /country/i })).toBeVisible();

  // P2: navigate to /dashboard/partners and assert the table renders
  await page.getByRole('link', { name: /partners/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/partners/);
  await expect(
    page.getByRole('table').or(page.getByText(/no partners yet/i)),
  ).toBeVisible();
});

test('partner-scoped staff is restricted to their partner', async ({ page }) => {
  test.skip(
    !PARTNER_USERNAME || !PARTNER_PASSWORD || !PARTNER_ID,
    'partner-seed env vars not configured',
  );

  await page.goto('/login');
  await page.getByLabel(/username/i).fill(PARTNER_USERNAME);
  await page.getByLabel(/password/i).fill(PARTNER_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);

  // Sidebar: should NOT contain "Partners" (list) or "Team" links.
  // (Stricter contains-text assertion avoids matching "My partner" via "Partners".)
  const sidebar = page.locator('aside.sh-sidebar');
  await expect(sidebar.getByRole('link', { name: /^team$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /^partners$/i })).toHaveCount(0);

  // Sidebar: SHOULD contain "My partner".
  await expect(sidebar.getByRole('link', { name: /my partner/i })).toBeVisible();

  // Visiting /dashboard/partners redirects to /dashboard/partners/<id>.
  await page.goto('/dashboard/partners');
  await expect(page).toHaveURL(new RegExp(`/dashboard/partners/${PARTNER_ID}$`));

  // Visiting /dashboard/team redirects to /dashboard.
  await page.goto('/dashboard/team');
  await expect(page).toHaveURL(/\/dashboard\/?$/);
});
