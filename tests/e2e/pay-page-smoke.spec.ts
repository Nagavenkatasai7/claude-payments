import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

// Program-Fix 23 — hosted pay-page smoke. UNAUTHENTICATED: needs no E2E_*
// secret, so it must never throw at module load. It proves, on the deployed
// build, that a dead link of EITHER id shape renders the one generic sheet with
// a 200 (the per-IP guard answers with the same sheet, never a 429), and that
// no payment details leak. It never opens a live link. Program-Fix 47 adds
// the CSP header check and a console collector for CSP violations.

const NEW_SHAPE_ID = randomBytes(16).toString('base64url'); // 22 chars, [A-Za-z0-9_-]
const LEGACY_SHAPE_ID = 'zzzzzzzz'; // pre-fix 8-char base36 shape

// Program-Fix 47 (PR1) — CSP console collector on every pay-page test. The
// listener is attached before any navigation. A CSP line from the ENFORCED
// policy fails the test; a line from the REPORT-ONLY nonce policy never fails
// (PR1 is the observation window): it is counted and attached to the test
// output for the PR2 decision. Chromium marks report-only lines either with a
// "[Report Only]" prefix or, as in the bundled Chromium of Playwright 1.62,
// with "The policy is report-only, so the violation has been logged" (observed
// against a local production build). PR2 makes both kinds fail.
const CSP_LINE = /Content Security Policy/i;
const REPORT_ONLY_LINE = /\[Report Only\]|policy is report-only/i;
let cspLines: string[] = [];

test.beforeEach(async ({ page }) => {
  cspLines = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (CSP_LINE.test(text)) cspLines.push(text);
  });
});

test.afterEach(async ({}, testInfo) => {
  const reportOnly = cspLines.filter((l) => REPORT_ONLY_LINE.test(l));
  const enforced = cspLines.filter((l) => !REPORT_ONLY_LINE.test(l));
  if (reportOnly.length > 0) {
    await testInfo.attach('csp-report-only', {
      body: `${reportOnly.length} report-only CSP line(s)\n${reportOnly.join('\n')}`,
      contentType: 'text/plain',
    });
  }
  // A GREEN CI run shows neither attachments nor test stdout (the github
  // reporter prints failures only; smoke.yml uploads test-results/ on failure
  // only), so the count goes to the job summary too: that is where the PR2
  // observation gate reads it. Written for every pay-page test, zero included,
  // so "no lines" is distinguishable from "not checked".
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const body = reportOnly.map((l) => `    ${l.slice(0, 300)}`).join('\n');
    appendFileSync(
      summary,
      `- CSP report-only lines: ${reportOnly.length} (${testInfo.title})\n${body ? `${body}\n` : ''}`,
    );
  }
  expect(enforced, 'enforced CSP violations in the console').toEqual([]);
});

test('/pay carries exactly one enforced CSP without unsafe-eval, plus the report-only nonce CSP', async ({
  request,
}) => {
  // headersArray() keeps duplicate headers apart (headers() merges them).
  const res = await request.get(`/pay/${randomBytes(16).toString('base64url')}`);
  expect(res.status()).toBe(200);
  const named = (name: string) =>
    res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === name)
      .map((h) => h.value);
  const enforced = named('content-security-policy');
  expect(enforced).toHaveLength(1);
  expect(enforced[0].match(/default-src/g)).toHaveLength(1);
  expect(enforced[0]).not.toContain('unsafe-eval');
  const reportOnly = named('content-security-policy-report-only');
  expect(reportOnly).toHaveLength(1);
  expect(reportOnly[0]).toContain("'nonce-");
  expect(reportOnly[0]).toContain("'strict-dynamic'");
});

test('a random 22-character id renders the generic inactive sheet with a 200', async ({ page }) => {
  expect(NEW_SHAPE_ID).toMatch(/^[A-Za-z0-9_-]{22}$/);
  const res = await page.goto(`/pay/${NEW_SHAPE_ID}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This link is no longer active' })).toBeVisible();
  await expect(page.getByText('Total charge')).toHaveCount(0);
  await expect(page.getByText('Secure payment')).toHaveCount(0);
});

test('a legacy-shape 8-character id renders the same sheet with a 200', async ({ page }) => {
  const res = await page.goto(`/pay/${LEGACY_SHAPE_ID}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This link is no longer active' })).toBeVisible();
  await expect(page.getByText('Total charge')).toHaveCount(0);
});

test('a random B2B invoice id renders "This bill is no longer active" with a 200', async ({ page }) => {
  const res = await page.goto(`/pay/b2b/inv_${randomBytes(16).toString('base64url')}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'This bill is no longer active' })).toBeVisible();
  await expect(page.getByText('Pay your bill')).toHaveCount(0);
  await expect(page.getByText('Amount due')).toHaveCount(0);
});
