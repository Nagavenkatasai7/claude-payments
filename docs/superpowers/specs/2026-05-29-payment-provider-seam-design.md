# PaymentProvider + Confirmation Webhook — Design

**Status:** design approved 2026-05-29. Awaiting spec review → implementation plan.

**Sub-project:** the "we never touch the money" settlement-integration **scaffold** for the SendHome platform reshape (see memory `sendhome-platform-reshape`). This batch makes the **mocked settlement flow swappable for a real licensed money-transmitter partner** (Uniteller-shaped) without touching the agent or the UI. It is the `PaymentRail` provider abstraction called out in `docs/ROADMAP.md` **Lane C** ("Real banking rails — months, requires partnerships + licenses") and in the architecture's "Provider abstraction layer" move — but it builds **only the seam + the mock**, not a real partner. Per the ROADMAP's own honesty rule, India UPI/IMPS payout and US money-transmission are Lane C ("code yes, business + regulatory months, not now"); this batch ships the *code* half so the regulated half can plug in later behind an unchanged interface. It **mirrors the existing provider-seam pattern** already in `src/lib/providers/` (`KycProvider`/`MockKycProvider`, `SanctionsScreener`/`MockSanctionsScreener` + `getSanctionsScreener` factory) — same shape, new domain.

---

## Goal

Today the settlement flow is hard-wired into one route. `POST /api/pay/[transferId]` (`src/app/api/pay/[transferId]/route.ts`) inlines the whole two-stage delivery: it calls `completePaymentStage1` (mark `'paid'` + send the sender "payment received" `sendText`), then schedules stage 2 inside a Next `after()` callback that sleeps `DELIVERY_DELAY_MS` (120000 ms) before calling `completePaymentStage2` (mark `'delivered'` + the sender "delivered" `sendText` + the recipient `transfer_delivered` `sendTemplate`). There is no abstraction: a real partner cannot be introduced without rewriting this route, and there is no inbound surface for a partner to report settlement status.

This batch:

- Adds a pluggable **`PaymentProvider`** abstraction (`src/lib/providers/payment-provider.ts`) — `initiateTransfer(transfer)`, `getStatus(providerRef)`, `handleWebhook(body)` — mirroring `KycProvider` exactly, plus a **`MockPaymentProvider`** and a **`getPaymentProvider()`** factory (sibling of `getSanctionsScreener`).
- **Refactors** the pay route to route settlement through `paymentProvider.initiateTransfer(transfer)` instead of the inline timer; the **mock** keeps the identical two-stage `DELIVERY_DELAY_MS` self-advance via the same `after()`/`setTimeout` mechanism, so on-screen behavior is byte-for-byte unchanged.
- Adds a **new additive route** — `POST /api/payment-webhook/[provider]` — that verifies an HMAC signature (real providers; skipped for the mock), calls `paymentProvider.handleWebhook(body)` to extract `{ transferId, status }`, calls a new **`store.updateTransferFromWebhook(transferId, status)`** (idempotent, forward-only), and on a terminal status fires the stage-2 notifications. This is the seam a real partner calls; the mock demo never needs it (it self-advances).
- Gives `Transfer` an **optional `paymentProviderRef?`**, `env.ts` a **`paymentProviderMode`** (default `'mock'`) + optional per-provider webhook secret, and documents the **Uniteller-shaped settlement-instruction contract** (no client implemented).

Ship it **dormant**: the default provider is the mock, every existing transfer flows through today's exact path, and the existing ~498-test suite (especially `tests/payment.test.ts` and the pay-route behavior in `tests/e2e.test.ts`) staying green is the proof.

## The dormancy invariant (the thing every task protects)

> With `paymentProviderMode` at its default `'mock'`, **`MockPaymentProvider` reproduces today's exact settlement behavior byte-for-byte**: on `POST /api/pay/[transferId]` it runs `completePaymentStage1` (status → `'paid'`, the sender "✅ Payment received…" `sendText`), then **self-advances** after the same `DELIVERY_DELAY_MS` (120000 ms) via the same Next `after()` + `setTimeout` mechanism to run `completePaymentStage2` (status → `'delivered'`, the sender "🎉 …delivered…" `sendText`, and the recipient `transfer_delivered`/`RECIPIENT_TEMPLATE_LANG` `sendTemplate` built from `recipientTemplateParams`). No timing change, no message change, no new network call, no webhook required for the demo. `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams` in `src/lib/payment.ts` are **untouched**; the route just delegates *which code triggers them*. The existing **~498-test suite staying green** — `tests/payment.test.ts` (the stage idempotency/error cases) plus the pay-flow path exercised in `tests/e2e.test.ts` — is the executable proof. The live WhatsApp demo behaves identically.

This mirrors how P1–P5 and KYC shipped: working infrastructure, zero live customer-facing change by default.

## Locked design decisions (2026-05-29)

