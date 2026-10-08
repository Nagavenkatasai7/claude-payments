import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Release safety Batch 2 part B — the synthetic SANDBOX transfer.
//
// One test-key (sr_test_) Partner API transfer through the deployed build:
// quote → create → confirm → read. A test key's transfer is environment 'test':
// it always takes the mock rail (settlement.ts enqueueRailEffect), its customer
// messages are never sent (outbox-worker sandboxSkip), it can never read or
// confirm a live transfer, and it never counts toward live caps or velocity.
// Sanctions screening still runs on it. So this moves no money.
//
// Two callers, both opt-in (SYNTHETIC_TRANSFER=1), so `npm run e2e` skips it:
//   • release-check.yml runs it on the HELD production deployment (Vercel
//     Deployment Checks) BEFORE customers see the build. It requires `paid`:
//     the paid flip and the mock settlement row commit in ONE transaction
//     (beginSettlement), so `paid` proves both.
//   • smoke.yml runs it on the LIVE build with SYNTHETIC_WAIT_DELIVERED=1 and
//     also waits for `delivered`, which proves the live worker drains the mock
//     settlement (DELIVERY_DELAY_MS = 2 min, then the per-minute cron).
//
// Secrets: E2E_SANDBOX_API_KEY (the "SmartRemit Synthetic" partner's TEST key).
// The Vercel bypass header comes from playwright.config.ts when
// VERCEL_AUTOMATION_BYPASS_SECRET is set (the held deployment URL is protected).

const ENABLED = process.env.SYNTHETIC_TRANSFER === '1';
const WAIT_DELIVERED = process.env.SYNTHETIC_WAIT_DELIVERED === '1';
const KEY = process.env.E2E_SANDBOX_API_KEY ?? '';
// A fictional number (the 555-01xx range is reserved for fiction). A sandbox
// mint writes no customers row, so it never touches a real customer.
const SENDER_PHONE = '15555550142';
const AMOUNT_USD = 10;
const API = '/api/partner/v1';

function auth(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...extra };
}

async function json(res: Awaited<ReturnType<APIRequestContext['get']>>, label: string) {
  const body = await res.text();
  // Never print the request headers (the key); the response body has no secret.
  expect(res.ok(), `${label}: HTTP ${res.status()} ${body.slice(0, 300)}`).toBe(true);
  return JSON.parse(body) as Record<string, unknown>;
}

test.describe('@synthetic sandbox transfer', () => {
  test.skip(!ENABLED, 'Runs only in release-check.yml and the post-deploy smoke (SYNTHETIC_TRANSFER=1).');

  test('quote, create, confirm and read a sandbox transfer on the mock rail', async ({ request }) => {
    test.setTimeout(WAIT_DELIVERED ? 8 * 60_000 : 90_000);
    // A test key only: a live key here would mint a REAL transfer. Fail closed.
    expect(KEY.startsWith('sr_test_'), 'E2E_SANDBOX_API_KEY must be a sandbox (sr_test_) key').toBe(true);

    const quote = await json(
      await request.post(`${API}/quote`, {
        headers: auth(),
        data: { amount_source: AMOUNT_USD, source_currency: 'USD', destination_country: 'IN' },
      }),
      'quote',
    );
    expect(quote.amount_source).toBe(AMOUNT_USD);
    expect(Number(quote.fx_rate)).toBeGreaterThan(0);

    const created = await json(
      await request.post(`${API}/transactions`, {
        headers: auth({ 'Idempotency-Key': `synthetic-${randomUUID()}` }),
        data: {
          amount_source: AMOUNT_USD,
          source_currency: 'USD',
          destination_country: 'IN',
          // Required purpose: a create without one is 422, which would fail the release check.
          purpose: 'family_support',
          sender: { phone: SENDER_PHONE, name: 'Synthetic Release Check', kyc_status: 'verified' },
          beneficiary: {
            name: 'Synthetic Recipient',
            payout_method: 'bank',
            payout_destination: '123456789012|HDFC0001234',
          },
        },
      }),
      'create',
    );
    const id = String(created.id);
    expect(id).not.toBe('');
    expect(created.status).toBe('awaiting_payment');
    expect(created.compliance_status).toBe('cleared');

    const confirmed = await json(
      await request.post(`${API}/transactions/${encodeURIComponent(id)}/confirm`, { headers: auth() }),
      'confirm',
    );
    expect(['paid', 'delivered']).toContain(confirmed.status);

    const read = await json(await request.get(`${API}/transactions/${encodeURIComponent(id)}`, { headers: auth() }), 'read');
    expect(read.id).toBe(id);
    expect(['paid', 'delivered']).toContain(read.status);

    if (WAIT_DELIVERED) {
      await expect
        .poll(
          async () => (await json(await request.get(`${API}/transactions/${encodeURIComponent(id)}`, { headers: auth() }), 'poll')).status,
          { message: 'the worker settles the sandbox transfer on the mock rail', timeout: 7 * 60_000, intervals: [15_000] },
        )
        .toBe('delivered');
    }
  });
});
