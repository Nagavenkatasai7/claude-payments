# P4 — Multi-currency at quote/transfer time (partner-gated, dormant)

**Status:** design approved 2026-05-28. Awaiting spec review → implementation plan.

**Sub-project:** Platform-4 of the SendHome platform reshape (see memory `sendhome-platform-reshape`). Follows P1 (country/currency data model), P2 (partner entity), P3 (per-partner sub-admin auth, PR #10).

---

## Goal

Build the complete capability for the WhatsApp bot to quote and create transfers in a **send currency other than USD** (AED / GBP / CAD / SGD / AUD / NZD), gated on per-partner configuration. Ship it **dormant**: every partner today operates in `['US']` only, so live customer behavior is byte-for-byte unchanged. When a real multi-country partner is onboarded, an admin enables it with **configuration only** (checking a country box on the partner) — no code change, no redeploy logic.

## The dormancy invariant (the thing every task protects)

> A partner whose allowed send-currency set resolves to a single currency behaves **exactly as today**: the bot never asks for currency, all amounts are USD, and every existing test stays green. The "USD-source regression" test suite is the executable proof of this invariant.

This mirrors how P1 and P2 shipped: working infrastructure, zero live customer-facing change by default.

## Locked design decisions (from the 2026-05-28 brainstorm)

1. **Currency is collected per transfer** (not stored once on the customer), but only *asked* when the partner supports more than one send currency.
2. **Limits stay in USD** via USD-equivalent accounting. The $500/day cap, per-transfer min/max ($10–$2,999), velocity counters, and compliance amount thresholds are all evaluated against the **USD-equivalent** of the source amount. Per-currency cap/fee calibration is explicitly deferred to a future partner-driven configuration (P5-adjacent).
3. **Full engine, partner-gated, dormant.** Build end-to-end (bot conversation included) but gate on partner config; default everything to USD-only.
4. **Config surface = the existing `Partner.countries` field.** Allowed send currencies are derived from `countries` (minus payout-side `IN`) via `DEFAULT_CURRENCY_FOR_COUNTRY`. No new schema, no new admin screen — the partner CRUD country checkboxes already exist.
5. **Fees: keep the default.** Fees are computed in USD exactly as today, then converted to the source currency for display (e.g. `$1.99 → ~£1.57`). Per-country round-number fee tables are deferred (partner-interest-driven, future).
6. **Dashboard always shows the source currency**, including for USD transfers. The currency is visible on every row regardless of whether it is USD or another currency.

---

## Architecture

```
Customer "send £200" (WhatsApp)
        │
        ▼
  agent.ts ── looks up customer → partner → allowedSendCurrencies(partner)
        │        • 1 currency  → inject nothing; prompt stays USD-only (today)
        │        • >1 currency → inject "[SEND CURRENCIES: ...]" note; bot asks
        ▼
  tools.ts (get_quote / send_approve_picker / create_transfer / create_schedule)
        │   resolveSendCurrency(partner, args.source_currency)  ← server-side chokepoint
        ▼
  rate.ts  getFxRates(source) → { toInr, toUsd }   (one Frankfurter call)
        ▼
  fx.ts    quote(amountSource, sourceCurrency, toInr, toUsd, fundingMethod, n)
        │     • amountUsd  = round(amountSource × toUsd)  → caps / min-max / fee / compliance
        │     • amountInr  = round(amountSource × toInr)  → shown to customer
        │     • feeUsd     = today's tier;  feeSource = feeUsd / toUsd
        ▼
  Transfer { amountSource, sourceCurrency, feeSource, totalChargeSource,   ← presentation
             amountUsd, feeUsd, totalChargeUsd, fxRate, amountInr, ... }    ← USD-equiv canonical
```

For a USD-source transfer, `toUsd = 1` and every `*Source` field equals its `*Usd` counterpart — the data and the math collapse to today's exactly.

---

## Components

### 1. FX engine — `src/lib/rate.ts`

Replace the single USD→INR fetch with a per-source-currency fetch returning both rates needed downstream.

```ts
export interface FxRates {
  toInr: number;   // 1 unit of source currency → INR  (shown to the customer)
  toUsd: number;   // 1 unit of source currency → USD  (for USD-equivalent accounting)
}

// USD source short-circuits toUsd=1 and fetches only USD→INR (today's call).
export async function getFxRates(source: CurrencyCode): Promise<FxRates>;
```

- Single Frankfurter call: `https://api.frankfurter.app/latest?from=<source>&to=USD,INR` (Frankfurter supports multiple `to` currencies). For `source === 'USD'`: `from=USD&to=INR`, `toUsd = 1`.
- Cache keyed **per source currency** (the current single-slot cache becomes a `Map<CurrencyCode, {rates, fetchedAt}>`, same 1h TTL).
- Replace `FALLBACK_FX_RATE = 85` with a **per-currency fallback table** (`FALLBACK_FX_RATES: Record<CurrencyCode, FxRates>`). On fetch failure, return cached-if-present else the table entry.
- Keep a thin back-compat `getFxRate(): Promise<number>` returning USD→INR (or migrate all callers; the plan will choose). Tests must continue to be able to reset the cache (`resetRateCacheForTests`).

### 2. Currency resolution — `src/lib/partner-currency.ts` (new)

The single server-side authority for "what currency is this transfer in." Treats the LLM-supplied currency as untrusted input (per the CLAUDE.md server-action security checklist).

```ts
// Allowed send currencies = the partner's operating countries minus payout-side IN,
// mapped to home currency, de-duplicated, stable order. ['US'] → ['USD'].
export function allowedSendCurrencies(partner: Partner): CurrencyCode[];

// Resolve the effective currency for a transfer:
//  • exactly 1 allowed → return it, IGNORING any requested value (dormant path).
//  • >1 allowed + requested ∈ allowed → return requested.
//  • >1 allowed + requested missing/invalid → throw a friendly error the bot relays.
export function resolveSendCurrency(
  partner: Partner,
  requested?: string,
): CurrencyCode;

// Reverse map a currency to its source country (for Transfer.sourceCountry).
export function countryForCurrency(c: CurrencyCode): CountryCode;
```

### 3. Quote + types — `src/lib/fx.ts`, `src/lib/types.ts`

`quote()` becomes source-currency aware while preserving USD-equivalent accounting:

```ts
export function quote(
  amountSource: number,
  sourceCurrency: CurrencyCode,
  rates: FxRates,
  fundingMethod: FundingMethod,
  transferCount: number,
): Quote;
```

Math:
- `amountUsd = round2(amountSource × rates.toUsd)` — drives `MIN_USD`/`MAX_USD`, the fee tier, caps, and compliance.
- `MIN_USD`/`MAX_USD` checks run against `amountUsd` (so "$10–$2,999" stays a USD band).
- `feeUsd` = today's tier logic (first transfer free; bank $1.99 / debit $2.99 / credit $2.99 + 3%·amountUsd).
- `feeSource = round2(feeUsd / rates.toUsd)`; `totalChargeSource = round2(amountSource + feeSource)`.
- `amountInr = round(amountSource × rates.toInr)`.
- `fxRate` on the Quote = `rates.toInr` (the source→INR rate; for USD this is USD→INR as today).

Type additions (all backwards-compatible; USD transfers collapse to identical values):

```ts
interface Quote {
  // existing: amountUsd, feeUsd, totalChargeUsd, fxRate, amountInr, deliveryEstimate
  sourceCurrency: CurrencyCode;   // NEW (P4)
  amountSource: number;           // NEW (P4)
  feeSource: number;              // NEW (P4)
  totalChargeSource: number;      // NEW (P4)
}

interface Transfer {
  // existing incl. sourceCurrency (P1), partnerId (P2)
  amountSource: number;           // NEW (P4)
  feeSource: number;              // NEW (P4)
  totalChargeSource: number;      // NEW (P4)
}

interface Draft {
  // existing
  sourceCurrency: CurrencyCode;   // NEW (P4)
  amountSource: number;           // NEW (P4)
}

interface Schedule {
  // existing incl. partnerId (P3)
  sourceCurrency: CurrencyCode;   // NEW (P4)
  amountSource: number;           // NEW (P4)
}
```

### 4. Transfer creation — `src/lib/transfer-create.ts`

```ts
interface CreateTransferInput {
  phone: string;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  amountSource: number;          // CHANGED (P4): was amountUsd
  sourceCurrency: CurrencyCode;  // NEW (P4)
  partnerId: PartnerId;          // NEW (P4): from the owning customer (like P3 schedules), not DEFAULT_PARTNER_ID
}
```

- Look up `FxRates` for `sourceCurrency`, call `quote()`, populate **both** the `*Source` presentation fields and the `*Usd` canonical fields.
- `sourceCountry = countryForCurrency(sourceCurrency)`; `sourceCurrency` as resolved; destination stays `IN`/`INR`.
- `partnerId` from the owning customer (replaces the hardcoded `DEFAULT_PARTNER_ID` placeholder the P1/P2 comment flagged).
- Compliance & velocity continue to receive the **USD-equivalent** amount.

### 5. Bot tools — `src/lib/tools.ts`

- `get_quote`, `send_approve_picker`, `create_transfer`, `create_schedule` gain an **optional** `source_currency` string parameter.
- Each handler: look up `customer → partner`, call `resolveSendCurrency(partner, args.source_currency)`. The resolved currency (never the raw LLM value) flows into `quote()` / `createTransfer()`.
- All cap/limit checks (`evaluateCap`, `check_send_limit`, `dailyVolumeStore`) feed the **USD-equivalent** amount, unchanged.
- The approve-picker summary shows the source amount + currency and the INR (e.g. `Sending £200.00 to Asha. Fee £1.57 → ₹21,300.`). For USD it reads exactly as today.
- The legacy/cron `create_transfer` path uses the **schedule's stored** `sourceCurrency` + `amountSource` + `partnerId` (schedules are backfilled to `'USD'` / their USD amount / the owning customer's partner). No re-derivation at fire time.

