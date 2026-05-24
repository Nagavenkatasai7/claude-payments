import { test, expect } from '@playwright/test';

const USERNAME = process.env.E2E_USERNAME ?? 'forextransfer';
const PASSWORD = process.env.E2E_PASSWORD ?? 'forex@123';

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
});
