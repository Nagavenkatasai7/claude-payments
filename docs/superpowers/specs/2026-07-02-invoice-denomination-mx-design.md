# Invoice denomination (seller OR buyer currency) + Mexico/MXN corridor — design spec

**Date:** 2026-07-02
**Status:** Approved design → implementation
**Origin:** Live test — a US seller tried "Send Invoice for 1200 MXN" and was (correctly,
per the old design) refused. Owner locked: sellers may denominate in their own OR the
buyer's currency; Mexico/MXN becomes the 10th corridor; build now as one batch.

## Locked decisions

1. **Denomination = seller currency OR buyer currency.** A seller can bill in their own
   currency (today's behavior, unchanged) or in the BUYER's currency ("charge them
   $500" / "bill them 1200 MXN" for a +52 buyer). **Any third currency is refused** with
   a clean message naming the two allowed currencies for that bill.
2. **Mexico / MXN is the 10th corridor** (same expansion pattern as HKD).
3. Buyer-bears fees stays in BOTH models. Non-custodial unchanged. Payout destination
   stays profile-only. Sanctions/tenant/idempotency unchanged.

## The two denomination models

Let `S` = seller currency (from the seller profile), `B` = buyer currency (derived from
the buyer's phone country code).

**Case S — obligation fixed in the SELLER's currency** *(today's model, byte-unchanged)*
- `invoicedCurrency === S`. Seller nets EXACTLY `invoicedAmount`.
- Buyer pays the live-converted equivalent + fee on top (inverse quote; rounding
  remainder absorbed by the platform, never the seller).

**Case B — obligation fixed in the BUYER's currency** *(new)*
- `invoicedCurrency === B`. Buyer pays EXACTLY `invoicedAmount` + fee on top
  (`buyerPrincipal = invoicedAmount`; `feeBuyer` = the same flat B2B fee converted to B;
  `buyerTotal = invoicedAmount + feeBuyer`).
- Seller receives the live-converted equivalent in S at payment time
  (`sellerAmount = round2(invoicedAmount × crossRate(B→S))` from the SAME locked quote
  the buyer authorizes — what-you-see-is-what-you-pay governs both sides).
- The seller-nets-exact guarantee does NOT apply in Case B — the seller chose to fix
  the buyer's price instead. Bot copy must reflect this ("your customer pays exactly
  1200 MXN; you'll receive the converted amount at payment").

**Degenerate case:** S === B (domestic bill) — the two models coincide; treat as Case S.

## No migration needed — denomination is DERIVED

`b2b_invoices.invoicedCurrency` already exists. The pay path derives the model at
quote/mint time:
- `invoicedCurrency === seller.currency` → Case S
- `invoicedCurrency === buyerCurrency` → Case B
- anything else → not payable (defensive `currency_mismatch`; unreachable via the tool,
  which validates at creation).

## Design

### A. Mexico/MXN corridor (mirrors the HKD expansion)
- `CountryCode` + `'MX'`; `CurrencyCode` + `'MXN'`; `DEFAULT_CURRENCY_FOR_COUNTRY.MX = 'MXN'`.
- `FALLBACK_FX_RATES.MXN` ≈ `{ toUsd: 0.054, toInr: 4.6 }` (MXN ≈ 18.5/USD; Frankfurter
  serves MXN live).
- `CALLING_CODE_TO_COUNTRY['52'] = 'MX'` (+52 is unambiguous).
- `BANK_FIELDS_BY_COUNTRY.MX = [{ key: 'clabe', label: 'CLABE', digits: 18, isAccount: true }]`
  (the standard 18-digit Mexican interbank account number).
- `DEFAULT_PARTNER_COUNTRIES` + `'MX'`.
- Corridor copy 9 → **10** everywhere it is enumerated (prompt.ts corridor lists +
  unsupported-destination examples, `capture_corridor_request` description, the
  partner-with-us form + allow-list, and the tests that assert the counts/lists).

### B. `create_invoice` accepts an optional currency
- New optional arg `currency` (ISO code string). Resolution:
  - absent → seller.currency (Case S, today's behavior).
  - equals seller.currency → Case S.
  - equals `currencyForPhone(buyerPhone)` → Case B.
  - anything else → `{ created: false, reply_to_customer }` naming the two allowed
    currencies for THIS bill (e.g. "I can bill in USD (your currency) or MXN (your
    customer's currency)"). If the buyer's calling code is unmapped, only S is allowed.
- The invoice stores `invoicedAmount` + the resolved `invoicedCurrency` (existing
  columns). The USD-equivalent snapshot (`amountUsd`) converts from `invoicedCurrency`
  (today it converts from seller currency — generalize the getFxRates call).
- Bot prompt (SELLER BILLING): "bill <phone> for <amount> [currency]" — pass the
  currency the seller SAID; if refused, relay the two valid options. The seller reply
  copy echoes the billed amount + currency, and for Case B notes the seller receives
  the converted amount.

### C. Quote engine — Case B (pure, TDD)
Extend `src/lib/b2b-quote.ts` (new sibling fn or a mode param — implementer's choice,
keep `quoteCrossBorderBill` Case-S behavior byte-identical):
- Inputs mirror Case S (rates = the BUYER-currency FxRates; sellerToUsd for the pivot).
- Output shape = the SAME `CrossBorderBillQuote` (so the quote-lock store and pay form
  work unchanged): `buyerPrincipal = invoicedAmount` (exact), `feeBuyer`, `buyerTotal`,
  `sellerAmount = round2(invoicedAmount × crossRate(B→S))`, `fxRate` = the displayed
  cross-rate (same orientation as Case S for UI consistency).
- `QuoteError` on non-finite/≤0 amounts or rates (same guards as Case S).

### D. Pay path
- `/pay/b2b/[invoiceId]` page: derive the case (compare currencies), compute + lock the
  right quote. Display for Case B: "Amount due <invoicedAmount B> (exact)" + "Seller
  receives ≈ <sellerAmount S>"; Case S display unchanged.
- `/api/pay/b2b/[invoiceId]` route + `finalizeCrossBorderBillPayment`: the
  currency-mismatch defense becomes case-aware — Case S: locked quote's sellerCurrency/
  sellerAmount must match the invoice (as today); Case B: locked quote's buyerCurrency
  must equal `invoicedCurrency` AND `buyerPrincipal === invoicedAmount`. Ledger mapping
  is IDENTICAL in both cases (amountSource = principal, feeSource, totalChargeSource,
  amountDest = the locked quote's sellerAmount, destinationCurrency = seller.currency,
  fxRate from the quote) — Case B simply feeds different locked numbers in.
- The settlement instruction needs NO shape change: funding leg debits buyerTotal in B;
  payout leg delivers `amount.destination` (the locked sellerAmount) in S.

### E. Out of scope (explicit)
- Third-currency denomination (neither S nor B) — refused by design this round.
- Rate-locking at invoice CREATION (both cases quote live at payment; only the
  fixed-side differs).
- Seller choosing per-invoice payout account/currency (profile-only stands).

## Invariants
- Non-custodial; payout from the encrypted seller profile only; sanctions both parties
  fail-closed; claim-first mint; tenant isolation; OTP; quote-lock
  what-you-see-is-what-you-pay — ALL unchanged.
- Case S remains byte-identical (regression-tested).
- Fees are buyer-borne in both cases and never reduce the fixed side.

## Testing
- Pure: Case-B quote math (buyer exact + fee on top; seller converted; QuoteError
  guards); MX corridor maps (countryForPhone('52…'), CLABE 18-digit validation,
  fallback rate present).
- Tool: `create_invoice` with currency = buyer's (creates Case B invoice), = seller's
  (Case S), = third currency (refused, nothing created), absent (Case S default).
- Pay path (PGlite): Case-B mint — buyer charged exactly invoicedAmount+fee, transfer
  amountDest = locked converted sellerAmount, destinationCurrency = seller currency;
  Case-S path byte-unchanged (existing tests must pass untouched).
- Corridor copy count tests updated (10 countries incl. Mexico).
