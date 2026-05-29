# UX Batch (Recipient-Amount-First + Flows Scaffolding) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two additive UX wins, both dormant-by-default so the existing suite staying green is the proof of safety.

- **Win A — Recipient-amount-first quoting.** Today `get_quote` only accepts a send amount: `getQuoteTool` calls `quote(Number(args.amount_usd), …)` (tools.ts:397-403), and `quote()` computes the forward line `amountInr = Math.round(amountSource * rates.toInr)` (fx.ts:59). A customer who says "I want my mom to get ₹40,000" cannot be served — the agent has to guess-and-check the send amount. This batch adds an **optional** `amount_inr` to the `get_quote` schema. When present, `getQuoteTool` back-solves the send amount with a NEW pure helper `sourceForInr(amountInr, rates) = round2(amountInr / rates.toInr)` (the exact inverse of fx.ts:59, reusing the existing `round2`), then calls the **byte-for-byte-unchanged** `quote(amountSource, sourceCurrency, rates, fundingMethod, transferCount)`. The recipient gets the exact target INR; the fee is added on top to the sender (today's model). The send-amount-first path (`amount_usd` only) is **untouched** — receive-first is an additive branch that runs ONLY when `amount_inr` is finite and `> 0`; if both are given, `amount_inr` wins. The back-solved `amountSource` flows through the SAME `quote()` MIN/MAX and the SAME P4 USD-equivalent cap/velocity/EDD accounting — no accounting change.

- **Win B — WhatsApp Flows scaffolding (behind a button fallback).** `sendInteractive` (whatsapp.ts:136-189) sends up to 3 reply buttons with an HTTP-470 → `sendText` fallback; `parseIncoming` (whatsapp.ts:31-61) parses only `button_reply`; the route synthesizes button text and `parseButtonId` decodes the `recipient:<phone>` / `recipient:new` grammar (whatsapp-buttons.ts:55-74). This batch adds a richer interactive primitive `sendList` mirroring `sendInteractive`'s exact Graph API call shape, keeps the same HTTP-470 → `sendText` fallback, and throws-to-fall-back on any other non-OK. `parseIncoming` gains a `list_reply` branch that **collapses into the existing `{ kind: 'button'; buttonId }` shape**, so `parseButtonId` / `ButtonTap` / `synthesizeButtonText` / the `recipient:*` grammar are all reused **unchanged**. A new env flag `whatsappFlowsEnabled` mirrors `paymentProviderMode`'s strict-literal pattern (env.ts:65-68). Only `send_recipient_picker` (tools.ts:727-758) is wired to optionally use `sendList` behind the flag, **falling back to the existing 3-button `sendInteractive` when the flag is off OR the send fails**. The test WABA is NOT Meta-Business-verified, so a live list/flow send may fail — the fallback keeps prod identical. DEFAULT (flag off) = today's button behavior byte-for-byte. The unit-testable parts (message construction, reply parsing, fallback selection) are the deliverable; the live send is gated.

> **Safety invariant:** Both wins are additive and dormant by default. Win A fires ONLY when `amount_inr` is passed (finite, `> 0`); with `amount_usd` only, `getQuoteTool` reduces to today's exact call. Win B is flag-off-by-default + button fallback ⇒ `send_recipient_picker` and the webhook parse the same shapes as today. No new `TransferStatus`, no new `Transfer` field, no schema/Redis change. The existing ~549-test suite staying green + `bot-content-guard` green is the executable proof.

**Architecture:** This batch stacks on `spec/p4-multi-currency` (the current branch), which already gives `quote()` its `sourceCurrency`/`amountSource`/`feeSource` outputs (fx.ts:61-72) and `FxRates` its `toInr`/`toUsd` (rate.ts:3-5). Win A depends only on already-present symbols: `quote()`, `round2`, `QuoteError`, `MIN_USD`/`MAX_USD` (fx.ts), `FxRates.toInr` (rate.ts:4), the `getQuoteTool` body + result-key set (tools.ts:390-420), and the `get_quote` schema (tools.ts:43-67). Win B depends only on `sendInteractive`'s call shape (whatsapp.ts:151-189), the `IncomingMessage` union (`types.ts:188-190`), `parseButtonId` (whatsapp-buttons.ts:55-74), `synthesizeButtonText` (route.ts:30-37), and the `paymentProviderMode` env pattern (env.ts:65-68). The multi-partner / FX best-rate batch is explicitly the NEXT batch, hanging off the `PaymentProvider` seam — NOT in scope here.

```
WIN A — receive-first quoting:
  get_quote(args)  args.amount_inr? (optional, NEW) | args.amount_usd | args.funding_method | args.source_currency
    │                                                                          src/lib/tools.ts:390 getQuoteTool
    ├─ resolveCurrencyAndRates(ctx, args.source_currency) → { sourceCurrency, rates }   (UNCHANGED)
    ├─ amountSource =
    │     if Number.isFinite(amount_inr) && amount_inr > 0 :  sourceForInr(amount_inr, rates)   ← NEW branch
    │     else                                             :  Number(args.amount_usd)            ← today, unchanged
    └─ quote(amountSource, sourceCurrency, rates, funding_method, transferCount)    ← UNCHANGED fn
          │                                                                          src/lib/fx.ts
          └─ amountInr = Math.round(amountSource * rates.toInr)   (fx.ts:59 — forward)
       sourceForInr(amountInr, rates) = round2(amountInr / rates.toInr)   ← NEW pure inverse (fx.ts)
       result-key set returned is IDENTICAL to today (source_currency/amount_source/fee_source/
       total_charge_source/amount_usd/fee_usd/total_charge_usd/fx_rate/amount_inr/delivery_estimate)

WIN B — Flows scaffolding (flag-gated, button fallback):
  send_recipient_picker(args)                                                    src/lib/tools.ts:727
    │   buttons = [recipient:<phone> ×≤2, recipient:new]   (UNCHANGED construction)
    └─ if env.whatsappFlowsEnabled:  try sendList(...)   ← NEW primitive, Graph-API shape == sendInteractive
            └─ on any failure ─────────────┐
       else (flag off, DEFAULT) ──────────┤
                                           ▼
                                    sendInteractive(...)   ← today's 3-button path (byte-for-byte)
  Incoming webhook:  parseIncoming(body)                                         src/lib/whatsapp.ts:31
    ├─ button_reply  → { kind:'button', buttonId }   (UNCHANGED)
    └─ list_reply    → { kind:'button', buttonId: id }   ← NEW branch, SAME shape ⇒ route.ts/parseButtonId reused unchanged
```

`sourceForInr` is a pure function beside `quote()` in fx.ts — TDD'd in isolation. The receive-first branch in `getQuoteTool` is the only call site; the result-key set the tool returns is unchanged regardless of which branch ran, so every downstream consumer (`send_approve_picker`, `create_transfer`, prompt copy) is unaffected. `sendList` is a sibling of `sendInteractive` with the identical fetch envelope; `parseIncoming`'s new `list_reply` branch reuses the existing `{ kind: 'button' }` output so the route, `parseButtonId`, `ButtonTap`, and `synthesizeButtonText` need zero changes.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, Upstash Redis, Meta WhatsApp Cloud API (Graph `v21.0`), Frankfurter FX (`FxRates`).

**Spec:** `../specs/2026-05-29-ux-recipient-amount-flows-design.md`

**Branch:** `spec/ux-quote-wins` (branch off the current `spec/p4-multi-currency` — `quote()`'s `sourceCurrency`/`amountSource` outputs, `FxRates.toInr`/`toUsd`, the `getQuoteTool` result-key set, the `IncomingMessage` union, `parseButtonId`'s `recipient:*` grammar, `synthesizeButtonText`, and the `paymentProviderMode` env pattern are all already present on this base).

**Scope decision (2026-05-29, user):** the Flows seam ships UNWIRED this batch. Build Win B as the `sendList` primitive + `parseIncoming` `list_reply` parse + the `WHATSAPP_FLOWS_ENABLED` flag ONLY -- do NOT wire `send_recipient_picker` (or any interaction) to it. The "wire send_recipient_picker" task is DEFERRED; the seam is dormant scaffolding for a future batch.

**Test count delta:** from **~549** (measured: 60 files, ~541 `it`/`test` cases; spec anchors ~549). New `tests/fx.test.ts` extensions for `sourceForInr` (~6); extensions to `tests/tools.test.ts` for the receive-first `get_quote` branch (~6); new `tests/whatsapp.test.ts` extensions for `sendList` + `parseIncoming` `list_reply` (~8); extensions to `tests/tools.test.ts` for the flag-gated `send_recipient_picker` fallback (~5). Net **+~25 → ~574**. The existing `fx.test.ts` `quote()` cases and `whatsapp.test.ts` `sendInteractive`/`parseIncoming` button cases stay **unmodified and green** — proof both wins compose without disturbing the existing paths; the flag-off `send_recipient_picker` test and the `amount_usd`-only `get_quote` test are the executable proofs the defaults are byte-for-byte unchanged.

**Patterns to reuse (do not reinvent):**
- **Inverse of the forward FX line (Win A core):** `quote()` computes `const amountInr = Math.round(amountSource * rates.toInr)` (fx.ts:59). `sourceForInr` is the exact algebraic inverse: `round2(amountInr / rates.toInr)`, reusing the module-private `round2 = (x) => Math.round(x * 100) / 100` (fx.ts:14) and throwing the existing `QuoteError` (fx.ts:7-12) on non-finite input. Do NOT add new error types or new min/max — the back-solved `amountSource` is fed to `quote()`, which already enforces `MIN_USD`/`MAX_USD` on the USD-equivalent (fx.ts:31-33).
- **Additive branch inside `getQuoteTool` (Win A wiring):** `getQuoteTool` (tools.ts:390-420) resolves `{ sourceCurrency, rates }` then calls `quote(Number(args.amount_usd), …)`. The receive-first branch computes `amountSource` *before* the `quote(...)` call and is the ONLY change; the `return { source_currency: …, amount_source: …, … }` block (tools.ts:404-415) is untouched. Guard the LLM input with `Number.isFinite(Number(args.amount_inr)) && Number(args.amount_inr) > 0` (the same `Number.isFinite` discipline `quote()` uses at fx.ts:23).
- **`sendInteractive`'s Graph-API envelope (Win B primitive):** `sendList` copies the exact `fetch(\`https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages\`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:\`Bearer ${env.whatsappToken}\` }, body: JSON.stringify({ messaging_product:'whatsapp', to, type:'interactive', interactive:{…} }) })` shape (whatsapp.ts:151-175), the `if (res.ok) return;` then `if (res.status === 470) { …sendText(to, fullBody); return; }` then `throw new Error(…)` tail (whatsapp.ts:177-188). Same numbered-text fallback body so a 470 still shows options.
- **`{ kind: 'button' }` collapse (Win B parse):** `parseIncoming`'s existing `button_reply` branch returns `{ kind:'button', from, buttonId, messageId }` (whatsapp.ts:50-55). The new `list_reply` branch returns the **same shape** with `buttonId: message.interactive.list_reply.id`, so route.ts (`parseButtonId` → `synthesizeButtonText`, route.ts:74-79) and the `recipient:<phone>` / `recipient:new` grammar (whatsapp-buttons.ts:62-64) are reused with zero edits. Defensive `?? ''` and presence checks on the untrusted webhook shape, exactly like the existing branch.
- **Strict-literal env flag (Win B gate):** `paymentProviderMode` reads `process.env.PAYMENT_PROVIDER_MODE === 'mock' ? 'mock' : 'mock'` (env.ts:65-68). Add `get whatsappFlowsEnabled(): boolean { return process.env.WHATSAPP_FLOWS_ENABLED === 'true'; }` — strict `=== 'true'` literal, default-false, no `required()` (optional, like `cronSecret` at env.ts:46-48).
- **`send_recipient_picker` button construction (Win B wiring):** the `buttons: InteractiveButton[]` array built from `recipientButtonId`/`someoneNewButtonId`/`disambiguateNames`/`truncateLabel` (tools.ts:742-750) is reused unchanged; only the *send call* (tools.ts:752-756) becomes flag-conditional with a try/`sendInteractive`-fallback.
- **Conventions:** TDD per task; `fakeRedis()` in tests; no `as any`; defensive on untrusted LLM amounts (`Number.isFinite`) and untrusted webhook reply shapes (`?? ''`, presence checks); the bot stays partner-blind; **one atomic commit per task**; commit prefix `feat(ux):`.

**CI reminders:**
- `main` branch protection requires the `ci / ci` status check; no direct pushes. Open a PR; Vercel auto-deploys on merge; Playwright smoke runs against prod.
- The full local gate is `npm run typecheck && npm run lint && npx vitest run && npm run build`.
- The existing `fx.test.ts` `quote()` cases and `whatsapp.test.ts` `sendInteractive`/`parseIncoming`-button cases must stay green **and unmodified** — if one needs editing to pass, an additive branch has collided with an existing path; fix the wiring, not the test.
- GitGuardian may red on a known env-var-name false positive (now plus `WHATSAPP_FLOWS_ENABLED`); `ci` is the required check.

---

## File Map

**New files:** none. (Every change is additive inside an existing module + its existing test file.)

**Modified files:**
- `src/lib/fx.ts` — add the exported pure helper `sourceForInr(amountInr: number, rates: FxRates): number` beside `quote()`; reuse `round2` and `QuoteError`. No change to `quote()`.
- `src/lib/tools.ts` — (Win A) add optional `amount_inr` to the `get_quote` schema (tools.ts:48-64) and an additive receive-first branch in `getQuoteTool` (tools.ts:390-420); (Win B) make `send_recipient_picker`'s send call flag-conditional with a `sendInteractive` fallback (tools.ts:752-756), importing `sendList`.
- `src/lib/whatsapp.ts` — add `sendList(...)` (sibling of `sendInteractive`) + a `list_reply` branch in `parseIncoming` collapsing to `{ kind:'button', buttonId }`; extend the `WebhookShape.interactive` type with `list_reply?: { id?: string; title?: string }`.
- `src/lib/env.ts` — add `get whatsappFlowsEnabled(): boolean` (strict `=== 'true'`, default-false).
- `src/lib/prompt.ts` — one additive sentence under the existing get_quote guidance (prompt.ts:21-22) explaining the customer can ask in **either** direction (send amount OR target rupees).
- `tests/fx.test.ts` — `sourceForInr` round-trip + inverse + error cases (~6).
- `tests/tools.test.ts` — receive-first `get_quote` branch (~6) + flag-gated `send_recipient_picker` fallback (~5).
- `tests/whatsapp.test.ts` — `sendList` envelope + 470-fallback + non-OK-throw, and `parseIncoming` `list_reply` collapse (~8).
- `.env.example` — document `WHATSAPP_FLOWS_ENABLED` (default unset = off).

> Deliberately **not** modified: `src/lib/fx.ts`'s `quote()` body (the receive-first branch lives entirely in `getQuoteTool`); `src/lib/types.ts` (the `IncomingMessage` union and `ButtonTap` are reused unchanged — `list_reply` collapses to `{ kind:'button' }`); `src/app/api/whatsapp/route.ts` (`parseButtonId`/`synthesizeButtonText` reused unchanged); `src/lib/whatsapp-buttons.ts` (the `recipient:*` grammar reused unchanged); the P4 cap/velocity/EDD accounting (no change — back-solved `amountSource` flows through the existing path). No new `TransferStatus`, no new `Transfer` field, no new Redis key, no new route, no new server action.

---

## Task 1: `sourceForInr` — pure FX inverse, TDD'd in isolation

**Goal:** Add the exported pure helper `sourceForInr(amountInr, rates)` to `src/lib/fx.ts`, the exact algebraic inverse of the forward line `amountInr = Math.round(amountSource * rates.toInr)` (fx.ts:59): `round2(amountInr / rates.toInr)`. Reuse the module-private `round2` (fx.ts:14) and throw the existing `QuoteError` (fx.ts:7-12) on non-finite or non-positive input. **No change to `quote()`.** This is a leaf function with no I/O — the cleanest possible first task and the foundation for Win A.

**Files:**
- Modify: `src/lib/fx.ts`
- Test: `tests/fx.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/fx.test.ts` (it already imports from `@/lib/fx` and uses the `USD`/`GBP` rate fixtures or inline `FxRates`). Mirror the existing `quote()` tests' rate style:

```ts
import { sourceForInr, quote, QuoteError } from '@/lib/fx';
import type { FxRates } from '@/lib/rate';

const usd: FxRates = { toInr: 85, toUsd: 1 };
const gbp: FxRates = { toInr: 108, toUsd: 1.27 };

describe('sourceForInr — back-solve send amount from a target rupee amount', () => {
  it('is the inverse of the forward amountInr line for USD', () => {
    // forward: 500 * 85 = 42500; inverse of 42500 must round-trip to ~500
    expect(sourceForInr(42500, usd)).toBe(500);
  });
  it('back-solves a non-USD source currency (GBP)', () => {
    // 108 INR per GBP; 21600 / 108 = 200
    expect(sourceForInr(21600, gbp)).toBe(200);
  });
  it('rounds the source amount to 2 dp (cents), like round2', () => {
    // 40000 / 85 = 470.588... → 470.59
    expect(sourceForInr(40000, usd)).toBe(470.59);
  });
  it('round-trips through quote(): the recipient gets ~the requested INR', () => {
    const src = sourceForInr(40000, usd);            // 470.59
    const q = quote(src, 'USD', usd, 'bank_transfer', 1);
    expect(q.amountInr).toBe(Math.round(470.59 * 85)); // 40000 (±1 from cent rounding)
  });
  it('throws QuoteError on a non-finite target', () => {
    expect(() => sourceForInr(Number.NaN, usd)).toThrow(QuoteError);
    expect(() => sourceForInr(Number.POSITIVE_INFINITY, usd)).toThrow(QuoteError);
  });
  it('throws QuoteError on a non-positive target', () => {
    expect(() => sourceForInr(0, usd)).toThrow(QuoteError);
    expect(() => sourceForInr(-100, usd)).toThrow(QuoteError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/fx.test.ts`
Expected: FAIL — `sourceForInr` is not exported from `@/lib/fx`.

- [ ] **Step 3: Implement `sourceForInr` in `src/lib/fx.ts`**

Add directly after `quote()` (after fx.ts:73), reusing the existing `round2` and `QuoteError`:

```ts
/**
 * Back-solve the send amount (in the sender's source currency) from a target
 * rupee amount the recipient should receive — the exact inverse of the forward
 * line `amountInr = Math.round(amountSource * rates.toInr)` in quote(). The
 * caller feeds the result straight into quote(), which enforces MIN_USD/MAX_USD
 * on the USD-equivalent and adds the fee on TOP (the recipient still gets the
 * exact target INR). Receive-first quoting (Win A) is the only caller.
 */
export function sourceForInr(amountInr: number, rates: FxRates): number {
  if (!Number.isFinite(amountInr) || amountInr <= 0) {
    throw new QuoteError('Please give a valid rupee amount.');
  }
  if (!Number.isFinite(rates.toInr) || rates.toInr <= 0) {
    throw new QuoteError('Invalid exchange rate; please try again.');
  }
  return round2(amountInr / rates.toInr);
}
```

> `round2` and `QuoteError` are already in module scope (fx.ts:7-14). `FxRates` is already imported (fx.ts:2). No new import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fx.test.ts`
Expected: PASS — the new ~6 cases plus every existing `quote()` case unchanged and green.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. Nothing imports `sourceForInr` yet outside the test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fx.ts tests/fx.test.ts
git commit -m "feat(ux): sourceForInr — pure inverse of the forward INR line"
```

---

## Task 2: Receive-first branch in `getQuoteTool` + schema + prompt copy

**Goal:** Add an **optional** `amount_inr` to the `get_quote` schema (tools.ts:48-64) and an additive receive-first branch in `getQuoteTool` (tools.ts:390-420): when `args.amount_inr` is finite and `> 0`, compute `amountSource = sourceForInr(Number(args.amount_inr), rates)`; otherwise `amountSource = Number(args.amount_usd)` (today's exact value). If both are given, `amount_inr` wins. The back-solved amount flows through the **unchanged** `quote(...)` call, and the `return { … }` result-key set is **untouched**. One additive sentence in `prompt.ts` tells the model the customer can ask either direction. **The `amount_usd`-only path is byte-for-byte unchanged** — the new branch only runs when `amount_inr` is present.

**Files:**
- Modify: `src/lib/tools.ts`, `src/lib/prompt.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Confirm the baseline is green before wiring**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS — capture this; the existing `get_quote` cases (send-amount-first, currency, error) must read identically after this task.

- [ ] **Step 2: Write the failing tests**

Add to `tests/tools.test.ts` (it already builds a `ctx: ToolContext` with `fakeRedis()`-backed stores and calls `executeTool('get_quote', args, ctx)` or `getQuoteTool` directly). Mirror the existing get_quote test's ctx setup:

```ts
describe('get_quote: receive-first (amount_inr) branch', () => {
  it('amount_inr back-solves the send amount; recipient gets ~the target INR', async () => {
    const ctx = makeCtx(); // existing helper; default USD rates toInr=85
    const res = await executeTool('get_quote',
      { amount_inr: 42500, funding_method: 'bank_transfer' }, ctx);
    expect('error' in res).toBe(false);
    expect(res.amount_inr).toBeCloseTo(42500, -1); // recipient gets the requested rupees
    expect(res.amount_source).toBeCloseTo(500, 2); // back-solved 42500/85
    // result-key set is unchanged from the send-first path:
    for (const k of ['source_currency','amount_source','fee_source','total_charge_source',
                     'amount_usd','fee_usd','total_charge_usd','fx_rate','amount_inr','delivery_estimate'])
      expect(k in res).toBe(true);
  });

  it('amount_inr WINS when both amount_inr and amount_usd are given', async () => {
    const ctx = makeCtx();
    const res = await executeTool('get_quote',
      { amount_inr: 42500, amount_usd: 9999, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBeCloseTo(500, 2); // from 42500/85, NOT 9999
  });

  it('send-first path is UNCHANGED when amount_inr is absent', async () => {
    const ctx = makeCtx();
    const res = await executeTool('get_quote',
      { amount_usd: 500, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBe(500);
    expect(res.amount_inr).toBe(Math.round(500 * 85));
  });

  it('a non-finite / non-positive amount_inr is ignored, falling back to amount_usd', async () => {
    const ctx = makeCtx();
    const res = await executeTool('get_quote',
      { amount_inr: 'abc', amount_usd: 500, funding_method: 'bank_transfer' }, ctx);
    expect(res.amount_source).toBe(500); // junk amount_inr did not hijack the quote
  });

  it('the back-solved amount still hits the MIN/MAX guard (QuoteError → error result)', async () => {
    const ctx = makeCtx();
    // 85 INR → ~$1; below MIN_USD=10 ⇒ quote() throws QuoteError, surfaced as { error }
    const res = await executeTool('get_quote',
      { amount_inr: 85, funding_method: 'bank_transfer' }, ctx);
    expect('error' in res).toBe(true);
  });

  it('receive-first respects source_currency (GBP rates)', async () => {
    const ctx = makeCtx({ partnerCurrencies: ['GBP'] }); // existing multi-currency ctx hook
    const res = await executeTool('get_quote',
      { amount_inr: 21600, funding_method: 'bank_transfer', source_currency: 'GBP' }, ctx);
    expect(res.source_currency).toBe('GBP');
    expect(res.amount_source).toBeCloseTo(200, 2); // 21600 / 108
  });
});
```

> Match this file's actual `ctx`-builder and assertion helpers; the asserts above are the load-bearing part. If `makeCtx` does not expose a currency hook, follow the file's existing multi-currency get_quote test for seeding the partner's allowed currencies.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — `amount_inr` is ignored today, so the receive-first cases get the wrong `amount_source` (or error on missing `amount_usd`).

- [ ] **Step 4: Implement the schema + branch in `src/lib/tools.ts`**

Add `amount_inr` to the `get_quote` schema properties (after `amount_usd`, tools.ts:48-52). Leave `required: ['amount_usd', 'funding_method']` alone — `amount_usd` stays the documented default; `amount_inr` is the optional alternative the model fills in instead:

```ts
          amount_inr: {
            type: 'number',
            description:
              "Optional. The exact rupee amount the RECIPIENT should receive. Provide this INSTEAD of amount_usd when the customer asks in rupees ('I want mom to get ₹40000'). We back-solve the send amount and add the fee on top. If both are given, amount_inr wins.",
          },
```

Add the import beside the other fx imports at the top of tools.ts (it already imports `quote`, `QuoteError` from `./fx`):

```ts
import { quote, QuoteError, sourceForInr } from './fx';
```

In `getQuoteTool` (tools.ts:394-403), compute `amountSource` before the `quote(...)` call:

```ts
  try {
    const transferCount = await ctx.store.getTransferCount(ctx.phone);
    const { sourceCurrency, rates } = await resolveCurrencyAndRates(ctx, args.source_currency);

    // Receive-first (Win A): when a finite, positive target rupee amount is
    // given, back-solve the send amount; the recipient gets exactly that INR
    // and the fee is added on top (today's model). amount_inr wins over
    // amount_usd. Otherwise this is byte-for-byte today's send-first path.
    const targetInr = Number(args.amount_inr);
    const amountSource =
      Number.isFinite(targetInr) && targetInr > 0
        ? sourceForInr(targetInr, rates)
        : Number(args.amount_usd);

    const q = quote(
      amountSource,
      sourceCurrency,
      rates,
      args.funding_method as FundingMethod,
      transferCount,
    );
    return {
      // ── result-key set UNCHANGED (tools.ts:404-415) ──
      source_currency: q.sourceCurrency,
      amount_source: q.amountSource,
      // … (rest unchanged)
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
```

> The `sourceForInr` call can throw `QuoteError` (non-finite/non-positive), caught by the existing `catch` (tools.ts:416-418) → `{ error }`, identical to how `quote()`'s errors surface today. The return block (tools.ts:404-415) is not edited.

Add one additive sentence to `prompt.ts` under the existing get_quote guidance (after prompt.ts:21-22):

```
- The customer can quote in EITHER direction: a send amount ("send $500") OR a
  target rupee amount the recipient should receive ("I want mom to get ₹40000").
  For a send amount pass amount_usd; for a target receive amount pass amount_inr
  to get_quote instead. Never compute the conversion yourself — get_quote does it.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS — the new ~6 cases plus every existing `get_quote` case (send-first, currency, error) unchanged and green.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tools.ts src/lib/prompt.ts tests/tools.test.ts
git commit -m "feat(ux): get_quote back-solves send amount from target rupees (additive)"
```

---

## Task 3: `sendList` primitive + `parseIncoming` `list_reply` collapse + env flag

**Goal:** Add the richer interactive primitive `sendList(...)` to `src/lib/whatsapp.ts` (sibling of `sendInteractive`, identical Graph-API envelope, same HTTP-470 → `sendText` fallback, throw on any other non-OK), and a `list_reply` branch in `parseIncoming` that **collapses into the existing `{ kind:'button'; buttonId }` shape** so `parseButtonId`/`synthesizeButtonText`/the `recipient:*` grammar are reused unchanged. Add the env flag `whatsappFlowsEnabled` (strict `=== 'true'`, default-false). **No wiring yet** — this task delivers the unit-testable primitive + parse + flag in isolation; Task 4 wires `send_recipient_picker`. The existing `sendInteractive` and `parseIncoming`-button cases stay green and unmodified.

**Files:**
- Modify: `src/lib/whatsapp.ts`, `src/lib/env.ts`, `.env.example`
- Test: `tests/whatsapp.test.ts`

- [ ] **Step 1: Confirm the baseline is green before extending**

Run: `npx vitest run tests/whatsapp.test.ts`
Expected: PASS — capture this; the `sendInteractive` (470-fallback, non-OK-throw) and `parseIncoming` (text, button_reply, null) cases must read identically after this task.

- [ ] **Step 2: Write the failing tests**

Add to `tests/whatsapp.test.ts` (it already stubs `global.fetch` / mocks `env` and asserts on the request body + fallback behavior). Mirror the existing `sendInteractive` test's fetch-stub style:

```ts
import { sendList, parseIncoming } from '@/lib/whatsapp';

describe('sendList — richer interactive list, sendInteractive-shaped envelope', () => {
  it('POSTs the Graph v21.0 messages endpoint with an interactive list body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await sendList('15551230000', 'Who are we sending to?', 'Choose', [
      { id: 'recipient:919876543210', title: 'Mom' },
      { id: 'recipient:new', title: 'Someone new' },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v21.0/');
    expect(url).toContain('/messages');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.messaging_product).toBe('whatsapp');
    expect(sent.type).toBe('interactive');
    expect(sent.interactive.type).toBe('list');
    // row ids carry the SAME grammar parseButtonId already understands
    const rowIds = sent.interactive.action.sections
      .flatMap((s: { rows: { id: string }[] }) => s.rows).map((r: { id: string }) => r.id);
    expect(rowIds).toContain('recipient:919876543210');
    expect(rowIds).toContain('recipient:new');
  });

  it('falls back to sendText on HTTP 470 (24h window), like sendInteractive', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 470, text: async () => 'window' })
      .mockResolvedValueOnce({ ok: true, status: 200 }); // the sendText retry
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendList('15551230000', 'Body', 'Choose', [
      { id: 'recipient:new', title: 'Someone new' },
    ])).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(second.type).toBe('text'); // fell back to plain text with the options listed
  });

  it('throws on a non-OK, non-470 status (so the caller can fall back to buttons)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' });
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendList('15551230000', 'Body', 'Choose', [
      { id: 'recipient:new', title: 'Someone new' },
    ])).rejects.toThrow();
  });
});