1. **Scope = the seam + a mock, not a real partner.** Build the `PaymentProvider` abstraction behind settlement plus the confirmation webhook so a real Uniteller-shaped partner can be swapped in later **without touching the agent or UI**. Do **not** integrate a real partner — no Uniteller credentials, no HTTP client, no real money movement.
2. **Mirror the existing provider seam.** Create `src/lib/providers/payment-provider.ts` with a `PaymentProvider` interface, a `MockPaymentProvider` class, and a `getPaymentProvider()` factory — same file/shape/naming as `kyc-provider.ts` + `mock-kyc-provider.ts` and `sanctions-provider.ts`'s `getSanctionsScreener`. No new pattern is invented.
3. **Dormancy is sacred.** `MockPaymentProvider` reproduces today's two-stage 120000 ms flow + all three notifications byte-for-byte by delegating to the unchanged `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams`. The ~498-test suite green is the proof.
4. **Pay-route refactor, identical timing.** `POST /api/pay/[transferId]` routes through `paymentProvider.initiateTransfer(transfer)` instead of inline timer logic. The **mock** self-advances stage 2 via the **same `after()`/`setTimeout(DELIVERY_DELAY_MS)`** mechanism (moved into the provider, not deleted). A **real** provider would instead drive stage 2 via the webhook and `initiateTransfer` would return immediately after posting the settlement instruction.
5. **New additive webhook route.** `POST /api/payment-webhook/[provider]`: verifies an HMAC signature for real providers (no-op/skip for the mock); calls `paymentProvider.handleWebhook(body)` → `{ transferId, status } | null`; calls `store.updateTransferFromWebhook(transferId, status)` (**idempotent, forward-only** — never regress `'delivered'`→`'paid'`, tolerant of duplicate/out-of-order callbacks); on a terminal `'delivered'` transition fires the stage-2 notifications. The mock demo does **not** call this route.
6. **Schema/config additions, all back-compat.** `Transfer` gains optional `paymentProviderRef?: string`. `env.ts` gains `paymentProviderMode` (default `'mock'`) + an optional per-provider webhook secret getter. `store` gains `updateTransferFromWebhook`.
7. **Uniteller-shaped contract documented, not implemented.** A real provider receives a settlement **instruction** — corridor (`sourceCountry` → `'IN'`), payout rail (`upi|bank` + `payoutDestination`), recipient identifiers, source amount + locked FX — and posts status callbacks `created → funded → paid_out` that map to our `'awaiting_payment' → 'paid' → 'delivered'`. SendHome never holds funds; the partner is the money-transmitter of record. Document the contract; build no client.
8. **Back-compat.** Transfers without `paymentProviderRef` still flow through today's path; the mock is the **default** provider, so nothing changes until a real provider is configured (`paymentProviderMode !== 'mock'`).
9. **Security.** Webhook is an **unauthenticated public POST** — body is untrusted. Real providers: verify HMAC signature before doing anything; mock: skip. Validate `transferId` existence before mutating; status updates are **idempotent + forward-only** (never regress); defensive `?? ''` on every body field.
10. **Conventions.** TDD per task; `fakeRedis()` in tests; no `as any`; mirror the `KycProvider`/`SanctionsScreener` seam; the bot stays partner-blind (it never learns which provider settles); one atomic commit per task; commit prefix `feat(pay-seam):`; the existing ~498-suite green = the dormancy proof.
11. **Out of scope (deferred):** a real Uniteller/Felix client + credentials/partnership; real money movement (Plaid/FedNow/UPI); per-partner provider routing (one default provider for v1); pre-funded-pool / payout reconciliation; refund/reversal flows.

---

## Architecture

```
Customer pays:  POST /api/pay/[transferId]            src/app/api/pay/[transferId]/route.ts
  │  store = getStore()
  │  transfer = store.getTransfer(transferId)
  │  paymentProvider = getPaymentProvider(store)        ← NEW factory (default = mock)
  ▼
paymentProvider.initiateTransfer(transfer)             src/lib/providers/payment-provider.ts
  │  → { providerRef }   (persisted onto Transfer.paymentProviderRef)
  │
  ├── MOCK PROVIDER (default — DORMANT, byte-for-byte today) ───────────────┐
  │     completePaymentStage1(store, id)   → 'paid'   + sender "received"    │
  │     after(async () => { sleep DELIVERY_DELAY_MS (120000ms);              │
  │        completePaymentStage2(store, id)→ 'delivered'                     │
  │        + sender "delivered" sendText                                     │
  │        + recipient transfer_delivered sendTemplate })                    │
  │     (self-advances; NO webhook needed for the demo)                      │
  │                                                                          │
  └── REAL PARTNER (Uniteller-shaped — NOT BUILT, documented) ──────────────┘
        initiateTransfer POSTs a settlement instruction; returns providerRef
        partner settles funds (SendHome never holds them)
        partner posts callbacks:  created → funded → paid_out
                                       ▼
        POST /api/payment-webhook/[provider]            src/app/api/payment-webhook/[provider]/route.ts (NEW)
          verifyHmac(rawBody, signatureHeader, secret)   ← real providers only; mock skips
          paymentProvider.handleWebhook(body) → { transferId, status } | null
          store.updateTransferFromWebhook(transferId, status)   ← IDEMPOTENT, FORWARD-ONLY
            'funded'   ⇒ 'paid'        (stage-1 effect)
            'paid_out' ⇒ 'delivered'   (stage-1→2; never regress)
          on terminal 'delivered' transition ⇒ fire stage-2 notifications
            (sender "delivered" sendText + recipient transfer_delivered sendTemplate)
```

