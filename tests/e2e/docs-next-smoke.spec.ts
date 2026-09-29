import { test, expect } from '@playwright/test';

// UI redesign M4 PR-3: /docs-next is an UNLINKED preview of the partner docs until the
// post-demo swap (SPEC §7). UNAUTHENTICATED and READ-ONLY: anonymous GETs only (SPEC §6a),
// no E2E_* secret needed. It proves on the deployed build: the index and a guide render in
// the landing shell with one h1, a skip link and noindex; the MDX pipeline produced real
// tables (remark-gfm) and the code-backed blocks; an unknown guide is a 404; nothing links
// the preview; /docs is untouched; no page scrolls sideways at 375px; one enforced CSP.
// PR-4 adds /docs-next/api: all 11 operations from openapi.yaml, prerendered, same checks.
// PR-5 adds the sandbox "Try it" form (5 allowlisted operations) and its proxy POST /api/docs/try-it.
// The proxy cases use FABRICATED keys only (agents never create credentials, SPEC §6a) and are
// skipped on previews, which share the prod DB and Redis.

test('/docs-next renders the docs index with one h1, a skip link and noindex', async ({ page }) => {
  const res = await page.goto('/docs-next');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Partner documentation' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('a[href="#main"]')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.getByRole('link', { name: 'Start on WhatsApp' }).first()).toBeVisible();
  await expect(page.locator('main h2 a[href="/docs-next/webhooks"]')).toBeVisible();
});

test('a guide renders its MDX body, the code-backed blocks and gfm tables', async ({ page }) => {
  const res = await page.goto('/docs-next/errors');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Errors' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // <ErrorStatusTable /> renders one row per Partner API operation from openapi.yaml.
  await expect(page.locator('main tr[data-op]')).toHaveCount(11);
  await expect(page.locator('main table').first()).toBeVisible();

  for (const [slug, text] of [
    ['webhooks', 'x-smartremit-signature'],
    ['whatsapp-setup', 'transfer_delivered'],
    ['idempotency', 'b2binvoice:'],
  ] as const) {
    const r = await page.goto(`/docs-next/${slug}`);
    expect(r?.status()).toBe(200);
    await expect(page.locator('main')).toContainText(text);
  }
});

test('/docs-next/api renders every Partner API operation from openapi.yaml', async ({ page }) => {
  const res = await page.goto('/docs-next/api');
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // One section per operation, with its stable anchor.
  await expect(page.locator('main section[data-op]')).toHaveCount(11);
  const confirm = page.locator('main section#post-transactions-id-confirm');
  await expect(confirm).toContainText('POST /transactions/{id}/confirm');
  await expect(confirm).toContainText('transactions:write');
  await expect(confirm).toContainText('Sandbox keys: yes');
  await expect(page.locator('main section#schema-transaction')).toBeVisible();
  // Reachable from the docs nav and the docs index.
  await page.goto('/docs-next');
  await expect(page.locator('main h2 a[href="/docs-next/api"]')).toBeVisible();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('the prerendered index and a guide show their h1 and body (no hidden streaming wrapper)', async ({ page, request }) => {
    for (const [path, h1] of [['/docs-next', 'Partner documentation'], ['/docs-next/api', 'API reference'], ['/docs-next/webhooks', 'Webhooks']] as const) {
      const html = await (await request.get(path)).text();
      expect(html).not.toContain('hidden id="S:0"');
      expect(html).not.toContain('<!--$?-->');
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
    }
    await expect(page.locator('main')).toContainText('x-smartremit-signature');
  });
});

test('an unknown guide is a 404', async ({ request }) => {
  expect((await request.get('/docs-next/no-such-guide')).status()).toBe(404);
});

test('the landing page does not link /docs-next or /trust (SPEC §7)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a[href^="/docs-next"], a[href="/trust"]')).toHaveCount(0);
});

test('/docs is untouched: still the Partner integration guide', async ({ page }) => {
  await page.goto('/docs');
  await expect(page.getByRole('heading', { level: 1, name: 'Partner integration guide' })).toBeVisible();
});