describe('parseIncoming — list_reply collapses to the existing button shape', () => {
  it('a list_reply yields { kind: "button", buttonId } (same shape as button_reply)', () => {
    const msg = parseIncoming({
      entry: [{ changes: [{ value: { messages: [{
        type: 'interactive', from: '15551230000', id: 'wamid.1',
        interactive: { type: 'list_reply', list_reply: { id: 'recipient:919876543210', title: 'Mom' } },
      }] } }] }],
    });
    expect(msg).toEqual({ kind: 'button', from: '15551230000',
      buttonId: 'recipient:919876543210', messageId: 'wamid.1' });
  });
  it('returns null for a list_reply missing its id (defensive)', () => {
    const msg = parseIncoming({
      entry: [{ changes: [{ value: { messages: [{
        type: 'interactive', from: '15551230000', id: 'wamid.2',
        interactive: { type: 'list_reply', list_reply: {} },
      }] } }] }],
    });
    expect(msg).toBeNull();
  });
  it('still parses a button_reply exactly as before (regression)', () => {
    const msg = parseIncoming({
      entry: [{ changes: [{ value: { messages: [{
        type: 'interactive', from: '15551230000', id: 'wamid.3',
        interactive: { type: 'button_reply', button_reply: { id: 'recipient:new', title: 'Someone new' } },
      }] } }] }],
    });
    expect(msg).toEqual({ kind: 'button', from: '15551230000', buttonId: 'recipient:new', messageId: 'wamid.3' });
  });
});