For the **dormant** path (`paymentProviderMode === 'mock'`), `getPaymentProvider` returns the `MockPaymentProvider`; `initiateTransfer` runs the exact stage-1-then-`after()`-stage-2 sequence the route inlines today; `/api/payment-webhook/[provider]` exists but is never called by the demo; and `Transfer.paymentProviderRef` is set to a mock ref (e.g. `mock-<transferId>`) with no behavioral effect.

---

## Components

### 1. `PaymentProvider` interface + `MockPaymentProvider` + factory — `src/lib/providers/payment-provider.ts` (new)

Mirrors `kyc-provider.ts`/`mock-kyc-provider.ts` exactly: a typed interface, a mock class taking its collaborators by constructor, and a `get*` factory.

```ts
import type { Store } from '../store';
import type { Transfer, TransferStatus } from '../types';

// Provider-side lifecycle, mapped to our TransferStatus in handleWebhook/update.
// created → our 'awaiting_payment'; funded → 'paid'; paid_out → 'delivered'.
export type PaymentProviderStatus = 'created' | 'funded' | 'paid_out' | 'failed';

export interface InitiateResult {
  providerRef: string;          // partner's settlement id; persisted onto Transfer.paymentProviderRef
}

export interface WebhookResult {
  transferId: string;           // OUR transfer id (the partner echoes it back)
  status: TransferStatus;       // already mapped to our domain ('paid' | 'delivered')
}

export interface PaymentProvider {
  // Begin settlement. Mock self-advances the two stages; a real provider POSTs
  // a settlement instruction and returns, settling asynchronously via webhook.
  initiateTransfer(transfer: Transfer): Promise<InitiateResult>;
  // Poll provider-side status (real provider: API call; mock: derive from store).
  getStatus(providerRef: string): Promise<PaymentProviderStatus>;
  // Parse + map an inbound callback body to our domain, or null if irrelevant/unparseable.
  handleWebhook(body: unknown): Promise<WebhookResult | null>;
}
```

```ts
import { after } from 'next/server';
import {
  completePaymentStage1, completePaymentStage2, recipientTemplateParams,
} from '../payment';
import {
  sendText, sendTemplate, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '../whatsapp';

export const DELIVERY_DELAY_MS = 120000;   // moved from the route; SAME value (2 min)

export class MockPaymentProvider implements PaymentProvider {
  constructor(private readonly store: Store) {}

  async initiateTransfer(transfer: Transfer): Promise<InitiateResult> {
    // Stage 1 — identical to today's route body.
    const { transfer: t1, senderMessages } = await completePaymentStage1(this.store, transfer.id);
    for (const msg of senderMessages) await sendText(t1.phone, msg);

    // Stage 2 — SAME after()/setTimeout(DELIVERY_DELAY_MS) self-advance the route does today.
    after(async () => {
      try {
        await new Promise((r) => setTimeout(r, DELIVERY_DELAY_MS));
        const s2 = await completePaymentStage2(this.store, transfer.id);
        for (const msg of s2.senderMessages) await sendText(s2.transfer.phone, msg);
        if (s2.transfer.recipientPhone) {
          await sendTemplate(
            s2.transfer.recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
            recipientTemplateParams(s2.transfer),
          );
        }
      } catch (err) { console.error('Stage-2 delivery failed:', err); }
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

  // The mock self-advances and never calls the webhook → no-op, mirroring MockKycProvider.handleWebhook.
  async handleWebhook(_body: unknown): Promise<WebhookResult | null> {
    return null;
  }
}

export function getPaymentProvider(store: Store): PaymentProvider {
  // Single switch point. v1 has only the mock; a real provider is added here,
  // selected by env.paymentProviderMode — no call-site change (mirrors getSanctionsScreener).
  return new MockPaymentProvider(store);
}
```

Notes:
- `DELIVERY_DELAY_MS` **moves** from the route constant into the mock provider, keeping the literal `120000`. The route no longer owns the timer.
- The mock's `handleWebhook` returns `null` exactly like `MockKycProvider.handleWebhook`, so the webhook route is a safe no-op even if hit in mock mode.
- `getStatus` derives provider status from our stored `TransferStatus` so a future poller has a working mock; it is not used on the hot path.
- The factory takes `store` because the mock needs it to run the stages; a real provider would read `env` (base URL, credentials) instead — same single switch point.

### 2. Pay-route refactor — `src/app/api/pay/[transferId]/route.ts`

Replace the inline stage-1 + `after()` stage-2 block with one call to the provider. **No behavior change in mock mode.**

