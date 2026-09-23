import { test, expect, type Page } from '@playwright/test';

// The prod smoke needs real credentials from CI secrets (or a local export).
// GitHub Actions sets a referenced-but-missing secret to '' — so check for
// emptiness, never fall back to a literal (a literal here is a public login).
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the prod smoke: add it as a GitHub Actions secret (or export it locally).`);
  return v;
}
const USERNAME = requireEnv('E2E_USERNAME');
const PASSWORD = requireEnv('E2E_PASSWORD');
const PARTNER_PASSWORD = process.env.E2E_PARTNER_PASSWORD ?? '';

// SELF-PROVISIONED partner fixture (post Postgres fresh-start): the old
// E2E_PARTNER_USERNAME/_ID secrets referenced a partner row that only existed
// in the abandoned Redis ledger. This spec now finds-or-creates its own
// partner + partner-scoped agent THROUGH THE REAL ADMIN UI, so it heals
// itself on any fresh environment. Only E2E_PARTNER_PASSWORD remains a secret.
const SMOKE_PARTNER_NAME = 'E2E Smoke Partner';
const SMOKE_USERNAME = 'e2e-smoke-partner';

/**
 * Navigate to a route that REDIRECTS for the current user, then assert where it
 * landed. A plain page.goto waits for `load` on the first document; when the
 * redirect happens after the response has started (Next's in-stream redirect for
 * a server component, logged as a 200, not a 307), Chromium supersedes that
 * navigation and page.goto throws net::ERR_ABORTED. Waiting only for `commit`
 * and then asserting the final URL covers both a 307 and an in-stream redirect.
 */
async function gotoExpectRedirect(page: Page, url: string, expected: RegExp) {
  try {
    await page.goto(url, { waitUntil: 'commit' });
  } catch (err) {
    if (!/ERR_ABORTED/.test(String(err))) throw err;
  }
  await expect(page).toHaveURL(expected, { timeout: 15_000 });
}

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel(/username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
}

test('public landing page renders at / without auth and links to WhatsApp', async ({ page }) => {
  // `/` must be the public SmartRemit landing page — NOT a redirect to login.
  const res = await page.goto('/');
  expect(res?.status()).toBeLessThan(400);
  // Must stay on `/` (no auth bounce to /login or /admin-dashboard).
  await expect(page).toHaveURL(/\/$/);
  // The single landing <h1> — the light-brand hero headline.
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toBeVisible();
  await expect(h1).toContainText(/global money transfers/i);
  // At least one WhatsApp CTA pointing at the bot number. Program-Fix 25 PR B:
  // any number — the owner moves it with NEXT_PUBLIC_WHATSAPP_NUMBER.
  const waCta = page
    .locator('a[href*="api.whatsapp.com/send/?phone="]')
    .first();
  await expect(waCta).toBeVisible();
  await expect(waCta).toHaveAttribute('target', '_blank');
  // Login routing (B7): the three destinations + create account must exist as
  // real links. The footer renders all four visibly (the nav copy is a CSS
  // hover menu), so pin the footer instances.
  const footer = page.locator('footer');
  await expect(footer.locator('a[href="/account/login"]').first()).toBeVisible();
  await expect(footer.locator('a[href="/login"]').first()).toBeVisible();
  await expect(footer.locator('a[href="/docs"]').first()).toBeVisible();
  await expect(footer.locator('a[href="/account/register"]').first()).toBeVisible();
});

test('staff can log in and reach dashboard pages', async ({ page }) => {
  await loginAs(page, USERNAME, PASSWORD);

  await expect(page).toHaveURL(/\/admin-dashboard/);
  // Assert the VISIBLE page heading. (A loose getByText(/overview/i).first() now
  // matches the hidden command-palette "Overview" option in the top bar first —
  // it's in the DOM inside the closed <dialog> — and resolves to "hidden".)
  await expect(page.locator('.sh-page-title')).toContainText(/overview/i);

  await page.getByRole('link', { name: /analytics/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/analytics/);
  // Recharts renders SVGs; their existence proves the page hydrated.
  await expect(page.locator('svg').first()).toBeVisible();

  await page.getByRole('link', { name: /transactions/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/transactions/);
  // A fresh (post-cutover) ledger is legitimately empty — accept the page's
  // ACTUAL empty state alongside a populated table.
  await expect(
    page.getByRole('table').or(page.getByText(/no transactions in this view/i)).first(),
  ).toBeVisible();

  await page.getByRole('link', { name: /customers/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/customers/);
  const customersTable = page.getByRole('table');
  await expect(customersTable.or(page.getByText(/no customers yet/i)).first()).toBeVisible();
  // P1: the Country column header — only present when the table itself is.
  if (await customersTable.count()) {
    await expect(page.getByRole('columnheader', { name: /country/i })).toBeVisible();
  }

  // P2: navigate to /admin-dashboard/partners and assert the table renders
  // (the seeded 'default' partner guarantees at least one row).
  await page.getByRole('link', { name: /partners/i }).click();
  await expect(page).toHaveURL(/\/admin-dashboard\/partners/);
  await expect(
    page.getByRole('table').or(page.getByText(/no partners yet/i)).first(),
  ).toBeVisible();
});

test('partner-scoped staff is restricted to their partner', async ({ page }) => {
  // Fail loud in CI: a missing partner password is a misconfiguration, not a
  // reason to silently pass the most security-sensitive smoke check. Skip only
  // for local runs where the operator hasn't wired it up.
  if (!PARTNER_PASSWORD && process.env.CI) {
    throw new Error(
      'E2E_PARTNER_PASSWORD must be set in CI — partner-isolation smoke cannot be skipped.',
    );
  }
  test.skip(!PARTNER_PASSWORD, 'E2E_PARTNER_PASSWORD not configured (local run)');

  // ── Provision (idempotent, via the real admin UI) ────────────────────────
  await loginAs(page, USERNAME, PASSWORD);
  await expect(page).toHaveURL(/\/admin-dashboard/);

  // Find or create the smoke partner; capture its id from the detail link/URL.
  await page.goto('/admin-dashboard/partners');
  const partnerLink = page
    .locator('a[href*="/admin-dashboard/partners/"]')
    .filter({ hasText: SMOKE_PARTNER_NAME })
    .first();
  let partnerId: string;
  if (await partnerLink.count()) {
    partnerId = (await partnerLink.getAttribute('href'))!.split('/').pop()!;
  } else {
    // Stage 5c: creation is a 6-step wizard (nothing persists until the final
    // commit). US is pre-checked; walk Continue → Create, then capture the id
    // from the done screen's "Open partner page" link.
    await page.goto('/admin-dashboard/partners/new');
    await page.getByPlaceholder('Acme Remit Inc.').fill(SMOKE_PARTNER_NAME);
    for (let i = 0; i < 5; i++) {
      await page.getByRole('button', { name: /continue/i }).click();
    }
    await page.getByRole('button', { name: /create partner/i }).click();
    const openLink = page.getByRole('link', { name: /open partner page/i });
    await expect(openLink).toBeVisible({ timeout: 15_000 });
    partnerId = (await openLink.getAttribute('href'))!.split('/').pop()!;
  }

  // Self-heal: remove any stale smoke staff first. Its bound partner may have been
  // deleted between runs (e.g. a demo cleanup), which would orphan its scope and
  // break the isolation assertions below. It is recreated fresh, bound to the
  // CURRENT partner, just after.
  await page.goto('/admin-dashboard/team');
  const removeBtn = page
    .locator('form')
    .filter({ has: page.locator(`input[name="username"][value="${SMOKE_USERNAME}"]`) })
    .getByRole('button', { name: /^remove$/i });
  if (await removeBtn.count()) {
    await removeBtn.first().click();
    // The Remove server action revalidates in place (no redirect), so the URL
    // check alone passes before the delete commits. Wait for the row to go, or
    // the reload below still sees it, skips re-creation, and the agent login fails.
    await expect(
      page.locator(`input[name="username"][value="${SMOKE_USERNAME}"]`),
    ).toHaveCount(0, { timeout: 15_000 });
  }

  // Find or create the partner-scoped agent bound to that partner.
  await page.goto('/admin-dashboard/team');
  const staffRow = page.locator(`input[name="username"][value="${SMOKE_USERNAME}"]`);
  if ((await staffRow.count()) === 0) {
    await page.goto('/admin-dashboard/team/new');
    await page.locator('input[name="name"]').fill('E2E Partner Smoke');
    await page.locator('input[name="username"]').fill(SMOKE_USERNAME);
    await page.locator('input[name="password"]').fill(PARTNER_PASSWORD);
    await page.locator('select[name="role"]').selectOption('agent');
    await page.locator('select[name="partnerId"]').selectOption(partnerId);
    await page.getByRole('button', { name: /create teammate/i }).click();
    await expect(page).toHaveURL(/\/admin-dashboard\/team\/?$/);
  }

  // ── Verify isolation AS the partner-scoped agent ─────────────────────────
  await page.context().clearCookies();
  await loginAs(page, SMOKE_USERNAME, PARTNER_PASSWORD);
  await expect(page).toHaveURL(/\/admin-dashboard/);

  // Sidebar: should NOT contain "Partners" (list) or "Team" links.
  // (Stricter contains-text assertion avoids matching "My partner" via "Partners".)
  const sidebar = page.locator('aside.sh-sidebar');
  await expect(sidebar.getByRole('link', { name: /^team$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /^partners$/i })).toHaveCount(0);

  // Sidebar: SHOULD contain "My partner".
  await expect(sidebar.getByRole('link', { name: /my partner/i })).toBeVisible();

  // Visiting /admin-dashboard/partners redirects to /admin-dashboard/partners/<id>.
  await gotoExpectRedirect(page, '/admin-dashboard/partners', new RegExp(`/admin-dashboard/partners/${partnerId}$`));

  // Visiting /admin-dashboard/team redirects to /admin-dashboard.
  await gotoExpectRedirect(page, '/admin-dashboard/team', /\/admin-dashboard\/?$/);
});
