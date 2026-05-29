# PaymentProvider + Confirmation Webhook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the "we never touch the money" settlement-integration **scaffold** — a pluggable `PaymentProvider` abstraction behind the settlement flow plus a confirmation webhook that drives transfer status — so a real licensed money-transmitter partner (Uniteller-shaped) can be swapped in later **without touching the agent or the UI**. Today `POST /api/pay/[transferId]` inlines the whole two-stage delivery (`completePaymentStage1` → sender "Payment received" text, then a `after()` + `setTimeout(DELIVERY_DELAY_MS=120000)` self-advance → `completePaymentStage2` → sender "delivered" text + recipient `transfer_delivered` template). This batch extracts that into a `MockPaymentProvider` that reproduces it **byte-for-byte**, refactors the route to delegate through `getPaymentProvider(store).initiateTransfer(transfer)`, and adds an **additive** `POST /api/payment-webhook/[provider]` route (HMAC-verified for real providers, no-op for the mock) that drives status via a new **idempotent, forward-only** `store.updateTransferFromWebhook`. Shipped fully **dormant**: the default provider is the mock, every existing transfer flows through today's exact path, and the existing ~498-test suite staying green — especially `tests/payment.test.ts` and the pay-flow path in `tests/e2e.test.ts`, both **unmodified** — is the executable proof.

**Architecture:** This batch stacks on the merged platform-reshape line (currently `spec/p4-multi-currency`). It mirrors the existing provider-seam pattern in `src/lib/providers/` — `KycProvider`/`MockKycProvider` (`kyc-provider.ts`/`mock-kyc-provider.ts`) and `SanctionsScreener`/`MockSanctionsScreener` + `getSanctionsScreener` (`sanctions-provider.ts`) — with a new domain: `PaymentProvider`/`MockPaymentProvider` + `getPaymentProvider(store)`. The mock delegates to the **unchanged** `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams` in `payment.ts` and keeps the **same** `after()`/`setTimeout(120000)` self-advance — `payment.ts` is never touched. A real provider would instead drive stage 2 via the webhook (`initiateTransfer` returns immediately after posting a settlement instruction).

```
Customer pays:  POST /api/pay/[transferId]            src/app/api/pay/[transferId]/route.ts
  │  store = getStore(); transfer = store.getTransfer(id)
  │  provider = getPaymentProvider(store)               ← NEW factory (default = mock)
  ▼  { providerRef } = provider.initiateTransfer(transfer)   ← persisted onto Transfer.paymentProviderRef
  │
  ├── MOCK (default — DORMANT, byte-for-byte today) ────────────────────────┐
  │     completePaymentStage1(store, id)  → 'paid'   + sender "received"     │
  │     after(async () => { sleep DELIVERY_DELAY_MS (120000);                │
  │        completePaymentStage2(store, id) → 'delivered'                    │
  │        + sender "delivered" sendText                                     │
  │        + recipient transfer_delivered sendTemplate })   (self-advances)  │
  │                                                                          │
  └── REAL PARTNER (Uniteller-shaped — NOT BUILT, documented) ──────────────┘
        initiateTransfer POSTs a settlement instruction; returns providerRef
        partner posts callbacks: created → funded → paid_out
                                       ▼
        POST /api/payment-webhook/[provider]   src/app/api/payment-webhook/[provider]/route.ts (NEW)
          verifyWebhookSignature(raw, sig, secret)   ← real providers only; mock skips
          provider.handleWebhook(body) → { transferId, status } | null
          store.updateTransferFromWebhook(transferId, status)   ← IDEMPOTENT, FORWARD-ONLY
            'funded'   ⇒ 'paid';  'paid_out' ⇒ 'delivered'  (never regress)
          on terminal 'delivered' transition ⇒ fire stage-2 notifications once
```

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, Upstash Redis, Node `crypto` (HMAC, `timingSafeEqual`).

**Spec:** `docs/superpowers/specs/2026-05-29-payment-provider-seam-design.md`

**Branch:** `spec/payment-provider-seam` (branch off the merged base — `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams` in `payment.ts`, the inline-timer pay route, `sendText`/`sendTemplate`/`RECIPIENT_TEMPLATE_NAME`/`RECIPIENT_TEMPLATE_LANG` in `whatsapp.ts`, `Store.getTransfer`/`saveTransfer` + `transfers:ids` set in `store.ts`, `Transfer`/`TransferStatus` in `types.ts`, and the `KycProvider`/`MockKycProvider`/`getSanctionsScreener` seam are all already present on the working base here).

**Test count delta:** from **498** (56 files in `tests/`). New `tests/payment-provider.test.ts` (~10), `tests/payment-webhook-route.test.ts` (~6), `tests/payment-webhook-verify.test.ts` (~3); extensions to `tests/store.test.ts` (~8) and `tests/env.test.ts` (~2). Net **+~29 → ~527**. `tests/payment.test.ts` and `tests/e2e.test.ts` are **unmodified** — their green is the executable **dormancy proof**.

**Patterns to reuse (do not reinvent):**
- **Provider seam (the thing being mirrored):** `src/lib/providers/kyc-provider.ts` (interface), `src/lib/providers/mock-kyc-provider.ts` (mock class taking collaborators by constructor; `handleWebhook` returns `null`; `getStatus` derives from store via a `mock-<id>` ref), `src/lib/providers/sanctions-provider.ts` (`getSanctionsScreener` factory — the single switch point). `PaymentProvider`/`MockPaymentProvider`/`getPaymentProvider` are byte-for-byte the same shape, new domain.
- **Unchanged settlement stages:** `src/lib/payment.ts` `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams` — the mock and the webhook both DELEGATE to these; they are never edited. `payment.test.ts`/`e2e.test.ts` call them directly with `fakeRedis()` and assert on the returned `StageResult.senderMessages` (no WhatsApp stub) — that is why the stages must stay pure and untouched.
- **`after()`/`setTimeout` self-advance:** moved verbatim from `route.ts:37-55` into `MockPaymentProvider.initiateTransfer`; the literal `DELIVERY_DELAY_MS = 120000` moves with it (the route no longer owns the timer; `maxDuration = 300` stays).
- **Env optional-getter pattern:** `src/lib/env.ts` `cronSecret`/`seedPartner*` return `''` when unset (`process.env.X ?? ''`). `paymentProviderMode` is a getter defaulting to `'mock'`; `paymentWebhookSecret(provider)` is a **method** (keyed by provider name) returning `''` when unconfigured.
- **Redis-backed singleton factory:** `src/lib/daily-volume-store.ts` / `src/lib/store.ts` `getStore()` — `new Redis({ url: env.kvUrl, token: env.kvToken, automaticDeserialization: false })`, cached module-level. `getPaymentProvider(store)` takes the store (the mock needs it to run the stages); no new Redis client.
- **Store method beside `saveTransfer`:** `updateTransferFromWebhook` reuses `getTransfer` (with its lazy-fill) + `saveTransfer` (which re-adds to `transfers:ids`) — no new key namespace, no migration.
- **Untrusted input, defensive:** the webhook body is untrusted — raw text read first for HMAC, JSON parse wrapped (malformed → 400), every field `?? ''`-guarded inside `handleWebhook`, unknown id → `null` no-op, status updates idempotent + forward-only via a `STATUS_RANK`. `crypto.timingSafeEqual` constant-time compare; fail-closed (unconfigured secret → 401). `??` not `||`; no `as any`; `fakeRedis()` in tests; commit prefix `feat(pay-seam):`.
- **Bot stays provider-blind:** the agent/prompt/tools never learn which provider settles and never see `paymentProviderRef`; the webhook is an API route, not a server action, and feeds no provider identity into chat content (`bot-content-guard` invariants unaffected).

