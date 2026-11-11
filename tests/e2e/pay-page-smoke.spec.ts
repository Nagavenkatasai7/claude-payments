import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';

// Program-Fix 23 — hosted pay-page smoke. UNAUTHENTICATED: needs no E2E_*
// secret, so it must never throw at module load. It proves, on the deployed
// build, that a dead link of EITHER id shape renders the one generic sheet with
// a 200 (the per-IP guard answers with the same sheet, never a 429), and that
// no payment details leak. It never opens a live link. Program-Fix 47 adds
// the CSP header check and a console collector for CSP violations.

const NEW_SHAPE_ID = randomBytes(16).toString('base64url'); // 22 chars, [A-Za-z0-9_-]
const LEGACY_SHAPE_ID = 'zzzzzzzz'; // pre-fix 8-char base36 shape

// Program-Fix 47 — the enforced CSP gained object-src 'none'; a pay page that
// trips the policy fails here. Every pay-page test fails on a CSP violation in
// the console; the listener is attached before any navigation.
const CSP_LINE = /Content Security Policy/i;
let cspLines: string[] = [];

test.beforeEach(async ({ page }) => {
  cspLines = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (CSP_LINE.test(text)) cspLines.push(text);
  });
});

test.afterEach(async () => {
  expect(cspLines, 'CSP violations in the console').toEqual([]);
});

// Fix pack 4 T20 (C22, C18, C15): a dead-link sheet shows none of the pack 4 pay-step text (the
// provider line, the 'Approving' line, the account-holder field). Fix pack 5 T32 (P31): nor the
// pack 5 sender fields (home address, date of birth).
async function expectNoNewPayText(page: Page): Promise<void> {
  await expect(page.getByTestId('provider-line')).toHaveCount(0);
  await expect(page.getByText(/^Approving /)).toHaveCount(0);
  await expect(page.getByText('Account holder name')).toHaveCount(0);
  await expect(page.getByText('Home address')).toHaveCount(0);
  await expect(page.getByText('Date of birth')).toHaveCount(0);
}

test('/pay carries exactly one enforced CSP, with the Program-Fix 47 additions', async ({ request }) => {
  // headersArray() keeps duplicate headers apart (headers() merges them).
  const res = await request.get(`/pay/${randomBytes(16).toString('base64url')}`);
  expect(res.status()).toBe(200);
  const enforced = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'content-security-policy')
    .map((h) => h.value);
  expect(enforced).toHaveLength(1);
  expect(enforced[0].match(/default-src/g)).toHaveLength(1);
  expect(enforced[0]).toContain("img-src 'self' data: blob: https:");
  expect(enforced[0]).toContain("object-src 'none'");
  // Program-Fix 47 PR2: production ships no 'unsafe-eval'.
  expect(enforced[0]).not.toContain('unsafe-eval');
});

test('a random 22-character id renders the generic inactive sheet with a 200', async ({ page }) => {
  expect(NEW_SHAPE_ID).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const res = await page.goto(`/pay/${NEW_SHAPE_ID}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This link is no longer active' })).toBeVisible();
  await expect(page.getByText('Total charge')).toHaveCount(0);
  await expect(page.getByText('Secure payment')).toHaveCount(0);
  await expectNoNewPayText(page);
});

test('a legacy-shape 8-character id renders the same sheet with a 200', async ({ page }) => {
  const res = await page.goto(`/pay/${LEGACY_SHAPE_ID}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This link is no longer active' })).toBeVisible();
  await expect(page.getByText('Total charge')).toHaveCount(0);
  await expectNoNewPayText(page);
});

test('a random B2B invoice id renders "This bill is no longer active" with a 200', async ({ page }) => {
  const res = await page.goto(`/pay/b2b/inv_${randomBytes(16).toString('base64url')}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This bill is no longer active' })).toBeVisible();
  await expect(page.getByText('Pay your bill')).toHaveCount(0);
  await expect(page.getByText('Amount due')).toHaveCount(0);
  await expectNoNewPayText(page);
});

test('a random payment-link token renders the dead-link sheet with none of the pack 4 or pack 5 text', async ({ page }) => {
  const res = await page.goto(`/pay/l/${randomBytes(24).toString('base64url')}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This link is no longer active' })).toBeVisible();
  await expect(page.getByText('Total charge')).toHaveCount(0);
  await expectNoNewPayText(page);
});