describe('env.whatsappFlowsEnabled — strict-true, default-false', () => {
  // follow this file's existing env-mock pattern (vi.stubEnv or the project's env helper)
  it('is false when unset', () => { vi.stubEnv('WHATSAPP_FLOWS_ENABLED', ''); /* assert env.whatsappFlowsEnabled === false */ });
  it('is true only on the literal "true"', () => { vi.stubEnv('WHATSAPP_FLOWS_ENABLED', 'true'); /* assert true */ });
  it('is false on "1"/"yes"/"TRUE"', () => { vi.stubEnv('WHATSAPP_FLOWS_ENABLED', '1'); /* assert false */ });
});
```

> If `env` is read at module load and hard to re-stub, put the `whatsappFlowsEnabled` assertions in `tests/env.test.ts` following that file's existing pattern instead — the strict-`=== 'true'` behavior is the load-bearing assertion.

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/whatsapp.test.ts`
Expected: FAIL — `sendList` is not exported; `parseIncoming` ignores `list_reply` (returns null for the valid case).

- [ ] **Step 4: Implement in `src/lib/whatsapp.ts` + `src/lib/env.ts`**

Extend `WebhookShape.interactive` (whatsapp.ts:21-24) to allow the list reply:

```ts
          interactive?: {
            type?: string;
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
```