### 6. Agent & prompt — `src/lib/agent.ts`, `src/lib/prompt.ts`

- In `agent.ts`, after resolving the customer's partner, compute `allowedSendCurrencies(partner)`. If `length > 1`, inject a per-turn system note:
  `[SEND CURRENCIES: USD, GBP — ask the user which currency they are sending, then quote in that currency.]`
  If `length === 1`, inject **nothing** → the prompt behaves exactly as today.
- `prompt.ts`: the base `SYSTEM_PROMPT` stays USD-worded. Add a short conditional CURRENCY block that only takes effect when the injected note is present (the model already follows injected `[...]` system notes for `[NEW CUSTOMER]` / `[TIER_REMINDER]`). Caps remain worded "$500/day" (genuinely a USD cap under USD-equivalent accounting).
- `bot-content-guard` (P2): currency names are not "partner," so the guard is unaffected — but add a guard test asserting injected currency notes never leak the word "partner."

### 7. Migration — sentinel + lazy-fill (locked pattern)

New cron-claimed sentinel `transfer-source-amount-backfill-v1`:
- For every existing transfer: set `amountSource = amountUsd`, `feeSource = feeUsd`, `totalChargeSource = totalChargeUsd` (its `sourceCurrency` is already `'USD'` from P1's backfill).
- For every existing schedule: set `sourceCurrency = 'USD'`, `amountSource = amountUsd`.
- **Lazy-fill on read** in `store.getTransfer` / `scheduleStore.getSchedule` for the new fields (read-only fill; the cron pass is the only writer), matching P1/P2/P3.
- Wire into the cron sentinel chain after the existing P1/P2/P3 backfills.

### 8. Dashboard — always show source currency

- Transactions table: render the amount **with its currency** on every row (e.g. `£200.00` / `$254.00`), and show the USD-equivalent alongside when the source currency isn't USD (e.g. `£200.00 (≈ $254.00)`). For USD rows the currency is shown explicitly too (per the locked decision).
- Use `Intl.NumberFormat` with the row's `sourceCurrency` for correct symbols. Keep the change scoped to display; no new filters in P4.

---

## Security notes

- **Currency is untrusted LLM input.** `resolveSendCurrency` is the only place a transfer's currency is decided; it validates against the partner's allowed set and ignores the LLM value entirely on the single-currency (dormant) path. This follows the server-action security checklist added to CLAUDE.md during the P3 wrap.
- A partner-scoped customer can never produce a transfer in a currency outside `allowedSendCurrencies(partner)`.

## Testing strategy

- **FX:** multi-currency fetch shape; per-currency cache isolation; per-currency fallback table on fetch failure; USD short-circuit (`toUsd === 1`).
- **resolveSendCurrency:** single-allowed ignores a requested override; multi-allowed accepts a valid request; multi-allowed rejects an invalid/missing request; `allowedSendCurrencies(['US']) === ['USD']`.
- **quote():** non-USD math (amountUsd / feeSource / amountInr); min/max enforced on USD-equivalent; **USD-source regression** producing values identical to pre-P4.
- **transfer-create:** both field sets populated; partnerId from owning customer; compliance receives USD-equivalent.
- **Migration:** backfill sets the three fields; lazy-fill on read for un-backfilled records; idempotent under the sentinel.
- **Bot/agent:** dormant (single-currency) partner → no currency note injected, USD flow unchanged; multi-currency partner → note injected and a non-USD transfer round-trips.
- **Dashboard:** currency rendered for USD and non-USD rows.
- **Full existing suite stays green** — the dormancy proof.

## Out of scope (deferred)

- Per-currency / per-country **cap & fee tables** (partner-interest-driven; needs more context — future config).
- Per-corridor compliance rules (**P5**).
- Payout countries beyond India (`IN` remains the only destination in v1).
- Real FX hedging / rate-lock economics.
- Storing the send currency on the customer profile (we collect per transfer).

## Sequencing note

P4 touches `types.ts`, `tools.ts`, and `transfer-create.ts`, which P3 (PR #10) also modified. Execute P4 **after P3 merges to `main`**, branching/rebasing P4 onto the updated `main` to avoid conflicts. The spec and plan can be written now; implementation waits on the P3 merge.