```ts
import { getPaymentProvider } from '@/lib/providers/payment-provider';

export const maxDuration = 300;   // unchanged (the mock still sleeps 120s inside after())

export async function POST(_req: NextRequest, { params }: { params: Promise<{ transferId: string }> }) {
  const { transferId } = await params;
  try {
    const store = getStore();
    const transfer = await store.getTransfer(transferId);
    if (!transfer) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });

    const provider = getPaymentProvider(store);
    const { providerRef } = await provider.initiateTransfer(transfer);   // stage 1 + (mock) self-advancing stage 2

    if (!transfer.paymentProviderRef) {
      await store.saveTransfer({ ...(await store.getTransfer(transferId))!, paymentProviderRef: providerRef });
    }
    return NextResponse.json({ ok: true, status: 'paid' });
  } catch (err) {
    console.error('Payment processing failed:', err);
    return NextResponse.json({ ok: false, error: 'Payment failed' }, { status: 400 });
  }
}
```

Notes:
- The route re-reads the transfer before persisting `paymentProviderRef` so it doesn't clobber the `'paid'` write `completePaymentStage1` already made (the mock mutates status inside `initiateTransfer`). Persist the ref only if not already set (guard against overwrite).
- The `{ ok: true, status: 'paid' }` response shape, the 400-on-error behavior, and `maxDuration = 300` are all preserved so the pay page and any caller are untouched.
- The two `import`s of `payment`/`whatsapp` symbols move out of the route and into the mock provider; the route now imports only `getStore` + `getPaymentProvider`.

### 3. Confirmation webhook route — `src/app/api/payment-webhook/[provider]/route.ts` (new, additive)

The inbound surface a **real** partner calls. Unauthenticated public POST → body is untrusted → verify signature first, then map, then forward-only update, then fire terminal notifications.

```ts
import { NextRequest, NextResponse, after } from 'next/server';
import { getStore } from '@/lib/store';
import { getPaymentProvider } from '@/lib/providers/payment-provider';
import { env } from '@/lib/env';
import { verifyWebhookSignature } from '@/lib/providers/payment-webhook-verify';   // small pure helper
import {
  sendText, sendTemplate, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';
import { recipientTemplateParams } from '@/lib/payment';

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const raw = await req.text();                              // raw body for HMAC
  const store = getStore();

  // Mock skips verification (its callbacks are never used); real providers MUST verify.
  if (provider !== 'mock') {
    const secret = env.paymentWebhookSecret(provider);       // '' if unconfigured
    const sig = req.headers.get('x-signature') ?? '';
    if (!secret || !verifyWebhookSignature(raw, sig, secret)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }

  const result = await getPaymentProvider(store).handleWebhook(body);
  if (!result) return NextResponse.json({ ok: true, ignored: true });   // unparseable/irrelevant → 200, no mutation

  const { transferId, status } = result;
  const updated = await store.updateTransferFromWebhook(transferId, status);   // null if not found or no-op/regress
  if (updated && updated.status === 'delivered' && updated._stage2Fired !== true) {
    // Fire stage-2 notifications exactly once on the terminal transition.
    after(async () => {
      try {
        await sendText(updated.phone, `🎉 ₹${updated.amountInr.toLocaleString('en-IN')} delivered to ${updated.recipientName}. Thanks for using SendHome!`);
        if (updated.recipientPhone) {
          await sendTemplate(updated.recipientPhone, RECIPIENT_TEMPLATE_NAME, RECIPIENT_TEMPLATE_LANG, recipientTemplateParams(updated));
        }
      } catch (err) { console.error('Webhook stage-2 notify failed:', err); }
    });
  }
  return NextResponse.json({ ok: true });
}
```

