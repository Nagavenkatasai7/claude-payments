import { test, expect, type Page } from '@playwright/test';

// B3 — support-role smoke: a self-provisioned 'support' staff member lands on
// the ticket queue, sees NO money nav, and is BOUNCED off /transactions by the
// requireScope server-side guard (the nav hiding is presentation, never the
// guard). Modeled on dashboard-smoke.spec.ts's self-provisioning style.

// `||` not `??`: GitHub Actions sets env vars to empty string when the
// referenced secret doesn't exist, and `??` only falls back on undefined.
const USERNAME = process.env.E2E_USERNAME || 'forextransfer';
const PASSWORD = process.env.E2E_PASSWORD || 'forex@123';
// Reuses the existing CI secret so no new secret is required; an explicit
// E2E_SUPPORT_PASSWORD overrides it if ever split out.
const SUPPORT_PASSWORD = process.env.E2E_SUPPORT_PASSWORD || process.env.E2E_PARTNER_PASSWORD || '';

const SMOKE_SUPPORT_USERNAME = 'e2e-smoke-support';

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

test('support staff land on tickets, see no money nav, and bounce off /transactions', async ({ page }) => {
  test.skip(!SUPPORT_PASSWORD, 'E2E_SUPPORT_PASSWORD / E2E_PARTNER_PASSWORD not configured (local run)');

  // ── Provision (idempotent, via the real admin team UI) ───────────────────
  await loginAs(page, USERNAME, PASSWORD);
  await expect(page).toHaveURL(/\/admin-dashboard/);

  await page.goto('/admin-dashboard/team');
  const staffRow = page.locator(`input[name="username"][value="${SMOKE_SUPPORT_USERNAME}"]`);
  if ((await staffRow.count()) === 0) {
    await page.goto('/admin-dashboard/team/new');
    await page.locator('input[name="name"]').fill('E2E Support Smoke');
    await page.locator('input[name="username"]').fill(SMOKE_SUPPORT_USERNAME);
    await page.locator('input[name="password"]').fill(SUPPORT_PASSWORD);
    await page.locator('select[name="role"]').selectOption('support');
    // Scope select stays on the default '' (platform) option.
    await page.getByRole('button', { name: /create teammate/i }).click();
    await expect(page).toHaveURL(/\/admin-dashboard\/team\/?$/);
  }

  // ── Verify AS the support staff member ───────────────────────────────────
  await page.context().clearCookies();
  await loginAs(page, SMOKE_SUPPORT_USERNAME, SUPPORT_PASSWORD);

  // Landing: requireScope bounces support off the overview straight to the
  // ticket queue.
  await expect(page).toHaveURL(/\/admin-dashboard\/tickets/);
  await expect(page.locator('.sh-page-title')).toContainText(/tickets/i);

  // Money nav absent: no Transactions / Customers / Compliance links in the
  // sidebar — only the Support group.
  const sidebar = page.locator('aside.sh-sidebar');
  await expect(sidebar.getByRole('link', { name: /^transactions$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /^customers$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /^compliance$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /^overview$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /tickets/i }).first()).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /my queue/i })).toBeVisible();

  // Direct navigation to a money page BOUNCES back to the ticket queue
  // (server-side requireScope — the real guard, not the hidden nav).
  await page.goto('/admin-dashboard/transactions');
  await expect(page).toHaveURL(/\/admin-dashboard\/tickets/);
  await expect(page.locator('.sh-page-title')).toContainText(/tickets/i);

  // My queue renders with the scaffold title too.
  await page.goto('/admin-dashboard/tickets/my-queue');
  await expect(page.locator('.sh-page-title')).toContainText(/my queue/i);
});
