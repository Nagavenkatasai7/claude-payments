# Any-to-Any, Bank-to-Bank Corridors (demo) — Design

**Status:** approved direction (user 2026-05-30). Branch `feat/any-to-any-corridors` off `main` (aa98f72). Grounded by a 6-area code sweep.

**Goal:** SendHome stops being US→India only. It becomes **any-of-8 → any-of-8** (US, CA, GB, AE, SG, AU, NZ, IN), **both directions**, **bank-to-bank only**, in the demo. Source currency is auto-detected from the sender's phone; destination is the country the user picks; the quote shows the real cross-currency pair (e.g. India→Dubai = INR→AED). Mock payment stays.

## Approved decisions
1. All 8 countries are valid destinations (and sources). Unknown country → keep the lightweight request-lead capture.
2. **Bank-to-bank only.** Funding is ALWAYS bank transfer — the bot never asks "how do you want to pay", and never offers cards. Payout is ALWAYS the recipient's **bank account**, asked in the **destination country's format**.
3. FX: live where available, built-in fallback; cross-rate via USD pivot.
4. Keep the current one-tap "Approve & Pay" mock pay flow, generalized.

## Architecture — LOW-CHURN (demo-pragmatic)
The persisted field `Transfer.amountInr` / `Quote.amountInr` is **retained as the field name but now means "amount in the destination currency"** (= INR for India sends, the common case). We add `destinationCurrency` to `Quote` (`Transfer` already has it) and **generalize the display + FX**, instead of renaming `amountInr`→`amountDest` across ~30 sites + every test. India sends remain byte-for-byte (dest=INR → ₹); non-India is additive. (Field rename = noted fast-follow.)

### FX — `fx.ts` / `rate.ts`
- `getFxRates(currency)` unchanged → `{ toInr, toUsd }`.
- `quote()` gains `destinationCurrency: CurrencyCode` + the destination's USD rate. Cross rate:
  `crossRate = destinationCurrency === 'INR' ? srcRates.toInr : round(srcRates.toUsd / destToUsd, …)`.
  `amountInr` (= destination amount) `= Math.round(amountSource * crossRate)`; `fxRate = crossRate`. `amountUsd = round2(amountSource * srcRates.toUsd)` **unchanged** (caps stay USD-equiv). `Quote.destinationCurrency` added. For `destinationCurrency==='INR'` the math is **identical to today** (regression-safe).
- The caller (tools/transfer-create) fetches both `srcRates = getFxRates(source)` and `destRates = getFxRates(dest)` and passes `destRates.toUsd`.

### Tools — `tools.ts`
- `get_quote` / `send_approve_picker` / `create_transfer` gain an optional `destination_country` (default `'IN'` for back-compat). The dest currency = `DEFAULT_CURRENCY_FOR_COUNTRY[destination_country]`.
- `get_quote` response exposes `amount_dest` + `destination_currency` (clear for the LLM) alongside the existing fields.
- `buildApproveSummary` formats the destination amount with `Intl.NumberFormat(destinationCurrency)` (gives ₹/£/AED/etc.) — replaces the hardcoded `₹` `inr()`. Shows "They get <dest amount> within 10 minutes" + "To: bank account ****NNNN (<country>)".
- `maskDestination`: drop the India-`IFSC` hardcode → generic "bank account ****NNNN" (+ remaining tokens) for all countries; UPI branch retained for legacy reads only (bot never creates UPI).
- Funding: default `funding_method` to `'bank_transfer'` when omitted; the bot never sends cards.
- The `capture_corridor_request` tool stays for countries outside the 8.

### Transfer — `transfer-create.ts`
- `CreateTransferInput` gains `destinationCountry` + `destinationCurrency` (default IN/INR if absent). `createTransfer` uses them instead of `DEFAULT_DESTINATION_*`; `quote()` called with the dest currency; `screenTransfer` corridor = source→dest (rules stay GLOBAL_DEFAULTS for the demo).

### Prompt — `prompt.ts`
- Reframe: send between 8 countries, both ways, bank-to-bank.
- Remove the funding-method question entirely (always bank transfer).
- When the user wants to send: collect amount; **ask the destination country** (and list all 8 when asked "where can I send?"); recipient name + number; then the recipient's **bank details in the destination country's format**:
  US routing+acct · IN acct+IFSC · GB sort code+acct · AE IBAN · CA transit+institution+acct · SG bank code+acct · AU BSB+acct · NZ acct(bank-branch-account-suffix).
- No UPI, no "India only", no cards. Keep one-tap Approve & Pay + cancel-by-text.

### Display — `payment.ts`, `recent-transfers.ts`, pay page
- Format amounts with the **destination currency** (`Intl.NumberFormat`), not hardcoded `₹`. Stage messages say "via bank transfer" (no UPI/card). Pay page shows the destination amount in its currency.

### Dashboard
- Show each transfer's **direction** (sourceCountry → destinationCountry) + the destination amount in its currency (reuse `format.ts money()`), both ways.

### Back-compat (lazy-fill, established pattern)
- `getTransfer` lazy-fills `destinationCurrency ?? 'INR'`; `amountInr` already present on old records. No data migration needed; old US→IN transfers render identically.

## The invariant
> Caps/screening stay **USD-equivalent** (`amountUsd` unchanged). For `destinationCurrency === 'INR'`, `quote()` output is **byte-for-byte identical to today** → all existing US→India tests pass unchanged. New behavior is additive (other destinations). Mock payment only; no real money/partners. `bot-content-guard` green.

## Tasks
1. **fx cross-currency**: `quote(destinationCurrency, destToUsd)` + `Quote.destinationCurrency` + cross-rate; INR path unchanged. Tests (USD→INR regression + USD→AED + INR→AED).
2. **rate helper**: ensure `getFxRates(dest)` works for all 8 (FALLBACK has them); a `crossRate` helper if useful. Tests.
3. **tools**: `destination_country` param + dest resolution in `resolveCurrencyAndRates` + `get_quote` returns amount_dest/destination_currency + `buildApproveSummary` currency-aware + `maskDestination` generic + funding defaults bank. Tests.
4. **transfer-create**: destination from input; quote with dest currency; corridor source→dest. Tests.
5. **prompt**: any-to-any bank-to-bank rewrite (destination country, per-country bank format, no funding question, list countries). Tests.
6. **display**: payment.ts + recent-transfers + pay page currency-aware. Tests.
7. **dashboard**: direction + dest currency. (server components — typecheck/build.)
8. **wrap**: full gate + final review + deploy + live verify.

## Risks
- Test churn on customer-facing strings (mostly India sends still ₹ → minimal); non-India adds new assertions.
- Cross-rate accuracy via USD pivot (fine for demo; AED via fallback).
- Per-country bank-detail validation is NOT enforced (free text) — acceptable for a demo; noted.