Add the `list_reply` branch in `parseIncoming`, right after the existing `button_reply` branch (after whatsapp.ts:56), collapsing to the SAME shape:

```ts
    if (
      message.type === 'interactive' &&
      message.interactive?.type === 'list_reply' &&
      message.interactive.list_reply?.id
    ) {
      return {
        kind: 'button', // collapse to the existing button shape — route + parseButtonId reused unchanged
        from: message.from,
        buttonId: message.interactive.list_reply.id,
        messageId: message.id,
      };
    }
```

Add `sendList` after `sendInteractive` (after whatsapp.ts:189), copying its envelope + fallback tail. Single-section list; rows carry the same `id` grammar:

```ts
export interface ListRow {
  id: string;
  title: string;
}

/**
 * Send an interactive LIST message (WhatsApp Flows scaffolding). Same Graph API
 * envelope as sendInteractive; same HTTP-470 → sendText fallback. On any other
 * non-OK status it THROWS so the caller can fall back to buttons. Row ids carry
 * the existing recipient:<phone> / recipient:new grammar, so parseIncoming's
 * list_reply branch and parseButtonId need no changes. Gated behind
 * env.whatsappFlowsEnabled at the call site — flag off ⇒ this is never reached.
 */
export async function sendList(
  to: string,
  bodyText: string,
  buttonText: string,
  rows: ListRow[],
): Promise<void> {
  if (rows.length === 0 || rows.length > 10) {
    throw new Error(`sendList: WhatsApp accepts 1-10 list rows (got ${rows.length}).`);
  }
  const numbered = rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
  const fullBody = `${bodyText}\n\n${numbered}`;

  const res = await fetch(
    `https://graph.facebook.com/v21.0/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.whatsappToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: buttonText,
            sections: [{ rows: rows.map((r) => ({ id: r.id, title: r.title })) }],
          },
        },
      }),
    },
  );

  if (res.ok) return;

  if (res.status === 470) {
    console.warn('sendList hit 24h-window error; falling back to sendText');
    await sendText(to, fullBody);
    return;
  }

  const body = await res.text();
  throw new Error(`WhatsApp list send failed (${res.status}): ${body}`);
}
```

Add the flag to `src/lib/env.ts` (after `paymentProviderMode`, env.ts:68), strict-literal + default-false:

```ts
  get whatsappFlowsEnabled(): boolean {
    // Strict 'true' literal (mirrors paymentProviderMode). Default-false: the
    // test WABA is not Meta-Business-verified, so a live list/flow send may
    // fail — the send_recipient_picker call site falls back to buttons.
    return process.env.WHATSAPP_FLOWS_ENABLED === 'true';
  },
