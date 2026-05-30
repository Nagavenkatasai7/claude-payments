# Multi-Country Send — US + UAE + UK (Batch 2) — Design

**Status:** design approved (Q&A 2026-05-29). **Stacks on Batch 1** (`spec/wa-pay-cta-button`); branch `spec/wa-multicountry`. Merge order: Batch 1 first, then Batch 2.

**Goal:** make sending in **USD / AED / GBP** real and live. Today the default partner is US-only, so the bot only sends USD even though P4's multi-currency engine is built and dormant. Enable it for everyone, non-disruptively.

## Approved decisions
1. **Countries:** US + UAE + UK (USD/AED/GBP) on the **default partner** via a one-time **migration** (auto-live on deploy).
2. **Currency = auto-detect from the sender's phone country code, with spoken override.** `+1→USD`, `+971→AED`, `+44→GBP`; the customer can override ("send in AED"). Existing US (+1) numbers stay USD silently.
3. **FX:** live where available (GBP via Frankfurter), **built-in fallback** for AED (`{toInr:23.1}` already in `FALLBACK_FX_RATES`).

## The invariant
> **Caps, screening, and the USD-equivalent accounting are unchanged.** All caps/EDD still evaluate on `amountUsd` (source→USD via `rates.toUsd`), exactly as today. The change is purely *which send currency is offered/defaulted*: the default partner's `countries` gains `AE`, `GB` (additive migration, union, idempotent — never clobbers manual edits), and `resolveSendCurrency` gains a **phone-derived default** for multi-currency partners (it still honors an explicit override and still throws-to-ask only if it can't infer). `FALLBACK_FX_RATES` already contains AED + GBP, so no FX gap. **US senders are unaffected** (a `+1` phone → USD; a single-currency partner ignores the phone hint). `quote()` math, compliance, and the pay flow are untouched. New behavior activates only because the default partner now allows >1 currency.

## Architecture

### 1. `currencyForPhone` — pure helper (`src/lib/partner-currency.ts`)
```
const CALLING_CODE_TO_COUNTRY: Record<string,CountryCode> = { '1':'US','44':'GB','971':'AE','61':'AU','64':'NZ','65':'SG','91':'IN' };
currencyForPhone(normalizedPhone): CurrencyCode | undefined  // greedy 3→2→1 prefix; null on no-match
```
Uses the existing `DEFAULT_CURRENCY_FOR_COUNTRY`. `+1` heuristically → US/USD (NANP ambiguity accepted; KYC `senderCountry` is the authoritative override later).

### 2. `resolveSendCurrency` gains a phone default (`src/lib/partner-currency.ts`)
Signature → `resolveSendCurrency(partner, requested?, senderPhone?)`. Behavior: single-currency → `allowed[0]` (unchanged, ignores phone). Multi-currency → explicit `requested` match wins; else if `currencyForPhone(senderPhone)` ∈ allowed → use it (the new default); else throw the existing "which currency?" `QuoteError`. **Backward compatible** (senderPhone optional). Call site `resolveCurrencyAndRates` (`tools.ts`) passes `ctx.phone`.

### 3. Sender country from phone (`src/lib/customer-store.ts`)
`upsertOnFirstInbound` derives `senderCountry` from the phone (`countryForPhone`) when known, else `DEFAULT_SENDER_COUNTRY ('US')`. Existing customers keep their stored value (no migration). This keeps the compliance corridor honest (a `+971` customer is `AE`→IN). Existing `+1` customers/numbers are unchanged.

### 4. Enable on the default partner — migration (`src/lib/migration.ts` + cron)
`backfillExpandCountriesOnce(store, partnerStore)`: sentinel `expand-countries-ae-gb-v1`; for each partner, `countries = Array.from(new Set([...countries, 'AE','GB']))`; save only if changed (idempotent, additive, preserves manual edits). Register as the 7th backfill in `src/app/api/cron/route.ts`. (Cron runs daily and on demand; `GET /api/cron` after deploy makes it live immediately.)

### 5. Prompt (`src/lib/prompt.ts`) — CURRENCY section
The bot's send currency is **auto-detected** from the customer's number; it should **not** ask which currency by default. If the customer says they want a different currency (e.g. "send in AED"), pass it as `source_currency`. Only ask if a tool returns the "which currency?" error. The approve card already renders the source currency (`buildApproveSummary` shows `1 {sourceCurrency} = ₹X`), so no card change.

## Data model changes
**None requiring a schema migration.** The country expansion is a data migration on the existing `Partner` record (additive). `Customer.senderCountry` derivation affects only new customers.

## Testing (TDD)
- `currencyForPhone`: +1→USD, +971→AED, +44→GBP, +91→INR, unknown→undefined, junk→undefined; greedy prefix (971 before 9) (`tests/partner-currency.test.ts`).
- `resolveSendCurrency`: multi-currency + phone default (no explicit) → phone currency; explicit override wins; phone currency not in allowed → throw; single-currency ignores phone (regression) (`tests/partner-currency.test.ts`).
- `upsertOnFirstInbound`: `+971...` → senderCountry 'AE'; `+1...` → 'US'; unknown → 'US' (`tests/customer-store.test.ts`).
- migration: union adds AE,GB; idempotent (2nd run touches 0); preserves a manually-set country list; sentinel (`tests/migration.test.ts`).
- End-to-end via tools: a multi-currency default partner + a `+971` ctx → `get_quote` quotes in AED (amount_source AED, amount_inr via AED rate), caps still in USD-equiv (`tests/tools.test.ts`).
- `bot-content-guard` green.

## Tasks
1. `currencyForPhone` + tests.
2. `resolveSendCurrency(…, senderPhone?)` phone default + call-site wiring + tests.
3. `upsertOnFirstInbound` senderCountry-from-phone + tests.
4. `backfillExpandCountriesOnce` migration + cron registration + tests.
5. Prompt CURRENCY rewrite (auto-detect + override) + tests.
6. Wrap: bot-content-guard + full gate + final review + PR (hold). Run `GET /api/cron` note for the morning (so the user triggers the migration post-merge, or it runs on the daily cron).

## Risks
- **NANP +1 ambiguity** (US vs CA): accepted; defaults to US; KYC override authoritative later.
- **A currency in `Partner.countries` without a `FALLBACK_FX_RATES` entry would crash `getFxRates`** — N/A here (AED, GBP, USD all present); noted as a guard for future countries.
- **The migration must run in prod** (cron) for the default partner to gain AE/GB — covered by the daily cron; the morning report tells the user to hit `GET /api/cron` once after merge for immediate effect.