**CI reminders:**
- `main` branch protection requires the `ci / ci` status check; no direct pushes. Open a PR; Vercel auto-deploys on merge; Playwright smoke runs against prod.
- The full local gate is `npm run typecheck && npm run lint && npx vitest run && npm run build`.
- `tests/payment.test.ts` and `tests/e2e.test.ts` must stay green **and unmodified** — the dormancy proof. If either needs editing to pass, the mock has drifted from today's behavior; fix the mock, not the test.
- GitGuardian may red on the known env-var-name false positive; `ci` is the required check.

---

## File Map

**New files:**
- `src/lib/providers/payment-provider.ts` — `PaymentProvider` interface, `MockPaymentProvider` class, `getPaymentProvider(store)` factory, `DELIVERY_DELAY_MS`, `PaymentProviderStatus`/`InitiateResult`/`WebhookResult` types + the documented Uniteller-shaped contract as a doc-comment.
- `src/lib/providers/payment-webhook-verify.ts` — pure `verifyWebhookSignature(rawBody, signature, secret)` (HMAC-SHA256, constant-time compare, fail-closed).
- `src/app/api/payment-webhook/[provider]/route.ts` — additive confirmation-webhook POST handler.
- `tests/payment-provider.test.ts` — mock provider + factory unit tests (~10).
- `tests/payment-webhook-verify.test.ts` — HMAC helper unit tests (~3).
- `tests/payment-webhook-route.test.ts` — webhook route logic-level tests (~6).

**Modified files:**
- `src/lib/types.ts` — `Transfer.paymentProviderRef?: string` (optional; `TransferStatus` unchanged).
- `src/lib/store.ts` — new `updateTransferFromWebhook(transferId, status)` (idempotent, forward-only) + module-level `STATUS_RANK`.
- `src/lib/env.ts` — `paymentProviderMode` getter (default `'mock'`) + `paymentWebhookSecret(provider)` method + `PaymentProviderMode` type.
- `src/app/api/pay/[transferId]/route.ts` — route settlement through `getPaymentProvider(store).initiateTransfer`; remove the inline stage-1/stage-2 timer block (and its `payment`/`whatsapp` imports); persist `paymentProviderRef` without clobbering the stage-1 write; `maxDuration = 300` + `{ ok: true, status: 'paid' }` + 400-on-error preserved.
- `.env.example` — document `PAYMENT_PROVIDER_MODE` + `PAYMENT_WEBHOOK_SECRET_<PROVIDER>`.
- `tests/store.test.ts`, `tests/env.test.ts` — extensions.

> Deliberately **not** modified: `src/lib/payment.ts`, `tests/payment.test.ts`, `tests/e2e.test.ts`, `src/lib/agent.ts`, `src/lib/prompt.ts`, `src/lib/tools.ts`, any dashboard page. The agent/UI are untouched by design.

---

## Task 1: `Transfer.paymentProviderRef?` optional field

**Goal:** Add one optional field to `Transfer` so the route can persist the partner settlement id (`mock-<id>` in mock mode). `TransferStatus` is **unchanged** — provider statuses map *into* the existing `'paid'`/`'delivered'` values. Mirrors the `Customer.kycProviderRef?` precedent.

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add the optional field**

In `src/lib/types.ts`, inside `export interface Transfer` (lines 27–57), after `totalChargeSource: number;` (line 56) — beside the existing optional KYC Travel-Rule fields that follow — add:

```ts
  // ── Payment-provider seam (pay-seam) — optional (dormant) ──
  paymentProviderRef?: string;   // partner's settlement id; the mock sets `mock-<transfer.id>`
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean. The field is optional, so no existing `Transfer` literal (in `transfer-create.ts`, `payment.ts`, fixtures) needs updating.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(pay-seam): Transfer.paymentProviderRef optional field (TransferStatus unchanged)"
```

---

## Task 2: `verifyWebhookSignature` — pure HMAC helper, TDD'd

**Goal:** A small pure helper that verifies an HMAC-SHA256 signature over a raw request body with a constant-time compare. **Fail-closed:** an empty secret or empty signature returns `false`. Built and tested first so the webhook route (Task 5) can lean on it.

**Files:**
- Create: `src/lib/providers/payment-webhook-verify.ts`
- Test: `tests/payment-webhook-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/payment-webhook-verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';

const SECRET = 'test-secret';
const BODY = JSON.stringify({ reference: 'pay_123', status: 'paid_out' });
const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhookSignature', () => {
  it('accepts a valid HMAC-SHA256 over the raw body', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), SECRET)).toBe(true);
  });
  it('rejects a tampered body (signature no longer matches)', () => {
    const sig = sign(BODY);
    expect(verifyWebhookSignature(BODY + 'x', sig, SECRET)).toBe(false);
  });
  it('rejects a tampered signature', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY) + '00', SECRET)).toBe(false);
  });
  it('fails closed on an empty secret', () => {
    expect(verifyWebhookSignature(BODY, sign(BODY), '')).toBe(false);
  });
  it('fails closed on an empty/garbage signature', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, 'not-hex', SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/payment-webhook-verify.test.ts`
Expected: FAIL — module `@/lib/providers/payment-webhook-verify` not found.