```

Document it in `.env.example`:

```
# Optional. 'true' enables the WhatsApp interactive-list primitive for the
# recipient picker; anything else (default) uses 3-button messages. Falls back
# to buttons on any list-send failure. Requires a Meta-Business-verified WABA.
WHATSAPP_FLOWS_ENABLED=
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/whatsapp.test.ts`
Expected: PASS — the new ~8 cases plus every existing `sendInteractive`/`parseIncoming` case unchanged and green.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. (`sendList` is exported but not yet imported outside the test — fine.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp.ts src/lib/env.ts .env.example tests/whatsapp.test.ts
git commit -m "feat(ux): sendList primitive + list_reply parse + WHATSAPP_FLOWS_ENABLED flag"
```

---

## Task 4: Wire `send_recipient_picker` behind the flag, with button fallback

**Goal:** Make `send_recipient_picker`'s send call (tools.ts:752-756) flag-conditional: when `env.whatsappFlowsEnabled` is true, `try` `sendList(...)` (reusing the SAME `buttons` array's ids/titles as list rows); on ANY failure — or when the flag is off (DEFAULT) — fall back to today's `sendInteractive(...)`. The button-array construction (tools.ts:738-750) is unchanged. **DEFAULT (flag off) = byte-for-byte today's behavior**, proven by a flag-off test asserting `sendInteractive` is called and `sendList` is not.