test.describe('at a 375px phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  for (const path of ['/docs-next', '/docs-next/whatsapp-setup', '/docs-next/errors', '/docs-next/webhooks', '/docs-next/api']) {
    test(`${path} does not scroll sideways`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1')).toBeVisible();
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
    });
  }
});

test.describe('tables at a 375px phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('/docs-next/errors tables keep one-line headers (they scroll inside, never squeeze)', async ({ page }) => {
    await page.goto('/docs-next/errors');
    await expect(page.locator('main table').first()).toBeVisible();
    const heights = await page.locator('main table th').evaluateAll((ths) => ths.map((th) => th.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(2);
    for (const h of heights) expect(h).toBeLessThan(40);
  });
});

test('/docs-next carries exactly one enforced CSP', async ({ request }) => {
  for (const path of ['/docs-next', '/docs-next/webhooks', '/docs-next/api']) {
    const res = await request.get(path);
    const csp = res.headersArray().filter((h) => h.name.toLowerCase() === 'content-security-policy');
    expect(csp).toHaveLength(1);
    expect(csp[0].value).toContain("connect-src 'self'");
    expect(csp[0].value).toContain("object-src 'none'");
    expect(csp[0].value).not.toContain('unsafe-eval');
  }
});

// ── PR-5: "Try it" (sandbox only, same origin) ─────────────────────────────────────────────
const bypassActive = !!process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

test('/docs-next/api shows the Try it form under exactly the 5 allowlisted sandbox operations', async ({ page }) => {
  await page.goto('/docs-next/api');
  await expect(page.locator('main section[data-op] details summary', { hasText: 'Try it with a sandbox key' })).toHaveCount(5);
  for (const op of ['listCorridors', 'createQuote', 'validateBeneficiary', 'listTransactions', 'getTransaction'])
    await expect(page.locator(`main section[data-op="${op}"] details`)).toHaveCount(1);
  for (const op of ['createTransaction', 'confirmTransaction', 'listSettlements'])
    await expect(page.locator(`main section[data-op="${op}"] details`)).toHaveCount(0);
});

test.describe('Try it at a 375px phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  test('an opened form does not scroll the page sideways', async ({ page }) => {
    await page.goto('/docs-next/api');
    for (const op of ['listTransactions', 'createQuote']) await page.locator(`main section[data-op="${op}"] details summary`).click();
    await expect(page.locator('main section[data-op="createQuote"] textarea')).toBeVisible();
    await expect(page.locator('main section[data-op="listTransactions"]').getByText('No response yet')).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
  });
});

test('try-it refuses a (fabricated) live key and a cross-site request', async ({ request }) => {
  test.skip(bypassActive, 'previews share the prod DB: no POSTs on previews');
  const live = await request.post('/api/docs/try-it', {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    data: { operationId: 'listCorridors', key: 'sr_live_smoke_fabricated' },
  });
  expect(live.status()).toBe(400);
  expect(await live.text()).not.toContain('sr_live_smoke_fabricated');
  const cross = await request.post('/api/docs/try-it', {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    data: { operationId: 'listCorridors', key: 'sr_test_smoke_fabricated' },
  });
  expect(cross.status()).toBe(403);
  const mint = await request.post('/api/docs/try-it', {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    data: { operationId: 'createTransaction', key: 'sr_test_smoke_fabricated', body: {} },
  });
  expect(mint.status()).toBe(400);
});

test('try-it forwards a (fabricated) sandbox key and reports the upstream 401', async ({ request }) => {
  test.skip(bypassActive, 'previews share the prod DB: no POSTs on previews');
  const res = await request.post('/api/docs/try-it', {
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    data: { operationId: 'listCorridors', key: 'sr_test_smoke_fabricated' },
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  const json = await res.json();
  expect(json.upstreamStatus).toBe(401);
  expect(JSON.stringify(json)).not.toContain('sr_test_smoke_fabricated');
});