- [ ] **Step 3: Implement `src/lib/providers/payment-webhook-verify.ts`**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify an HMAC-SHA256 signature over the RAW request body. Real payment
 * providers present this; the mock skips verification (its handleWebhook is a
 * no-op). Fail-CLOSED: an empty secret or signature returns false, so an
 * unconfigured real provider is rejected rather than silently trusted.
 * Algorithm is fixed to sha256 for v1; a partner with a different scheme would
 * parameterize this once a real spec exists (spec open question 6).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string,
): boolean {
  const sig = signature ?? '';
  const key = secret ?? '';
  if (key === '' || sig === '') return false;            // fail-closed
  const expected = createHmac('sha256', key).update(rawBody ?? '').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length) return false;               // timingSafeEqual requires equal length
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payment-webhook-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/payment-webhook-verify.ts tests/payment-webhook-verify.test.ts
git commit -m "feat(pay-seam): verifyWebhookSignature (HMAC-SHA256, constant-time, fail-closed)"
```

---

## Task 3: `PaymentProvider` interface + `MockPaymentProvider` + factory

**Goal:** Create the seam — `PaymentProvider` interface, a `MockPaymentProvider` that reproduces today's two-stage flow **byte-for-byte** by delegating to the unchanged `payment.ts` stages with the **same** `after()`/`setTimeout(DELIVERY_DELAY_MS=120000)` self-advance, and a `getPaymentProvider(store)` factory. Mirrors `kyc-provider.ts`/`mock-kyc-provider.ts`/`getSanctionsScreener` exactly. `payment.ts` is **not** edited.

**Files:**
- Create: `src/lib/providers/payment-provider.ts`
- Test: `tests/payment-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/payment-provider.test.ts`. Stub `next/server`'s `after` so the scheduled stage-2 callback can be captured and flushed deterministically, and stub `whatsapp` so `sendText`/`sendTemplate` are asserted on (the mock — unlike the pure stages — DOES call WhatsApp). Use `vi.useFakeTimers()` to drive the 120000 ms sleep:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

// Capture the after() callback so we can flush stage 2 deterministically.
const afterCbs: Array<() => Promise<void> | void> = [];
vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => { afterCbs.push(cb); },
}));

const sendText = vi.fn(async () => {});
const sendTemplate = vi.fn(async () => {});
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

import {
  MockPaymentProvider, getPaymentProvider, DELIVERY_DELAY_MS,
} from '@/lib/providers/payment-provider';

function fixture(): Transfer {
  return {
    id: 'pay_seam_1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    status: 'awaiting_payment', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-05-29T00:00:00Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

beforeEach(() => { afterCbs.length = 0; sendText.mockClear(); sendTemplate.mockClear(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('DELIVERY_DELAY_MS', () => {
  it('is the same 120000ms (2 min) the route used today', () => {
    expect(DELIVERY_DELAY_MS).toBe(120000);
  });
});

describe('MockPaymentProvider.initiateTransfer (stage 1 — byte-for-byte today)', () => {
  it('marks the transfer paid, sends the sender "received" text, returns mock-<id>', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(fixture());
    const provider = new MockPaymentProvider(store);

    const { providerRef } = await provider.initiateTransfer(fixture());

    expect(providerRef).toBe('mock-pay_seam_1');
    expect((await store.getTransfer('pay_seam_1'))!.status).toBe('paid');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][0]).toBe('15551230000');
    expect(sendText.mock.calls[0][1]).toContain('Payment received');
    // stage 2 is registered but NOT yet run
    expect(afterCbs).toHaveLength(1);
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe('MockPaymentProvider stage 2 self-advance (after the 120000ms sleep)', () => {
  it('marks delivered, sends sender "delivered" text + recipient template after the delay', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(fixture());
    const provider = new MockPaymentProvider(store);
    await provider.initiateTransfer(fixture());
    sendText.mockClear();

    // Drive the registered after() callback through the 120000ms timer.
    const run = afterCbs[0]();
    await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS);
    await run;

    expect((await store.getTransfer('pay_seam_1'))!.status).toBe('delivered');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toContain('delivered');
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][0]).toBe('919876543210');
    expect(sendTemplate.mock.calls[0][1]).toBe('transfer_delivered');
    expect(sendTemplate.mock.calls[0][2]).toBe('en');
    // recipientTemplateParams → [recipientName, amountInr, sender, destination]
    expect(sendTemplate.mock.calls[0][3]).toEqual(['Mom', '16,600', '+15551230000', 'UPI ID']);
  });

  it('skips the recipient template when there is no recipientPhone', async () => {
    const store = createStore(fakeRedis());
    const t = fixture(); t.recipientPhone = '';
    await store.saveTransfer(t);
    const provider = new MockPaymentProvider(store);
    await provider.initiateTransfer(t);
    const run = afterCbs[0](); await vi.advanceTimersByTimeAsync(DELIVERY_DELAY_MS); await run;
    expect(sendTemplate).not.toHaveBeenCalled();
  });
});

describe('MockPaymentProvider.getStatus (derives from stored TransferStatus)', () => {
  it('maps awaiting_payment→created, paid→funded, delivered→paid_out', async () => {
    const store = createStore(fakeRedis());
    const t = fixture(); await store.saveTransfer(t);
    const provider = new MockPaymentProvider(store);
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('created');
    await store.saveTransfer({ ...t, status: 'paid' });
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('funded');
    await store.saveTransfer({ ...t, status: 'delivered' });
    expect(await provider.getStatus('mock-pay_seam_1')).toBe('paid_out');
  });
  it('returns created for an unknown / malformed ref', async () => {
    const provider = new MockPaymentProvider(createStore(fakeRedis()));
    expect(await provider.getStatus('mock-nope')).toBe('created');
    expect(await provider.getStatus('garbage')).toBe('created');
  });
});

describe('MockPaymentProvider.handleWebhook + factory', () => {
  it('handleWebhook is a no-op returning null (mirrors MockKycProvider)', async () => {
    const provider = new MockPaymentProvider(createStore(fakeRedis()));
    expect(await provider.handleWebhook({ any: 'thing' })).toBeNull();
  });
  it('getPaymentProvider returns the mock under the default mode', () => {
    const provider = getPaymentProvider(createStore(fakeRedis()));
    expect(provider).toBeInstanceOf(MockPaymentProvider);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/payment-provider.test.ts`
Expected: FAIL — module `@/lib/providers/payment-provider` not found.

- [ ] **Step 3: Implement `src/lib/providers/payment-provider.ts`**

Move the timer + stage logic verbatim from `route.ts:17,37-55`; delegate to the unchanged `payment.ts` stages. Mirror `MockKycProvider`'s constructor-injection + `getStatus` `mock-<id>` parse + `handleWebhook` null no-op:

```ts
import { after } from 'next/server';
import type { Store } from '../store';
import type { Transfer, TransferStatus } from '../types';
import {
  completePaymentStage1, completePaymentStage2, recipientTemplateParams,
} from '../payment';
import {
  sendText, sendTemplate, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '../whatsapp';

export const DELIVERY_DELAY_MS = 120000; // 2 minutes — moved from the pay route, SAME value

// Provider-side lifecycle, mapped to our TransferStatus in handleWebhook/update.
// created → 'awaiting_payment'; funded → 'paid'; paid_out → 'delivered'.
export type PaymentProviderStatus = 'created' | 'funded' | 'paid_out' | 'failed';

export interface InitiateResult {
  providerRef: string;          // partner's settlement id; persisted onto Transfer.paymentProviderRef
}

export interface WebhookResult {
  transferId: string;           // OUR transfer id (the partner echoes it back)
  status: TransferStatus;       // already mapped to our domain ('paid' | 'delivered')
}

/**
 * The pluggable settlement seam, mirroring KycProvider / SanctionsScreener.
 *
 * A REAL Uniteller-shaped partner (the AD-II / money-transmitter of record per
 * ROADMAP Lane C) implements this against the documented contract — SendHome
 * NEVER holds funds:
 *
 *   initiateTransfer POSTs a settlement instruction:
 *     { reference: transfer.id,
 *       corridor: { source: transfer.sourceCountry, destination: 'IN' },
 *       payout:   { rail: transfer.payoutMethod, destination: transfer.payoutDestination },
 *       recipient:{ name: transfer.recipientName, phone: transfer.recipientPhone },
 *       amount:   { source: transfer.amountSource, currency: transfer.sourceCurrency,
 *                   destination: transfer.amountInr, destinationCurrency: 'INR',
 *                   fxRate: transfer.fxRate } }     // FX LOCKED at quote time
 *     → 200 { providerRef } → becomes Transfer.paymentProviderRef
 *
 *   The partner then posts status callbacks to POST /api/payment-webhook/[provider]:
 *     created  → 'awaiting_payment'  (no-op)
 *     funded   → 'paid'              (stage-1 effect)
 *     paid_out → 'delivered'         (fires stage-2 notifications once)
 *     failed   → (not mapped in v1; logged/ignored — reversal is out of scope)
 *
 * No real client is built in this batch; the contract is documented here only.
 */
export interface PaymentProvider {
  // Begin settlement. Mock self-advances both stages; a real provider POSTs
  // the instruction and returns, settling asynchronously via the webhook.
  initiateTransfer(transfer: Transfer): Promise<InitiateResult>;
  // Poll provider-side status (real: API call; mock: derive from the store).
  getStatus(providerRef: string): Promise<PaymentProviderStatus>;
  // Parse + map an inbound callback to our domain, or null if irrelevant.
  handleWebhook(body: unknown): Promise<WebhookResult | null>;
}

export class MockPaymentProvider implements PaymentProvider {
  constructor(private readonly store: Store) {}

  async initiateTransfer(transfer: Transfer): Promise<InitiateResult> {
    // Stage 1 — identical to today's route body (payment.ts UNTOUCHED).
    const { transfer: t1, senderMessages } = await completePaymentStage1(this.store, transfer.id);
    for (const msg of senderMessages) await sendText(t1.phone, msg);

    // Stage 2 — the SAME after()/setTimeout(DELIVERY_DELAY_MS) self-advance.
    after(async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, DELIVERY_DELAY_MS));
        const stage2 = await completePaymentStage2(this.store, transfer.id);
        for (const msg of stage2.senderMessages) await sendText(stage2.transfer.phone, msg);
        if (stage2.transfer.recipientPhone) {
          await sendTemplate(
            stage2.transfer.recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
            recipientTemplateParams(stage2.transfer),
          );
        }
      } catch (err) {
        console.error('Stage-2 delivery failed:', err);
      }
    });

    return { providerRef: `mock-${transfer.id}` };
  }

  async getStatus(providerRef: string): Promise<PaymentProviderStatus> {
    const id = providerRef.startsWith('mock-') ? providerRef.slice('mock-'.length) : null;
    const t = id ? await this.store.getTransfer(id) : null;
    if (!t) return 'created';
    if (t.status === 'delivered') return 'paid_out';
    if (t.status === 'paid') return 'funded';
    return 'created';
  }

  // The mock self-advances and never posts callbacks → no-op (mirrors MockKycProvider).
  async handleWebhook(_body: unknown): Promise<WebhookResult | null> {
    return null;
  }
}

/**
 * Single switch point (mirrors getSanctionsScreener). v1 has only the mock;
 * a real provider is added here, selected by env.paymentProviderMode — no
 * call-site change. Takes `store` because the mock runs the stages against it.
 */
export function getPaymentProvider(store: Store): PaymentProvider {
  return new MockPaymentProvider(store);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payment-provider.test.ts`
Expected: PASS — all ~10 cases.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. The route still has its own inline timer (refactored in Task 4); nothing imports the new module yet outside the test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/payment-provider.ts tests/payment-provider.test.ts
git commit -m "feat(pay-seam): PaymentProvider + MockPaymentProvider + getPaymentProvider (byte-for-byte mock)"
```

---

## Task 4: Refactor the pay route to route through the provider

**Goal:** Replace the inline stage-1 + `after()` stage-2 block in `POST /api/pay/[transferId]` with one call to `getPaymentProvider(store).initiateTransfer(transfer)`, and persist `paymentProviderRef` without clobbering the stage-1 `'paid'` write. **No behavior change in mock mode** — the response shape, 400-on-error, and `maxDuration = 300` are all preserved. This is the dormancy-critical refactor; `payment.test.ts`/`e2e.test.ts` stay green and unmodified.

**Files:**
- Modify: `src/app/api/pay/[transferId]/route.ts`

> **Note — no new route test here.** The pay route has no dedicated unit test today (it is exercised end-to-end through the unmodified `payment.test.ts`/`e2e.test.ts` stage tests and Task 3's provider tests). The proof of this task is the full suite staying green plus typecheck; do not add a route harness for the pay route (the provider tests already cover the delegated behavior).

- [ ] **Step 1: Confirm the baseline is green before refactoring**

Run: `npx vitest run tests/payment.test.ts tests/e2e.test.ts`
Expected: PASS — capture this as the byte-for-byte baseline. These two files must read identically after this task.

- [ ] **Step 2: Rewrite `src/app/api/pay/[transferId]/route.ts`**

Replace the whole file. Drop the `payment`/`whatsapp`/`DELIVERY_DELAY_MS` symbols (they now live in the provider); import only `getStore` + `getPaymentProvider`. Re-read the transfer after `initiateTransfer` (the mock mutated status to `'paid'` inside it) and write the ref only if unset (guard against overwrite):

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';

export const maxDuration = 300; // unchanged — the mock still sleeps 120s inside after()

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const { transferId } = await params;
  try {
    const store = getStore();
    const transfer = await store.getTransfer(transferId);
    if (!transfer) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }

    const provider = getPaymentProvider(store);
    // Stage 1 + (mock) self-advancing stage 2 — payment.ts stages are unchanged.
    const { providerRef } = await provider.initiateTransfer(transfer);

    // Persist the settlement ref WITHOUT clobbering the 'paid' write initiateTransfer
    // just made: re-read, write the ref only when not already set, spread-merge.
    const settled = await store.getTransfer(transferId);
    if (settled && !settled.paymentProviderRef) {
      await store.saveTransfer({ ...settled, paymentProviderRef: providerRef });
    }

    return NextResponse.json({ ok: true, status: 'paid' });
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
```

> The `404` on a missing transfer is a small additive improvement over today's behavior (today a missing transfer throws inside `completePaymentStage1` → caught → `400`). If you want strict byte-for-byte parity on the error path, drop the early `404` and let the not-found throw flow into the `catch` → `400`; either is acceptable since the pay page only consumes `ok`. Keep whichever the reviewer prefers — the success path is what dormancy hinges on.

- [ ] **Step 3: Run the dormancy-proof suites + the provider test**

Run: `npx vitest run tests/payment.test.ts tests/e2e.test.ts tests/payment-provider.test.ts`
Expected: PASS — `payment.test.ts`/`e2e.test.ts` **unchanged** and green (they call the stages directly, which are untouched); the provider test green.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. The route no longer imports `payment`/`whatsapp` symbols.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/pay/[transferId]/route.ts"
git commit -m "feat(pay-seam): pay route delegates settlement to getPaymentProvider(store).initiateTransfer"
```

---

## Task 5: `store.updateTransferFromWebhook` — idempotent, forward-only

**Goal:** A new store method beside `saveTransfer` that advances a transfer's status from a (mapped) webhook callback — **idempotent + forward-only**: `awaiting_payment`→`paid`→`delivered`, never regressing, no-op on unknown id / duplicate / backward / `cancelled` / `blocked`. Returns the updated `Transfer` only on a **real** transition (the webhook route uses this truthiness to fire notifications exactly once). This is the heart of webhook safety.

**Files:**
- Modify: `src/lib/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/store.test.ts` (it already imports `createStore` + `fakeRedis`). Seed a transfer via `saveTransfer`, then drive callbacks:

```ts
import type { Transfer } from '@/lib/types';