**Files:**
- Modify: `src/lib/tools.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools.test.ts`. Mock the whatsapp module's `sendInteractive`/`sendList` (the file already mocks `@/lib/whatsapp` for the picker tests) and the env flag:

```ts
describe('send_recipient_picker: flag-gated list with button fallback', () => {
  const recipients = [{ name: 'Mom', recipient_phone: '919876543210' }];

  it('flag OFF (default): uses sendInteractive, never sendList (byte-for-byte today)', async () => {
    vi.stubEnv('WHATSAPP_FLOWS_ENABLED', ''); // off
    const ctx = makeCtx();
    await executeTool('send_recipient_picker', { recipients }, ctx);
    expect(sendInteractiveMock).toHaveBeenCalledTimes(1);
    expect(sendListMock).not.toHaveBeenCalled();
  });

  it('flag ON: uses sendList with the same recipient:* row ids', async () => {
    vi.stubEnv('WHATSAPP_FLOWS_ENABLED', 'true');
    sendListMock.mockResolvedValueOnce(undefined);
    const ctx = makeCtx();
    await executeTool('send_recipient_picker', { recipients }, ctx);
    expect(sendListMock).toHaveBeenCalledTimes(1);
    expect(sendInteractiveMock).not.toHaveBeenCalled();
    const rows = sendListMock.mock.calls[0][3] as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(
      expect.arrayContaining(['recipient:919876543210', 'recipient:new']));
  });

  it('flag ON but sendList THROWS: falls back to sendInteractive (prod stays identical)', async () => {
    vi.stubEnv('WHATSAPP_FLOWS_ENABLED', 'true');
    sendListMock.mockRejectedValueOnce(new Error('WABA not verified'));
    const ctx = makeCtx();
    const res = await executeTool('send_recipient_picker', { recipients }, ctx);
    expect(sendListMock).toHaveBeenCalledTimes(1);
    expect(sendInteractiveMock).toHaveBeenCalledTimes(1); // fell back
    expect(res).toEqual({ sent: true });
  });

  it('returns { sent: true } in all three cases', async () => {
    // covered above; assert the result shape is unchanged regardless of path
  });

  it('caps at 2 saved recipients + "Someone new" on both paths', async () => {
    vi.stubEnv('WHATSAPP_FLOWS_ENABLED', 'true');
    sendListMock.mockResolvedValueOnce(undefined);
    const ctx = makeCtx();
    await executeTool('send_recipient_picker', { recipients: [
      { name: 'A', recipient_phone: '911111111111' },
      { name: 'B', recipient_phone: '922222222222' },
      { name: 'C', recipient_phone: '933333333333' },
    ] }, ctx);
    const rows = sendListMock.mock.calls[0][3] as { id: string }[];
    expect(rows).toHaveLength(3); // 2 capped + Someone new
  });
});
```

> Match the file's existing whatsapp-mock setup (`vi.mock('@/lib/whatsapp', …)` exposing `sendInteractiveMock`); add `sendList` to that mock. The asserts above are the load-bearing part.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — `send_recipient_picker` calls `sendInteractive` unconditionally; the flag-ON case finds `sendList` was never called.