Notes:
- The webhook reuses the **exact** sender/recipient notification content the mock fires, so a real-provider delivery and a mock delivery are observationally identical. (To avoid duplicating the message string, the cleanest factoring is to have `completePaymentStage2` remain the single owner of the sender text and have the route call it for the side-effecting notify; the helper boundary is an Open question.)
- Returns **200** for an unparseable/ignored body (so a chatty partner isn't retried into a loop) but **401** for a failed signature and **400** for malformed JSON.
- `[provider]` in the path lets multiple real providers be onboarded later without new routes; `mock` is accepted and short-circuits verification.
- The "fire exactly once" guard is whatever `updateTransferFromWebhook` returns (Component 4): the route only notifies when the update **actually transitioned** to `'delivered'`, so duplicate `paid_out` callbacks are silent.

### 4. `store.updateTransferFromWebhook` — `src/lib/store.ts` (idempotent, forward-only)

A new method on the store object, beside `saveTransfer`. **The forward-only guard is the heart of webhook safety.**

```ts
// Rank for forward-only enforcement; higher = further along. Terminal/side states are never regressed.
const STATUS_RANK: Record<TransferStatus, number> = {
  blocked: -1, cancelled: -1, awaiting_payment: 0, paid: 1, delivered: 2,
};

async updateTransferFromWebhook(
  transferId: string,
  status: TransferStatus,           // already mapped to our domain by handleWebhook
): Promise<Transfer | null> {
  const transfer = await this.getTransfer(transferId);
  if (!transfer) return null;                                   // unknown id → no-op (untrusted body)
  // Never regress: ignore a status that is not strictly forward of the current one.
  if (STATUS_RANK[status] <= STATUS_RANK[transfer.status]) return null;   // duplicate / out-of-order / backward
  if (transfer.status === 'cancelled' || transfer.status === 'blocked') return null;  // terminal-protected
  const now = new Date().toISOString();
  const updated: Transfer = {
    ...transfer,
    status,
    paidAt: status === 'paid' || status === 'delivered' ? (transfer.paidAt ?? now) : transfer.paidAt,
    deliveredAt: status === 'delivered' ? now : transfer.deliveredAt,
  };
  await this.saveTransfer(updated);
  return updated;                                               // non-null ⇒ a real transition happened
}
```

Notes:
- **Idempotent:** a repeated `paid_out` callback finds `status` already `'delivered'`, `STATUS_RANK` comparison fails (`2 <= 2`), returns `null` → no re-save, no duplicate notification.
- **Forward-only:** a stray `funded` (`paid`, rank 1) arriving after `paid_out` (`delivered`, rank 2) is ignored — `'delivered'`→`'paid'` can never happen.
- **Terminal-protected:** a `cancelled` or `blocked` transfer is never advanced by a webhook (mirrors `completePaymentStage2`'s cancelled guard).
- Returns the updated `Transfer` on a real transition, `null` otherwise — the route uses this truthiness to fire stage-2 notifications exactly once.
- Reuses the existing `saveTransfer` (which also re-adds to the `transfers:ids` set) and the lazy-fill `getTransfer` — no new key namespace, no migration.

### 5. `Transfer.paymentProviderRef` — `src/lib/types.ts`

One optional field, dormancy-preserving (matches the `KycProvider`'s `Customer.kycProviderRef?` precedent already in `types.ts`).

```ts
export interface Transfer {
  // ...existing fields...
  paymentProviderRef?: string;   // NEW (pay-seam) — partner's settlement id; mock sets `mock-<id>`
}
```

Notes:
- Optional → no migration; `getTransfer`'s lazy-fill block is untouched (an absent `paymentProviderRef` is simply "settled inline / not yet initiated"). `TransferStatus` is **unchanged** — provider statuses map *into* the existing `'paid'`/`'delivered'` values, no new enum members.

### 6. Env config — `src/lib/env.ts`

Add the mode toggle + a per-provider secret getter, following the existing optional-getter pattern (`cronSecret`/`seedPartner*` return `''` when unset).

```ts
export type PaymentProviderMode = 'mock';   // v1: mock only; real modes added when a partner lands

get paymentProviderMode(): PaymentProviderMode {
  const v = process.env.PAYMENT_PROVIDER_MODE ?? 'mock';
  return v === 'mock' ? 'mock' : 'mock';     // default + only supported value in v1
},
paymentWebhookSecret(provider: string): string {
  // Per-provider HMAC secret, e.g. PAYMENT_WEBHOOK_SECRET_UNITELLER. '' ⇒ unconfigured ⇒ reject (Component 3).
  return process.env[`PAYMENT_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? '';
},
```

Notes:
- `paymentProviderMode` defaults to `'mock'` → dormancy. `getPaymentProvider` (Component 1) reads it; v1 always returns the mock, so the env var is a forward hook, not a live switch.
- `paymentWebhookSecret` is a **method** (not a getter) because it's keyed by provider name; an unconfigured secret returns `''`, and the webhook route rejects (401) rather than processing an unsigned real-provider callback. `.env.example` documents `PAYMENT_PROVIDER_MODE` + the secret naming.

### 7. The Uniteller-shaped settlement-instruction contract (documented, not implemented)

A real licensed partner (Uniteller-shaped; the AD-II / money-transmitter of record per ROADMAP Lane C item 12) implements `PaymentProvider` against this contract. **Document it in the spec + as a doc-comment on the interface; build no client.**

**Outbound — `initiateTransfer(transfer)` POSTs a settlement instruction:**

```
POST {partnerBaseUrl}/settlements
{
  "reference":        transfer.id,                  // our id; echoed back on callbacks
  "corridor":         { "source": transfer.sourceCountry, "destination": "IN" },   // always → IN in v1
  "payout":           { "rail": transfer.payoutMethod,     // 'upi' | 'bank'
                        "destination": transfer.payoutDestination },
  "recipient":        { "name": transfer.recipientName, "phone": transfer.recipientPhone },
  "amount":           { "source": transfer.amountSource, "currency": transfer.sourceCurrency,
                        "destination": transfer.amountInr, "destinationCurrency": "INR",
                        "fxRate": transfer.fxRate }    // LOCKED at quote time — partner settles at this rate
}
→ 200 { "providerRef": "<partner settlement id>" }    // becomes Transfer.paymentProviderRef
```

**Inbound — the partner posts status callbacks to `POST /api/payment-webhook/[provider]`:**

| Partner status | Our `TransferStatus` | Effect via `updateTransferFromWebhook` |
| --- | --- | --- |
| `created` | `awaiting_payment` | no-op (already at/forward of this) |
| `funded` | `paid` | stage-1 effect (mark paid) |
| `paid_out` | `delivered` | stage-1→2; fires stage-2 notifications once |
| `failed` | *(not mapped in v1)* | logged/ignored; reversal flow is out of scope |

Notes:
- **SendHome never holds funds.** The partner is the money-transmitter; SendHome posts an instruction and reflects status. This is the regulatory crux of "we never touch the money" — the seam encodes it.
- The FX rate is **locked at quote time** (`transfer.fxRate`, from `createTransfer`'s `quote(...)`), passed in the instruction so the partner settles at the rate the customer was quoted.
- `failed`/reversal is explicitly deferred (Out of scope); v1 maps only the happy path.

---

## Security notes

- **Untrusted webhook body.** `/api/payment-webhook/[provider]` is an **unauthenticated public POST**. Nothing in the body is trusted: the raw text is read first for HMAC, JSON parsing is wrapped (malformed → 400), and every extracted field is `?? ''`-guarded inside `handleWebhook`. A body that doesn't parse to a known shape returns 200-ignored with **no mutation**.
- **HMAC signature for real providers; skipped for mock.** Real providers must present a valid `x-signature` HMAC over the raw body, verified against `env.paymentWebhookSecret(provider)` with a constant-time compare (`crypto.timingSafeEqual`) in the pure `verifyWebhookSignature` helper. An **unconfigured secret rejects** (401) — fail-closed, never fail-open. The `mock` provider path skips verification because the mock never posts callbacks (its `handleWebhook` is a no-op), so there is no live unsigned surface in the default deployment.
- **`transferId` existence check before mutating.** `updateTransferFromWebhook` returns `null` for an unknown id — an attacker spraying random ids cannot create or corrupt records; only an existing transfer can be advanced, and only forward.
- **Idempotent + forward-only status.** `STATUS_RANK` enforces strictly-increasing transitions; duplicate, out-of-order, and backward callbacks are silently dropped (`'delivered'`→`'paid'` is impossible), and `cancelled`/`blocked` are terminal-protected. This makes the webhook safe to retry (partners retry) and immune to replay-driven status regression.
- **Notifications fire exactly once.** Stage-2 WhatsApp messages fire only when `updateTransferFromWebhook` reports a **real** transition to `'delivered'` (non-null return), so a partner replaying `paid_out` ten times sends the recipient template **once**.
- **Bot stays provider-blind.** The agent and prompt never learn which provider settles, never see `paymentProviderRef`, and the webhook/route layer never feeds provider identity back into chat content — `bot-content-guard` invariants are unaffected (no new internal term leaks into prompts/tools).
- **Server-action checklist (if any dashboard mutation is later added).** This batch adds **no** new server action — the webhook is an API route, not a server action, and the pay route is unchanged in surface. Any future provider-config UI must clear the full checklist (own `requirePlatformAdmin`, target-in-scope, no unconditional overwrite, route-authoritative ownership).

## Testing strategy

Per-component (TDD, `fakeRedis()` where Redis is involved):

- **`payment-provider.test.ts` (new, ~10 cases):** `MockPaymentProvider.initiateTransfer` runs stage 1 (status → `'paid'`, returns `mock-<id>` providerRef) and registers the `after()` stage-2 self-advance; stage-2 (driven by flushing the `after`/timer) → `'delivered'` + the sender delivered text + the recipient `transfer_delivered` `sendTemplate` with `recipientTemplateParams`; `getStatus` maps stored status → `created/funded/paid_out`; `handleWebhook` returns `null` (mock no-op); `getPaymentProvider` returns the mock under default `paymentProviderMode`. WhatsApp `sendText`/`sendTemplate` are stubbed and asserted on (mirrors how `tests/payment.test.ts` already isolates the stages).
- **`store.test.ts` (extend, ~8 cases) — the forward-only/idempotency core:** `updateTransferFromWebhook` advances `awaiting_payment`→`paid`→`delivered`; **ignores** a duplicate `paid_out` (returns `null`, no re-save); **ignores** a backward `funded` after `delivered` (no regression); **ignores** an unknown `transferId` (returns `null`); **refuses** to advance a `cancelled`/`blocked` transfer; sets `paidAt`/`deliveredAt` correctly; returns the updated `Transfer` only on a real transition.
- **`payment-webhook` route (logic-level test, ~6 cases):** real provider with a **bad signature** → 401, no mutation; **good signature** + `paid_out` body → `updateTransferFromWebhook` called → 200 + stage-2 notifications fired **once**; malformed JSON → 400; unparseable-but-valid-JSON (handleWebhook → null) → 200-ignored, no mutation; **duplicate** `paid_out` → second call fires **no** notification; `mock` provider path → verification skipped. (Route I/O follows the `whatsapp-route.test.ts` harness style.)
- **`payment-webhook-verify.test.ts` (new, ~3 cases):** valid HMAC passes; tampered body/sig fails; empty secret fails (fail-closed). Constant-time compare.
- **Dormant pay-flow regression — `payment.test.ts` + `e2e.test.ts` (unchanged, must stay green):** the existing stage-1/stage-2 idempotency, not-found, and cancelled-guard cases in `tests/payment.test.ts`, plus the pay-flow path in `tests/e2e.test.ts` (which calls `completePaymentStage1`/`completePaymentStage2` directly), are **not modified** — they prove `payment.ts` is untouched and the mock reproduces today's behavior. This is the executable dormancy proof.
- **`env.test.ts` (extend, ~2 cases):** `paymentProviderMode` defaults to `'mock'`; `paymentWebhookSecret(provider)` returns `''` when unset and the env value when set.
- **`types`/compile:** `Transfer.paymentProviderRef?` optional, no `as any`; `tsc` green.

Rough test-count delta from **~498**: new `payment-provider.test.ts` (~10) + `payment-webhook` route (~6) + `payment-webhook-verify.test.ts` (~3) + extensions to `store.test.ts` (~8) and `env.test.ts` (~2) ≈ **+~29 → ~527**, with `payment.test.ts`/`e2e.test.ts` unchanged.

## Acceptance criteria

- [ ] `src/lib/providers/payment-provider.ts` exports `PaymentProvider`, `MockPaymentProvider`, `getPaymentProvider(store)`, and `DELIVERY_DELAY_MS` — mirroring the `KycProvider`/`MockKycProvider` shape; no `as any`.
- [ ] `MockPaymentProvider.initiateTransfer` reproduces today's two-stage flow byte-for-byte: `completePaymentStage1` + sender text, then `after()` + `setTimeout(DELIVERY_DELAY_MS=120000)` → `completePaymentStage2` + sender text + recipient `transfer_delivered` template; `payment.ts` is untouched.
- [ ] `src/app/api/pay/[transferId]/route.ts` routes settlement through `getPaymentProvider(store).initiateTransfer(transfer)` instead of the inline timer; response shape (`{ ok: true, status: 'paid' }`), 400-on-error, and `maxDuration = 300` preserved; persists `paymentProviderRef` without clobbering the stage-1 write.
- [ ] `src/app/api/payment-webhook/[provider]/route.ts` exists: verifies HMAC for non-mock providers (401 on bad/absent signature, fail-closed), 400 on malformed JSON, calls `handleWebhook` → `updateTransferFromWebhook`, fires stage-2 notifications exactly once on the terminal `'delivered'` transition; mock path skips verification.
- [ ] `store.updateTransferFromWebhook(transferId, status)` is idempotent + forward-only: advances `awaiting_payment`→`paid`→`delivered`, never regresses, no-ops on unknown id / duplicate / backward / `cancelled`/`blocked`, returns the updated `Transfer` only on a real transition.
- [ ] `Transfer.paymentProviderRef?: string` added (optional, no migration); `TransferStatus` unchanged.
- [ ] `env.ts` adds `paymentProviderMode` (default `'mock'`) + `paymentWebhookSecret(provider)` (`''` when unset); `.env.example` documents both.
- [ ] The Uniteller-shaped settlement-instruction contract (corridor → IN, payout rail + destination, recipient ids, locked source amount + FX, `created/funded/paid_out` → `awaiting_payment/paid/delivered`) is documented; **no real client is implemented**.
- [ ] Bot stays provider-blind; no real money movement; no Uniteller credentials.
- [ ] The full pre-batch suite passes — `payment.test.ts` and `e2e.test.ts` unmodified and green — the executable dormancy proof.

## Open questions

1. **Stage-2 notification ownership (mock vs webhook).** The delivered-sender text + recipient template are fired by both the mock (`initiateTransfer`'s `after()`) and the real webhook. Reuse `completePaymentStage2` as the single owner of the side effects (cleanest, one source of the message strings) vs duplicate the notify block in the webhook route (looser coupling). Recommend extracting a tiny `deliverNotifications(transfer)` helper called by both, so the message strings live in exactly one place.
2. **`paymentProviderMode` as a live switch in v1.** Keep it `'mock'`-only (the type union has one member; the factory always returns the mock) vs pre-wire a `'real'` branch that throws "not implemented". Recommend `'mock'`-only — a real branch with no client is dead code; add it with the client.
3. **`failed`/reversal status.** v1 maps only the happy path (`funded`/`paid_out`). Should a `failed` callback mark the transfer (e.g. a new `'failed'` `TransferStatus`) or stay ignored/logged? Recommend ignore-with-log for v1; reversal is a deferred batch (a new status touches the dashboard + every status switch).
4. **Per-provider routing.** v1 has one default provider for all transfers. Per-partner provider selection (a partner could use a different AD-II) is deferred — confirm the single-provider assumption holds for the prototype.
5. **Webhook idempotency key.** `updateTransferFromWebhook` is idempotent via status rank. Do we also need an explicit per-callback `markMessageSeen`-style dedupe (like the WhatsApp `msg:<wamid>` guard) to suppress duplicate *notifications* within the same transition window? Recommend relying on the forward-only return (a real transition happens at most once) for v1; note the explicit-dedupe upgrade if a partner double-fires within the same millisecond.
6. **Signature header + algorithm.** Assumed `x-signature` + HMAC-SHA256 over the raw body. The real header name/algorithm is partner-specific (Uniteller TBD); the `verifyWebhookSignature` helper should take the algorithm as a parameter. Confirm once a partner spec exists.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Pay-route refactor changes the live demo's two-stage timing/messages (dormancy break) | Low | High | Mock delegates to the **unchanged** `payment.ts` stages with the **same** `after()`/`setTimeout(120000)`; `payment.test.ts` + `e2e.test.ts` unmodified and must stay green. |
| Webhook regresses a delivered transfer back to paid | Low | High | `STATUS_RANK` strictly-increasing guard; terminal-protected `cancelled`/`blocked`; explicit forward-only/idempotency tests in `store.test.ts`. |
| Duplicate `paid_out` callback double-sends the recipient `transfer_delivered` template | Medium | Medium | Notifications fire only on a non-null (real-transition) return from `updateTransferFromWebhook`; duplicate → `null` → no send. |
| Unsigned/forged real-provider callback mutates a transfer | Low | High | Fail-closed HMAC (401 on bad/absent secret), constant-time compare, `transferId`-existence check before any write; mock path has no live callback surface. |
| `paymentProviderRef` write clobbers the stage-1 `'paid'` status | Low | Medium | Route re-reads the transfer post-`initiateTransfer` and writes the ref only when unset; spread-merge, never blind overwrite. |
| Message strings drift between mock and webhook delivery paths | Medium | Low | Extract a single `deliverNotifications` helper (Open question 1) so both paths share one source. |
| Real provider's status model differs from `created/funded/paid_out` | Medium | Low | `handleWebhook` is the single mapping point; a new provider maps its own vocabulary to our `TransferStatus` with zero call-site change (mirrors `getSanctionsScreener`). |
| Next `after()` + 300s `maxDuration` can't span a real partner's settlement latency | Low | Medium | Real providers drive stage 2 via the **webhook**, not the in-request timer — `initiateTransfer` returns immediately; the 120s `after()` self-advance is a mock-only artifact. |

## Out of scope (deferred)

- **A real Uniteller/Felix client + credentials/partnership** — the contract is documented; the HTTP client, auth, and sandbox are Lane C (require partnership + AD-II / money-transmitter licensing per `docs/ROADMAP.md`).
- **Real money movement** (Plaid / FedNow / RTP / India UPI-IMPS) — still mocked; SendHome moves no funds.
- **Per-partner provider routing** — one default provider for v1; per-partner AD-II selection is a fast-follow.
- **Pre-funded INR pool / payout reconciliation** — the partner holds funds and reconciles; SendHome only reflects status.
- **Refund / reversal flows** — `failed` callbacks are logged/ignored in v1; reversal (and any new `TransferStatus`) is a later batch.
- **App-level encryption of `payoutDestination` / recipient PII in the settlement instruction** — at-rest is the Upstash layer; field-level encryption before transmission to a real partner is flagged for the real-client batch.

## Sequencing note

This batch branches off `main`, which already has P1–P5 + the KYC tiered-capture batch merged (PRs #10/#12/#13/#14; suite at 498). It depends only on: the existing `src/lib/payment.ts` stages (`completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams`), the pay route, `src/lib/whatsapp.ts` (`sendText`/`sendTemplate`/`RECIPIENT_TEMPLATE_NAME`/`RECIPIENT_TEMPLATE_LANG`), the `Store` (`getTransfer`/`saveTransfer`), `Transfer`/`TransferStatus` in `types.ts`, and the provider-seam precedent in `src/lib/providers/` (`KycProvider`/`MockKycProvider`, `getSanctionsScreener`). None of these are in flight in this batch, so it can branch off the latest merged base independently of the KYC batch. The **real** provider swap (Uniteller client) is downstream and gated on a Lane-C partnership + license; this batch ships only the seam + mock so that swap is a single `getPaymentProvider` factory change with no agent/UI churn.

---

## Key files (reference)

- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/payment.ts` — `completePaymentStage1`/`completePaymentStage2`/`recipientTemplateParams` (UNTOUCHED; the mock delegates to them)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/app/api/pay/[transferId]/route.ts` — refactor target: route through `getPaymentProvider(store).initiateTransfer`; `DELIVERY_DELAY_MS` moves to the provider
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/providers/payment-provider.ts` — **new**: `PaymentProvider`/`MockPaymentProvider`/`getPaymentProvider` (mirror of `kyc-provider.ts`/`mock-kyc-provider.ts`/`getSanctionsScreener`)
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/app/api/payment-webhook/[provider]/route.ts` + `src/lib/providers/payment-webhook-verify.ts` — **new**: confirmation webhook + HMAC helper
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/store.ts` — **new** `updateTransferFromWebhook` (idempotent, forward-only) beside `saveTransfer`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/types.ts` — `Transfer.paymentProviderRef?` (optional); `TransferStatus` unchanged
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/env.ts` — `paymentProviderMode` (default `'mock'`) + `paymentWebhookSecret(provider)`
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/src/lib/providers/sanctions-provider.ts` + `kyc-provider.ts` + `mock-kyc-provider.ts` — the seam pattern being MIRRORED
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/tests/payment.test.ts` + `tests/e2e.test.ts` — the unmodified dormancy-proof tests
- `/Users/nagavenkatasaichennu/Desktop/claude-payments/docs/ROADMAP.md` — Lane C (items 9–12) + the "Provider abstraction layer" architectural move this batch realizes
- Current suite measured at 56 test files in `tests/` (498 tests); projected delta +~29 → ~527.