function seedTransfer(status: Transfer['status'] = 'awaiting_payment'): Transfer {
  return {
    id: 'wh_1', phone: '15551230000', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    status, complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-05-29T00:00:00Z', partnerId: 'default',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
  } as Transfer;
}

describe('updateTransferFromWebhook (idempotent, forward-only)', () => {
  it('advances awaiting_payment → paid and sets paidAt', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(seedTransfer());
    const r = await store.updateTransferFromWebhook('wh_1', 'paid');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('paid');
    expect(r!.paidAt).toBeTruthy();
  });

  it('advances paid → delivered and sets deliveredAt (keeps paidAt)', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(seedTransfer('paid'));
    const r = await store.updateTransferFromWebhook('wh_1', 'delivered');
    expect(r!.status).toBe('delivered');
    expect(r!.deliveredAt).toBeTruthy();
  });

  it('is IDEMPOTENT: a duplicate paid_out (delivered) callback returns null, no re-save', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(seedTransfer('delivered'));
    expect(await store.updateTransferFromWebhook('wh_1', 'delivered')).toBeNull();
  });

  it('is FORWARD-ONLY: a backward funded (paid) after delivered is ignored', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(seedTransfer('delivered'));
    expect(await store.updateTransferFromWebhook('wh_1', 'paid')).toBeNull();
    expect((await store.getTransfer('wh_1'))!.status).toBe('delivered'); // never regressed
  });

  it('no-ops on an unknown transferId (untrusted body)', async () => {
    const store = createStore(fakeRedis());
    expect(await store.updateTransferFromWebhook('nope', 'paid')).toBeNull();
  });

  it('refuses to advance a cancelled transfer (terminal-protected)', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(seedTransfer('cancelled'));
    expect(await store.updateTransferFromWebhook('wh_1', 'delivered')).toBeNull();
    expect((await store.getTransfer('wh_1'))!.status).toBe('cancelled');
  });

  it('refuses to advance a blocked transfer (terminal-protected)', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(seedTransfer('blocked'));
    expect(await store.updateTransferFromWebhook('wh_1', 'paid')).toBeNull();
  });

  it('returns the updated Transfer only on a real transition', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(seedTransfer());
    expect((await store.updateTransferFromWebhook('wh_1', 'paid'))!.id).toBe('wh_1'); // real
    expect(await store.updateTransferFromWebhook('wh_1', 'paid')).toBeNull();          // dup → null
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `updateTransferFromWebhook` is not a method on the store.

- [ ] **Step 3: Implement `updateTransferFromWebhook` in `src/lib/store.ts`**

Add `STATUS_RANK` at module level (near the top, beside the other module constants), and the method inside the object returned by `createStore` (beside `saveTransfer`, which it reuses):

```ts
// Forward-only rank; higher = further along. Side/terminal states are never regressed.
const STATUS_RANK: Record<TransferStatus, number> = {
  blocked: -1, cancelled: -1, awaiting_payment: 0, paid: 1, delivered: 2,
};
```

```ts
    async updateTransferFromWebhook(
      transferId: string,
      status: TransferStatus,          // already mapped to our domain by handleWebhook
    ): Promise<Transfer | null> {
      const transfer = await this.getTransfer(transferId);
      if (!transfer) return null;                                   // unknown id → no-op (untrusted)
      if (transfer.status === 'cancelled' || transfer.status === 'blocked') return null; // terminal
      // Never regress: ignore anything not strictly forward of the current status.
      if (STATUS_RANK[status] <= STATUS_RANK[transfer.status]) return null; // dup / out-of-order / back
      const now = new Date().toISOString();
      const updated: Transfer = {
        ...transfer,
        status,
        paidAt: status === 'paid' || status === 'delivered' ? (transfer.paidAt ?? now) : transfer.paidAt,
        deliveredAt: status === 'delivered' ? now : transfer.deliveredAt,
      };
      await this.saveTransfer(updated);
      return updated;                                               // non-null ⇒ a real transition
    },
```

> Ensure `TransferStatus` is imported in `store.ts` (it imports from `./types` already — add `TransferStatus` to that import if not present). `STATUS_RANK` lives at module scope so `this.` is not needed for it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS — all ~8 new cases plus the existing store tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/store.ts tests/store.test.ts
git commit -m "feat(pay-seam): store.updateTransferFromWebhook (idempotent, forward-only)"
```

---

## Task 6: Env config — `paymentProviderMode` + `paymentWebhookSecret`

**Goal:** Add the mode toggle (default `'mock'`) + a per-provider HMAC secret method (`''` when unset → the webhook fails closed), following the existing `cronSecret`/`seedPartner*` optional-getter pattern. Document both in `.env.example`. The env var is a forward hook — v1 always resolves to the mock.

**Files:**
- Modify: `src/lib/env.ts`, `.env.example`
- Test: `tests/env.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/env.test.ts` (mirror its existing `process.env` save/restore pattern):

```ts
describe('paymentProviderMode', () => {
  it("defaults to 'mock' when unset", () => {
    delete process.env.PAYMENT_PROVIDER_MODE;
    expect(env.paymentProviderMode).toBe('mock');
  });
  it("stays 'mock' even when an unknown value is set (v1 only supports mock)", () => {
    process.env.PAYMENT_PROVIDER_MODE = 'uniteller';
    expect(env.paymentProviderMode).toBe('mock');
  });
});

describe('paymentWebhookSecret(provider)', () => {
  it("returns '' when the per-provider secret is unset (fail-closed)", () => {
    delete process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER;
    expect(env.paymentWebhookSecret('uniteller')).toBe('');
  });
  it('returns the configured secret keyed by upper-cased provider name', () => {
    process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER = 's3cret';
    expect(env.paymentWebhookSecret('uniteller')).toBe('s3cret');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/env.test.ts`
Expected: FAIL — `paymentProviderMode`/`paymentWebhookSecret` not on `env`.

- [ ] **Step 3: Add to `src/lib/env.ts`**

Add the type above `export const env` and the two members inside the object (before the closing `};` on line ~63), following the `cronSecret` `?? ''` pattern:

```ts
export type PaymentProviderMode = 'mock'; // v1: mock only; real modes added when a partner lands
```

```ts
  get paymentProviderMode(): PaymentProviderMode {
    // Default + only supported value in v1 — a forward hook, not a live switch.
    return process.env.PAYMENT_PROVIDER_MODE === 'mock' ? 'mock' : 'mock';
  },
  paymentWebhookSecret(provider: string): string {
    // Per-provider HMAC secret, e.g. PAYMENT_WEBHOOK_SECRET_UNITELLER.
    // '' ⇒ unconfigured ⇒ the webhook rejects (fail-closed; never fail-open).
    return process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? '';
  },
```

> `paymentWebhookSecret` is a **method** (not a getter) because it is keyed by the provider name. `paymentProviderMode` is a getter mirroring the existing getters.

- [ ] **Step 4: Document in `.env.example`**

Add (with comments, no literal secret values — CLAUDE.md rule):

```
# Payment-provider seam (pay-seam). v1 only supports 'mock' (default). Forward hook.
PAYMENT_PROVIDER_MODE=mock
# Per-provider webhook HMAC secret, keyed by upper-cased provider name.
# Unset ⇒ the /api/payment-webhook/<provider> route rejects real-provider callbacks (fail-closed).
# PAYMENT_WEBHOOK_SECRET_UNITELLER=
```

- [ ] **Step 5: Run test to verify it passes + typecheck**

Run: `npx vitest run tests/env.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/env.ts .env.example tests/env.test.ts
git commit -m "feat(pay-seam): env.paymentProviderMode (default mock) + paymentWebhookSecret(provider)"
```

---

## Task 7: Confirmation webhook route — `POST /api/payment-webhook/[provider]`

**Goal:** The additive inbound surface a **real** partner calls. Unauthenticated public POST → body untrusted → read raw text first, verify HMAC for non-mock providers (401 on bad/absent signature, fail-closed), parse JSON (malformed → 400), `handleWebhook` → `updateTransferFromWebhook`, and fire stage-2 notifications **exactly once** on the terminal `'delivered'` transition. The mock path skips verification (its `handleWebhook` is a no-op, so the demo never hits this). Reuses the **exact** stage-2 notification content via the unchanged `payment.ts` symbols + `whatsapp.ts`.

**Files:**
- Create: `src/app/api/payment-webhook/[provider]/route.ts`
- Test: `tests/payment-webhook-route.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/payment-webhook-route.test.ts`. Mirror `tests/whatsapp-route.test.ts`'s `NextRequest` mounting; stub `getStore`, `getPaymentProvider`, `whatsapp`, and `after`. Because the route reads a `process.env` secret, set it per-test:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHmac } from 'node:crypto';

// after() runs the notify callback inline so we can assert sends.
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return { ...real, after: (cb: () => Promise<void> | void) => { void cb(); } };
});

const sendText = vi.fn(async () => {});
const sendTemplate = vi.fn(async () => {});
vi.mock('@/lib/whatsapp', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  sendTemplate: (...a: unknown[]) => sendTemplate(...a),
  RECIPIENT_TEMPLATE_NAME: 'transfer_delivered',
  RECIPIENT_TEMPLATE_LANG: 'en',
}));

// In-memory store double + a controllable handleWebhook.
const updateTransferFromWebhook = vi.fn();
const handleWebhook = vi.fn();
vi.mock('@/lib/store', () => ({ getStore: () => ({ updateTransferFromWebhook }) }));
vi.mock('@/lib/providers/payment-provider', () => ({
  getPaymentProvider: () => ({ handleWebhook }),
}));

import { POST } from '@/app/api/payment-webhook/[provider]/route';

const deliveredTransfer = {
  id: 'wh_1', phone: '15551230000', amountInr: 16600, recipientName: 'Mom',
  recipientPhone: '919876543210', payoutMethod: 'upi', status: 'delivered',
};
const SECRET = 'uniteller-secret';
const body = JSON.stringify({ reference: 'wh_1', status: 'paid_out' });
const sig = (b: string, s = SECRET) => createHmac('sha256', s).update(b).digest('hex');

function post(provider: string, raw: string, signature?: string) {
  const req = new NextRequest('https://x/api/payment-webhook/' + provider, {
    method: 'POST', body: raw,
    headers: signature ? { 'x-signature': signature } : {},
  });
  return POST(req, { params: Promise.resolve({ provider }) });
}

beforeEach(() => {
  sendText.mockClear(); sendTemplate.mockClear();
  updateTransferFromWebhook.mockReset(); handleWebhook.mockReset();
  process.env.PAYMENT_WEBHOOK_SECRET_UNITELLER = SECRET;
});

describe('POST /api/payment-webhook/[provider]', () => {
  it('real provider with a BAD signature → 401, no mutation', async () => {
    const res = await post('uniteller', body, 'deadbeef');
    expect(res.status).toBe(401);
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('real provider, GOOD signature + paid_out → updates + fires stage-2 notifications once', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(deliveredTransfer);
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    expect(updateTransferFromWebhook).toHaveBeenCalledWith('wh_1', 'delivered');
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toContain('delivered');
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendTemplate.mock.calls[0][1]).toBe('transfer_delivered');
  });

  it('DUPLICATE paid_out (update returns null) → 200 but NO notification', async () => {
    handleWebhook.mockResolvedValue({ transferId: 'wh_1', status: 'delivered' });
    updateTransferFromWebhook.mockResolvedValue(null); // no real transition
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('malformed JSON → 400, no mutation', async () => {
    const raw = '{not json';
    const res = await post('uniteller', raw, sig(raw));
    expect(res.status).toBe(400);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('unparseable-but-valid-JSON (handleWebhook → null) → 200 ignored, no mutation', async () => {
    handleWebhook.mockResolvedValue(null);
    const res = await post('uniteller', body, sig(body));
    expect(res.status).toBe(200);
    expect(updateTransferFromWebhook).not.toHaveBeenCalled();
  });

  it('mock provider path → verification skipped (no signature needed)', async () => {
    handleWebhook.mockResolvedValue(null); // mock handleWebhook is a no-op
    const res = await post('mock', body); // no x-signature header
    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/payment-webhook-route.test.ts`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement `src/app/api/payment-webhook/[provider]/route.ts`**

```ts
import { NextRequest, NextResponse, after } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';
import { env } from '@/lib/env';
import { recipientTemplateParams } from '@/lib/payment';
import {
  sendText, sendTemplate, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';

function inr(amount: number): string {
  return amount.toLocaleString('en-IN');
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const raw = await req.text();                           // raw body first (for HMAC)
  const store = getStore();

  // Mock skips verification (it never posts callbacks); real providers MUST verify.
  if (provider !== 'mock') {
    const secret = env.paymentWebhookSecret(provider);    // '' if unconfigured
    const signature = req.headers.get('x-signature') ?? '';
    if (!verifyWebhookSignature(raw, signature, secret)) {
      return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 }); // malformed
  }

  const result = await getPaymentProvider(store).handleWebhook(body);
  if (!result) {
    return NextResponse.json({ ok: true, ignored: true });  // unparseable/irrelevant → 200, no mutation
  }

  const updated = await store.updateTransferFromWebhook(result.transferId, result.status);
  // Fire stage-2 notifications ONLY on a real terminal transition (non-null + delivered).
  if (updated && updated.status === 'delivered') {
    after(async () => {
      try {
        await sendText(
          updated.phone,
          `🎉 ₹${inr(updated.amountInr)} delivered to ${updated.recipientName}. Thanks for using SendHome!`,
        );
        if (updated.recipientPhone) {
          await sendTemplate(
            updated.recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
            recipientTemplateParams(updated),
          );
        }
      } catch (err) {
        console.error('Webhook stage-2 notify failed:', err);
      }
    });
  }
  return NextResponse.json({ ok: true });
}
```

> **Notification ownership (spec open question 1).** The sender "delivered" string here intentionally matches `completePaymentStage2`'s exact wording so a real-provider delivery is observationally identical to the mock's. The cleanest factoring is to extract a shared `deliverNotifications(transfer)` helper that both the mock provider and this route call; v1 duplicates the one-line string to keep this batch's diff tight, with the helper extraction flagged as the documented fast-follow. If the reviewer prefers, extract it now — it touches only `payment.ts` (additive export, the stage functions unchanged) and the two call sites.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/payment-webhook-route.test.ts`
Expected: PASS — all ~6 cases.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/payment-webhook/[provider]/route.ts" tests/payment-webhook-route.test.ts
git commit -m "feat(pay-seam): confirmation webhook route (HMAC-verified, idempotent, fires stage-2 once)"
```

---

## Task 8: Wrap — full verification, PR, post-merge runbook

**Files:** none (verification + git).

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean; the full suite green (~527 tests). The pre-batch ~498 staying green — `payment.test.ts`/`e2e.test.ts` unmodified — is the dormancy proof.

- [ ] **Step 2: Confirm the dormancy invariant by hand**

Verify the byte-for-byte claim explicitly:
- `git diff main -- src/lib/payment.ts tests/payment.test.ts tests/e2e.test.ts` → **empty** (those three are untouched).
- `DELIVERY_DELAY_MS === 120000` lives in the provider (Task 3 test); `maxDuration === 300` stays in the route (Task 4).
- `MockPaymentProvider.initiateTransfer` → status `'paid'` + sender "received" text, then after the 120000 ms `after()` sleep → `'delivered'` + sender "delivered" text + recipient `transfer_delivered`/`en` template with `recipientTemplateParams` (Task 3 tests).
- `getPaymentProvider` returns the mock under default `paymentProviderMode` (Task 3 + Task 6).
- `/api/payment-webhook/[provider]` exists but is never called by the demo; the mock's `handleWebhook` returns `null` so even a stray hit is a safe 200-ignored no-op.
- `updateTransferFromWebhook` is forward-only/idempotent/terminal-protected (Task 5).
- No agent/prompt/tools/dashboard file changed: `git diff --name-only main` lists only the files in the File Map.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin spec/payment-provider-seam
gh pr create --title "feat(pay-seam): PaymentProvider abstraction + confirmation webhook (dormant scaffold)" --body "$(cat <<'EOF'
## Summary
- Builds the "we never touch the money" settlement-integration SCAFFOLD: a pluggable `PaymentProvider` seam behind the settlement flow + a confirmation webhook that drives transfer status — so a real licensed money-transmitter partner (Uniteller-shaped) can be swapped in later WITHOUT touching the agent or UI. NO real partner is integrated (no credentials, no HTTP client, no real money movement) — this is the seam + a mock.
- Mirrors the existing provider seam (`KycProvider`/`MockKycProvider`, `getSanctionsScreener`): new `src/lib/providers/payment-provider.ts` with `PaymentProvider`/`MockPaymentProvider`/`getPaymentProvider(store)`.
- DORMANT: `MockPaymentProvider` reproduces today's two-stage flow byte-for-byte — `completePaymentStage1` + sender "received" text, then the SAME `after()` + `setTimeout(DELIVERY_DELAY_MS=120000)` self-advance → `completePaymentStage2` + sender "delivered" text + recipient `transfer_delivered` template. `payment.ts` is UNTOUCHED; `tests/payment.test.ts` + `tests/e2e.test.ts` are unmodified and green — the executable dormancy proof.
- Pay route now delegates to `getPaymentProvider(store).initiateTransfer(transfer)` instead of the inline timer; `{ ok: true, status: 'paid' }`, 400-on-error, and `maxDuration = 300` preserved; `paymentProviderRef` persisted without clobbering the stage-1 write.
- NEW additive `POST /api/payment-webhook/[provider]`: HMAC-verified for real providers (401 fail-closed, constant-time compare), skipped for the mock; `handleWebhook` → `store.updateTransferFromWebhook` (idempotent, forward-only — never regresses `delivered`→`paid`, terminal-protects `cancelled`/`blocked`); fires stage-2 notifications exactly once on the terminal `delivered` transition. The mock demo never calls it.
- `Transfer.paymentProviderRef?` (optional; `TransferStatus` unchanged); `env.paymentProviderMode` (default `mock`) + `env.paymentWebhookSecret(provider)`; `.env.example` documents both. Uniteller-shaped settlement-instruction contract documented as an interface doc-comment — NO client built.

## Test plan
- [ ] typecheck / lint / vitest / build all green (~527 tests)
- [ ] `git diff main -- src/lib/payment.ts tests/payment.test.ts tests/e2e.test.ts` is empty (dormancy proof)
- [ ] New: `payment-provider` (mock byte-for-byte + factory), `payment-webhook-verify` (HMAC fail-closed), `payment-webhook-route` (401/400/200-ignored/once), `store.updateTransferFromWebhook` (forward-only/idempotent/terminal), `env` (mode default + per-provider secret)

## Out of scope (deferred)
- A real Uniteller/Felix client + credentials/partnership (Lane C — requires AD-II / money-transmitter licensing); real money movement (Plaid/FedNow/UPI)
- Per-partner provider routing (one default provider for v1); pre-funded-pool / payout reconciliation; refund/reversal flows (`failed` callbacks logged/ignored)
- App-level field encryption of `payoutDestination`/recipient PII before transmission to a real partner (flagged for the real-client batch)
- A shared `deliverNotifications` helper unifying the mock + webhook delivery strings (recommended fast-follow; spec open question 1)
EOF
)"
```

- [ ] **Step 4: Confirm `ci / ci` is green on the PR**

Run: `gh pr checks <pr-number>`
Expected: `ci` passes. (GitGuardian may red on the known env-var-name false positive.)

- [ ] **Step 5: Post-merge runbook**

After merge → Vercel auto-deploys → Playwright smoke runs against prod. **No migration runs** — `paymentProviderRef` is optional (absent on every existing transfer; the route writes `mock-<id>` going forward with no behavioral effect), and `updateTransferFromWebhook` adds no new key namespace. The live WhatsApp demo behaves identically: a customer pays → "Payment received" → 2 min later → "delivered" + recipient template, all driven by `MockPaymentProvider` self-advancing. The `/api/payment-webhook/[provider]` route is live but dormant — the mock never posts to it, and `mock`-path hits are safe 200-ignored no-ops. Onboarding a real partner later is: implement `PaymentProvider` against the documented Uniteller-shaped contract, add it to the `getPaymentProvider` switch keyed on `env.paymentProviderMode`, set `PAYMENT_PROVIDER_MODE` + `PAYMENT_WEBHOOK_SECRET_<PROVIDER>` in Vercel — **one factory change, zero agent/UI churn**.

---

## Self-Review (completed by plan author)

**Spec coverage (tasks → spec sections):**
- §Component 5 (`Transfer.paymentProviderRef?`, optional, `TransferStatus` unchanged, no migration) → **Task 1**.
- §Security notes (HMAC helper: constant-time `timingSafeEqual`, fail-closed on empty secret/signature, fixed sha256 with parameterization flagged) → **Task 2**.
- §Component 1 (`PaymentProvider`/`MockPaymentProvider`/`getPaymentProvider(store)`/`DELIVERY_DELAY_MS`; mock delegates byte-for-byte to the unchanged `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams` via the same `after()`/`setTimeout(120000)`; `getStatus` derives from store via `mock-<id>`; `handleWebhook` null no-op; factory single switch point) → **Task 3**.
- §Component 2 (pay-route refactor: route through `getPaymentProvider(store).initiateTransfer`, persist `paymentProviderRef` without clobbering stage 1, preserve `{ ok: true, status: 'paid' }` / 400-on-error / `maxDuration = 300`, drop `payment`/`whatsapp` imports) → **Task 4**.
- §Component 4 (`store.updateTransferFromWebhook`: idempotent + forward-only via `STATUS_RANK`, terminal-protected `cancelled`/`blocked`, sets `paidAt`/`deliveredAt`, returns the updated `Transfer` only on a real transition) → **Task 5**.
- §Component 6 (`env.paymentProviderMode` default `'mock'`, `env.paymentWebhookSecret(provider)` `''`-when-unset, `.env.example` documents both) → **Task 6**.
- §Component 3 (`POST /api/payment-webhook/[provider]`: raw-body-first, HMAC for non-mock with 401 fail-closed, 400 on malformed JSON, `handleWebhook` → `updateTransferFromWebhook`, fires stage-2 notifications exactly once on the terminal `'delivered'` transition, mock path skips verification, 200-ignored on null) → **Task 7**.
- §Component 7 (Uniteller-shaped settlement-instruction contract — corridor `sourceCountry`→`'IN'`, payout rail + destination, recipient ids, locked source amount + FX, `created/funded/paid_out` → `awaiting_payment/paid/delivered`, SendHome never holds funds) → **documented as the `PaymentProvider` interface doc-comment in Task 3 + the PR body; no client built**.
- §Dormancy invariant → proven as units early (Task 3 mock byte-for-byte + `DELIVERY_DELAY_MS===120000`), at the route (Task 4 with `payment.test.ts`/`e2e.test.ts` unmodified-and-green as the gate), at the store (Task 5 forward-only), and whole-suite-green + empty `git diff` on `payment.ts`/the two test files (Task 8).
- §Security notes (untrusted webhook body: raw-first/JSON-wrapped/`?? ''`-guarded; HMAC fail-closed + constant-time; `transferId`-existence check before mutating; idempotent + forward-only; notifications fire exactly once; bot stays provider-blind; no new server action) → **Tasks 2, 5, 7** + the explicit "no agent/UI change" check in Task 8.
- §Testing strategy → new `payment-provider.test.ts` (~10) / `payment-webhook-verify.test.ts` (~3) / `payment-webhook-route.test.ts` (~6) + extensions to `store.test.ts` (~8) and `env.test.ts` (~2); `payment.test.ts`/`e2e.test.ts` unmodified; projected +~29 → ~527 from the measured 498.
- §Open questions resolved: (1) notification ownership — v1 duplicates the one-line delivered string in the webhook to match `completePaymentStage2`, with a shared `deliverNotifications` helper flagged as the fast-follow (Task 7 note + PR); (2) `paymentProviderMode` kept `'mock'`-only, no dead `'real'` branch (Task 6); (3) `failed`/reversal logged/ignored, not mapped — `STATUS_RANK` only handles the happy path (Task 5); (4) single default provider for v1, per-partner routing deferred (Task 3 factory); (5) idempotency via the forward-only non-null return, no separate per-callback dedupe key (Task 5 + Task 7 "fires once"); (6) `x-signature` + HMAC-SHA256 over the raw body, algorithm parameterization flagged once a partner spec exists (Task 2 doc-comment).

**Placeholder scan:** No TBD/TODO. Every code step shows real, copy-pasteable code citing symbols verified in this session — `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams` returning `StageResult { transfer, senderMessages }` (`payment.ts:13,42,77`), the inline `after()`/`setTimeout(DELIVERY_DELAY_MS=120000)` block + `maxDuration=300` (`route.ts:15,17,37-55`), `sendText`/`sendTemplate`/`RECIPIENT_TEMPLATE_NAME='transfer_delivered'`/`RECIPIENT_TEMPLATE_LANG='en'` (`whatsapp.ts:3,7,63,87`), `Store.getTransfer`/`saveTransfer` + the `transfers:ids` set + lazy-fill (`store.ts:56,78`), `createStore`/`getStore`/`RedisLike` (`store.ts:13,44,163`), `TransferStatus` union `awaiting_payment|paid|delivered|cancelled|blocked` (`types.ts:5-13`), the `MockKycProvider` constructor-injection + `mock-<phone>` `getStatus` + null `handleWebhook` precedent (`mock-kyc-provider.ts`), `getSanctionsScreener` single-switch factory (`sanctions-provider.ts:40`), the `env` `cronSecret`/`seedPartner*` `?? ''` getter pattern (`env.ts:44-61`), and `fakeRedis()` + the `NextRequest` route-mount harness (`tests/helpers.ts`, `tests/whatsapp-route.test.ts`). The recipient template params `['Mom','16,600','+15551230000','UPI ID']` match `recipientTemplateParams` (`payment.ts:77-82`) exactly.

**Type consistency:** `PaymentProviderStatus = 'created' | 'funded' | 'paid_out' | 'failed'`; `InitiateResult { providerRef: string }`; `WebhookResult { transferId: string; status: TransferStatus }`; `PaymentProvider { initiateTransfer(transfer: Transfer): Promise<InitiateResult>; getStatus(providerRef: string): Promise<PaymentProviderStatus>; handleWebhook(body: unknown): Promise<WebhookResult | null> }`; `MockPaymentProvider implements PaymentProvider` (constructor `(store: Store)`); `getPaymentProvider(store: Store): PaymentProvider`; `DELIVERY_DELAY_MS = 120000`; `verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean`; `Transfer { …, paymentProviderRef?: string }` (`TransferStatus` unchanged); `STATUS_RANK: Record<TransferStatus, number>`; `store.updateTransferFromWebhook(transferId: string, status: TransferStatus): Promise<Transfer | null>`; `PaymentProviderMode = 'mock'`; `env.paymentProviderMode: PaymentProviderMode`; `env.paymentWebhookSecret(provider: string): string`. Names used identically across Tasks 1–8 and matching the spec's Architecture/Components blocks. No `as any`; `??` (never `||`) for the `?? ''`/`?? now` fallbacks; `timingSafeEqual` constant-time compare; the webhook body is `unknown` and every field defensively guarded. ✓