- [ ] **Step 3: Implement the flag-conditional send in `src/lib/tools.ts`**

Add `sendList` (and `type ListRow`) to the existing whatsapp import (tools.ts:19) and `env`:

```ts
import { sendInteractive, sendList, type InteractiveButton, type ListRow } from './whatsapp';
import { env } from './env';
```

Replace the unconditional `await sendInteractive(...)` (tools.ts:752-756) with the flag-conditional send. The `buttons` array (tools.ts:743-750) is reused unchanged as both the list rows and the fallback buttons:

```ts
  const bodyText = 'Welcome back 👋 Who are we sending to?';

  if (env.whatsappFlowsEnabled) {
    try {
      const rows: ListRow[] = buttons.map((b) => ({ id: b.id, title: b.title }));
      await sendList(ctx.phone, bodyText, 'Choose recipient', rows);
      return { sent: true };
    } catch (err) {
      // Test WABA may not be Meta-Business-verified → list send fails. Fall back
      // to the 3-button path so prod behavior is identical to flag-off.
      console.warn('send_recipient_picker: sendList failed, falling back to buttons', err);
    }
  }

  await sendInteractive(ctx.phone, bodyText, buttons);
  return { sent: true };
```

> Flag off ⇒ the `if` block is skipped entirely ⇒ the trailing `sendInteractive(...)` is reached with the exact same `buttons` and body text as today (byte-for-byte). Flag on + throw ⇒ the `catch` swallows and falls through to the same `sendInteractive`. `{ sent: true }` is returned on every path, identical to today.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS — the new ~5 cases plus the Task-2 receive-first cases and every existing picker case green.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(ux): send_recipient_picker uses sendList behind flag, falls back to buttons"
```

---

## Task 5: Wrap — full verification, PR, post-merge runbook

**Files:** none (verification + git).

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean; the full suite green (~574 tests). The pre-batch ~549 staying green — `fx.test.ts`'s `quote()` cases and `whatsapp.test.ts`'s `sendInteractive`/`parseIncoming`-button cases unmodified — is the proof both wins compose. The `amount_usd`-only `get_quote` test and the flag-off `send_recipient_picker` test are the proofs the defaults are byte-for-byte unchanged.

- [ ] **Step 2: Confirm the safety invariant by hand**

Verify the additive / dormant-by-default claims explicitly:
- `git diff main -- src/lib/types.ts` → **empty** (no new `TransferStatus`, no new `Transfer` field; `IncomingMessage`/`ButtonTap` reused).
- `git diff main -- src/app/api/whatsapp/route.ts src/lib/whatsapp-buttons.ts` → **empty** (`list_reply` collapses to `{ kind:'button' }`, so route + `parseButtonId` + `synthesizeButtonText` + the `recipient:*` grammar are untouched).
- `git diff main -- src/lib/fx.ts` shows ONLY the added `sourceForInr` — `quote()`'s body is unchanged (the forward `amountInr = Math.round(amountSource * rates.toInr)` line at fx.ts:59 is intact).
- `git grep -n "amount_inr" src/lib/tools.ts` confirms the receive-first branch is the only new logic in `getQuoteTool` and the result-key set (tools.ts:404-415) is unedited.
- Win A dormant: the `get_quote` `amount_usd`-only test gives `amount_source === Number(args.amount_usd)`, identical to today.
- Win B dormant: the flag-off `send_recipient_picker` test asserts `sendInteractive` called, `sendList` not — byte-for-byte today's behavior.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin spec/ux-quote-wins
gh pr create --title "feat(ux): recipient-amount-first quoting + WhatsApp Flows scaffolding" --body "$(cat <<'EOF'
## Summary
Two additive UX wins, both dormant-by-default — the existing suite staying green is the proof.

**Win A — recipient-amount-first quoting.** `get_quote` gains an OPTIONAL `amount_inr`. When present, `getQuoteTool` back-solves the send amount via a NEW pure helper `sourceForInr(amountInr, rates) = round2(amountInr / rates.toInr)` — the exact inverse of the forward `amountInr = Math.round(amountSource * rates.toInr)` line in `quote()` — then calls the UNCHANGED `quote(...)`. The recipient gets the exact target INR; the fee is added on top (today's model). The back-solved amount flows through the SAME `quote()` MIN/MAX and the SAME P4 USD-equivalent cap/velocity/EDD accounting. `amount_inr` wins over `amount_usd`. With `amount_usd` only, `getQuoteTool` reduces to today's exact call; the returned result-key set is unchanged.

**Win B — WhatsApp Flows scaffolding (flag-gated, button fallback).** New `sendList` primitive mirrors `sendInteractive`'s exact Graph `v21.0` envelope + HTTP-470 → `sendText` fallback (throws on other non-OK so the caller can fall back). `parseIncoming` gains a `list_reply` branch that collapses into the existing `{ kind:'button'; buttonId }` shape, so the webhook route, `parseButtonId`, `ButtonTap`, `synthesizeButtonText`, and the `recipient:*` grammar are reused UNCHANGED. New env flag `WHATSAPP_FLOWS_ENABLED` (strict `=== 'true'`, default-false, mirrors `paymentProviderMode`). Only `send_recipient_picker` is wired: flag-on tries `sendList`, falls back to today's 3-button `sendInteractive` on any failure OR when the flag is off. The test WABA is not Meta-Business-verified, so a live list send may fail — the fallback keeps prod identical.

## Safety invariant (the executable proof)
- Additive + dormant: Win A fires ONLY on a finite, positive `amount_inr`; Win B is flag-off-by-default + button fallback. DEFAULT behavior is byte-for-byte unchanged (explicit `amount_usd`-only and flag-off tests).
- No new `TransferStatus`, no new `Transfer` field, no schema/Redis/route/server-action change. `git diff main` on `types.ts`, `route.ts`, `whatsapp-buttons.ts` is empty; `quote()`'s body is unchanged.
- The pre-batch ~549-test suite stays green; `fx.test.ts`'s `quote()` cases and `whatsapp.test.ts`'s `sendInteractive`/`parseIncoming`-button cases are unmodified.

## Test plan
- [ ] typecheck / lint / vitest / build all green (~574 tests)
- [ ] New: `sourceForInr` inverse/round-trip/error (fx); receive-first `get_quote` (amount_inr wins, send-first unchanged, junk-ignored, MIN/MAX guard, GBP); `sendList` envelope + 470-fallback + non-OK-throw + `list_reply` collapse + flag (whatsapp/env); flag-gated `send_recipient_picker` with button fallback (tools)
- [ ] `git diff main -- src/lib/types.ts src/app/api/whatsapp/route.ts src/lib/whatsapp-buttons.ts` is empty (no-schema-change / reuse proof)

## Out of scope (deferred — NEXT batch)
- FX rate-lock / multi-partner best-rate FX selection (the FX/settlement-provider best-rate feature: admin + API rate entry, ties to the `PaymentProvider` seam) — explicitly a separate batch
- Voice-note intent (needs an STT provider/key)
- A Meta-PUBLISHED multi-screen Flow JSON requiring the verified WABA — this batch scaffolds the send/parse primitive + fallback only; it does NOT depend on a published Flow that can't run on the test number
- Rate prediction / alerts
EOF
)"
```

- [ ] **Step 4: Confirm `ci / ci` is green on the PR**

Run: `gh pr checks <pr-number>`
Expected: `ci` passes. (GitGuardian may red on the known env-var-name false positive, now plus `WHATSAPP_FLOWS_ENABLED`.)

- [ ] **Step 5: Post-merge runbook**

After merge → Vercel auto-deploys → Playwright smoke runs against prod. **No migration runs** — no schema, key, or route change. Live behavior with **`WHATSAPP_FLOWS_ENABLED` unset (the deploy default): identical to today** — `get_quote` only back-solves when the model passes `amount_inr` (a new capability the prompt now offers), and `send_recipient_picker` still sends 3 buttons. To pilot Flows on a verified WABA later, set `WHATSAPP_FLOWS_ENABLED=true` in Vercel env and redeploy; if a live list send fails (e.g. WABA not Business-verified), the picker silently falls back to buttons, so there is no customer-visible breakage. Win A is live immediately and safely (it only changes which arithmetic `getQuoteTool` runs before the unchanged `quote()`; cap/velocity/EDD accounting is unaffected). The documented NEXT batch is FX rate-lock / multi-partner best-rate selection off the `PaymentProvider` seam.

---

## Self-Review (completed by plan author)

**Spec coverage (tasks → spec sections):**
- §Win A (`sourceForInr(amountInr, rates) = round2(amountInr / rates.toInr)` — exact inverse of fx.ts:59, reusing `round2`/`QuoteError`) → **Task 1**; (additive receive-first branch in `getQuoteTool`, `amount_inr` optional in schema, wins over `amount_usd`, finite/`>0` guard, unchanged `quote()` call + result-key set, prompt either-direction sentence) → **Task 2**.
- §Win B (`sendList` mirroring `sendInteractive`'s Graph-API envelope + 470→`sendText` fallback + throw-on-other-non-OK; `parseIncoming` `list_reply` collapse to `{ kind:'button' }`; strict-`'true'` env flag) → **Task 3**; (only `send_recipient_picker` wired, flag-on tries `sendList`, falls back to `sendInteractive` on failure or flag-off) → **Task 4**.
- §Safety invariant (both additive + dormant; Win A fires only on `amount_inr`; Win B flag-off-by-default + button fallback ⇒ default byte-for-byte unchanged; no new `TransferStatus`/`Transfer` field/schema/key; ~549-suite + reused route/`parseButtonId`/grammar unchanged) → proven as units in **Task 1** (`sourceForInr` isolation), at the branch in **Task 2** (`amount_usd`-only-unchanged), in the primitive in **Task 3** (`parseIncoming`-button regression), at the wiring in **Task 4** (flag-off-uses-sendInteractive), and whole-suite-green + empty `git diff` on `types.ts`/`route.ts`/`whatsapp-buttons.ts` in **Task 5**.
- §Testing strategy → fx (~6) + tools receive-first (~6) + whatsapp/env (~8) + tools picker-fallback (~5); existing `quote()`/`sendInteractive`/`parseIncoming`-button cases unmodified; projected +~25 → ~574 from ~549.
- §Out of scope: FX rate-lock/multi-partner best-rate (NEXT batch, `PaymentProvider` seam), voice (STT), published multi-screen Flow JSON requiring a verified WABA, rate prediction/alerts — all reiterated in the PR body and runbook.

**Placeholder scan:** No TBD/TODO. Every code step cites symbols verified in this session — the forward line `amountInr = Math.round(amountSource * rates.toInr)` (fx.ts:59), `round2` (fx.ts:14), `QuoteError` (fx.ts:7-12), `MIN_USD`/`MAX_USD` (fx.ts:4-5, enforced at fx.ts:31-33), `FxRates.toInr`/`toUsd` (rate.ts:3-5), `getQuoteTool`'s `quote(Number(args.amount_usd), …)` call + result-key set (tools.ts:397-415), the `get_quote` schema (tools.ts:43-67, `required: ['amount_usd','funding_method']`), `sendInteractive`'s envelope + 470-fallback + non-OK-throw (whatsapp.ts:151-188), `parseIncoming`'s `button_reply` branch returning `{ kind:'button', from, buttonId, messageId }` (whatsapp.ts:45-56), the `WebhookShape.interactive` type (whatsapp.ts:21-24), the `IncomingMessage` union (`types.ts:188-190`), `parseButtonId`'s `recipient:*` grammar (whatsapp-buttons.ts:62-64), `synthesizeButtonText` (route.ts:30-37), the `paymentProviderMode` strict-literal env pattern (env.ts:65-68), and `send_recipient_picker`'s button construction + `sendInteractive(...)` call (tools.ts:738-757). The receive-first round-trip examples (42500/85 ≈ 500, 21600/108 = 200, 40000/85 → 470.59) match `round2` semantics.

**Type consistency:** `sourceForInr(amountInr: number, rates: FxRates): number` (throws `QuoteError`); `get_quote` schema `amount_inr: { type: 'number' }` (optional, `required` unchanged); in `getQuoteTool`, `const targetInr = Number(args.amount_inr)` then `const amountSource = Number.isFinite(targetInr) && targetInr > 0 ? sourceForInr(targetInr, rates) : Number(args.amount_usd)` — `amountSource: number` feeds the unchanged `quote(amountSource: number, …)`; the `return { … }` is the identical `ToolResult`. `sendList(to: string, bodyText: string, buttonText: string, rows: ListRow[]): Promise<void>` with `interface ListRow { id: string; title: string }`; `parseIncoming`'s `list_reply` branch returns the `IncomingMessage` `{ kind:'button'; from: string; buttonId: string; messageId: string }` variant. `env.whatsappFlowsEnabled: boolean` (`=== 'true'`). In `send_recipient_picker`, `const rows: ListRow[] = buttons.map((b) => ({ id: b.id, title: b.title }))` from the existing `InteractiveButton[]`; both paths return `{ sent: true }`. No `as any`; `??` for fallbacks; `Number.isFinite` on the untrusted `amount_inr`; presence checks (`?.id`, `?? ''`) on the untrusted webhook `list_reply`. No new `Transfer` field, no new `TransferStatus`, no new Redis key, no new route, no new server action. ✓
