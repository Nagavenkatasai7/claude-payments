# Cross-border B2B invoicing over WhatsApp — design spec

**Date:** 2026-06-30
**Status:** Approved design → ready for implementation plan (Phase 1)
**Author:** Claude (brainstormed with the project owner)

## Summary

Today SmartRemit does two things: international **P2P** remittance (e.g. US→India) and
**US-domestic B2B bills** (a US buyer pays a US seller's invoice over WhatsApp via
US-ACH-pull). This feature adds **cross-border B2B invoicing**:

> A **registered seller** in any supported country creates a bill **denominated in their
> own currency** (e.g. 1,000 HKD). The bill is delivered to a **buyer** in another country
> who pays the **FX-converted equivalent in their currency** (e.g. ≈ $128.50 USD), with
> **fees charged on top of the buyer's payment**. The **seller receives their full stated
> amount** (1,000 HKD) via the **partner rail**. SmartRemit never holds the funds.

Existing P2P remittance keeps working unchanged; this is added alongside it.

## Locked decisions (from brainstorming)

1. **Denomination & receipt.** Bill is in the **seller's currency**; the seller receives
   that **exact amount**; the buyer pays the converted equivalent.
2. **Fees.** **Buyer pays fees + FX margin on top.** Seller nets their full stated amount.
3. **Corridors.** **Any-to-any** among the supported currency set. Phase 1 = the existing
   8 currencies **+ HKD** (9 total).
4. **Seller model.** **Registered sellers only**: a business **onboards once** (verified
   payout destination + sanctions screening; KYC delegatable), then bills freely. Payout
   **always** flows through the partner rail (non-custodial).
5. **Buyer payment.** Buyer pays via **local bank details** on a **hosted pay link**.
6. **Delivery.** **Secure pay link always** (works for any buyer, any channel) **+ WhatsApp
   push when the buyer is reachable** (24h session today; approved template in Phase 2).
7. **Staging.** **Phased.** Phase 1 = core end-to-end via the **WhatsApp seller-initiated**
   creation flow. Phase 2 = proactive push template + admin creation UI + more currencies.

## Current state & the gap (from architecture recon)

- **Invoice currency is cosmetic.** `b2b_invoices` has a `currency` column
  (`src/db/schema.ts:147`) and `B2bInvoice.currency` (`src/lib/types.ts:113`), but the admin
  seeder hardcodes `'USD'`, line items are `unitAmountUsd` (`src/lib/types.ts:104`), and the
  FX engine derives source currency from the buyer's phone, never from the invoice. An
  HKD-denominated bill cannot be expressed today.
- **No seller identity/payout on the invoice.** `b2b_invoices.businessName` is a plaintext
  display label only — no `sellerId`, seller country/currency, or payout destination. The
  system can't route the buyer's payment to the seller's bank without collecting it ad-hoc.
- **`ach_pull` is US-only.** `AchDebitPayForm` collects a 9-digit US routing number
  (`src/app/pay/[transferId]/pay-form.tsx:532-557`); `FundingMethod` (`src/lib/types.ts:6`)
  has no international buyer bank-debit path.
- **HK/HKD absent from the type system.** Closed unions of 8 (`src/lib/types.ts:463,468`);
  `CALLING_CODE_TO_COUNTRY` has no `+852`; `BANK_FIELDS_BY_COUNTRY` no `HK`; `FALLBACK_FX_RATES`
  no `HKD`. **Frankfurter already serves HKD live** once the types include it.
- **Creation is admin-only (demo seed).** `seedDemoInvoiceAction`
  (`src/app/admin-dashboard/b2b/actions.ts:44`) is the only write path; no seller-facing
  creation tool/API exists.
- **Proactive delivery is blocked by Meta's 24h window** and there is no approved "new
  invoice" template; the bot can only `present_bill` reactively.

What we reuse as-is: the corridor/FX engine (`src/lib/fx.ts` `quote()` + `sourceForDest()`,
USD-pivot cross-rates), live FX (`src/lib/rate.ts`, Frankfurter + Redis L2), the hosted pay
page + per-country `BANK_FIELDS_BY_COUNTRY` (`src/lib/payout-format.ts`), OTP step-up, the
non-custodial settlement loop (`beginSettlement` → `settlement.instruct` → partner-rail →
`/api/payment-webhook` → delivered), encrypted field storage (`field-crypto`), the durable
outbox, and the B2B lifecycle (cancel/dispute/void/reissue/**reverse**) already shipped.

## Non-goals (Phase 2 and beyond)

- Proactive WhatsApp **"new invoice" template** (needs Meta approval) — Phase 1 pushes only
  within the 24h window; the link is the guaranteed channel.
- Full **admin** cross-border creation UI (Phase 1 keeps the existing admin demo seeder;
  the new creation surface in Phase 1 is the WhatsApp seller flow).
- Currencies **beyond the 9**; **card** payment for buyers; **configurable** fee-bearer.

## Phase 1 design

### A. Currency unlock — add HK/HKD (the prerequisite)

Extend the closed unions + every dependent map so HKD is a first-class corridor:
`CountryCode`/`CurrencyCode` (`src/lib/types.ts:463,468`), `DEFAULT_CURRENCY_FOR_COUNTRY`,
`FALLBACK_FX_RATES` (`src/lib/rate.ts`), `CALLING_CODE_TO_COUNTRY` `+852→HK`
(`src/lib/partner-currency.ts`), `BANK_FIELDS_BY_COUNTRY` HK schema (bank code + branch code +
account number; FPS optional later), and partner-country defaults. Pure, TDD'd.

### B. Registered-seller profile + onboarding

**Data:** a new `sellers` table, partner-scoped (tenant isolation), phone-keyed (the seller's
WhatsApp `wa_id`, digits-only). Fields: `id`, `partnerId`, `phone`, `businessName` (plaintext —
shown to buyers on the bill), `country`, `currency`, `payoutDestinationEnc` + `payoutLast4`
(encrypted via `field-crypto`, composed from per-country `BANK_FIELDS_BY_COUNTRY`),
`sanctionsStatus`, `kycReviewState` (reuse the KYC state machine; delegatable), timestamps.

**Onboarding = WhatsApp-start, web-finish.** The seller texts "register as a seller"; the bot
collects business basics in chat, then hands off a **secure onboarding link** (same hosted-form
+ OTP pattern as the pay page) to capture the **payout destination** and **KYC** off-chat.
Sanctions screening runs structurally (untoggleable). A seller may not issue bills until the
profile is **active** (payout set + sanctions clear).

### C. Cross-border invoice model

Extend `b2b_invoices`: add `sellerId` (FK → `sellers`), and treat the **seller-currency amount
as the fixed obligation** — `invoicedAmount` + `invoicedCurrency` (the seller's currency). Line
items carry unit amounts **in the invoice's currency** (generalize `unitAmountUsd`). The
existing `amountUsd`/`currency` columns remain for back-compat US-domestic bills; cross-border
bills set `invoicedCurrency ≠ USD`. **No FX is locked at creation** — the obligation is in the
seller's currency. Migration is additive (drizzle).

### D. FX — quoted live at payment, not at creation

When the buyer opens the link, the system computes the buyer's pay amount from the seller's
fixed obligation using the **inverse quote** (`sourceForDest()` — given the destination amount
in the seller currency, solve for the source amount in the buyer currency), then adds the **FX
margin + platform fee on top** (buyer-bears). The quote is **locked for a short TTL** at
checkout (same pattern as remittance quotes); on expiry it re-quotes. This guarantees the seller
nets exactly their stated amount regardless of rate drift. The transfer row records the locked
rate + both amounts at pay time.

### E. Money flow (non-custodial, cross-border)

1. Buyer opens the pay link → page shows *"Bill from [Seller] — 1,000 HKD ≈ $128.50 (incl.
   fees)"* on a live-locked quote.
2. Buyer enters **their country's local bank details** (per-country schema) + **OTP**.
3. A B2B cross-border transfer is **minted** (claim-first idempotency, as today):
   `transferType='b2b'`, `sourceCurrency=buyerCurrency`, `amountSource`=buyer total,
   `destinationCurrency=sellerCurrency`, destination amount = `invoicedAmount`, recipient =
   seller (business name + **payout destination from the seller profile**, not from the buyer),
   `invoiceId` bound.
4. `beginSettlement` posts ONE **signed** instruction to the partner rail carrying **both legs**:
   debit the buyer's local bank for `amountSource`, convert, and pay out `invoicedAmount` to the
   seller's payout destination. **The partner does the debit AND the payout; SmartRemit never
   holds funds.** This generalizes `ach_pull` to a **country-aware buyer bank-debit** funding
   path.
5. Partner callback → `/api/payment-webhook` → invoice marked **paid** → both parties notified
   (Stage-2 WhatsApp). **Sanctions-screen both seller and buyer** before settlement.

### F. Creation — WhatsApp seller-initiated (`create_invoice` tool)

A new agent tool, available only to an **active onboarded seller** (resolved by `ctx.phone`):
the seller texts *"bill +1‑555‑… for 1,000 HKD for design work"* → the bot validates the seller
profile + buyer number, creates the invoice (obligation in the seller's currency), returns the
**secure pay link**, and **pushes it to the buyer's WhatsApp if reachable** (24h window now).

### G. Delivery

Every invoice mints a secure pay link (`/pay/...`, reusing `generate_payment_link`). The bot
hands it to the seller AND attempts a WhatsApp push to the buyer; the approved-template push for
buyers outside the 24h window is **Phase 2**.

### H. Lifecycle reuse

The shipped B2B lifecycle (cancel / dispute / void / reissue / **reverse**) already governs B2B
invoices; cross-border bills inherit it. The non-custodial **reverse** instruction simply crosses
currencies (partner returns the buyer's debit). No new lifecycle code in Phase 1 beyond verifying
the cross-currency reverse instruction shape.

## Data model changes (additive migrations)

- **`sellers`** (new): `id`, `partnerId`, `phone`, `businessName`, `country`, `currency`,
  `payoutDestinationEnc`, `payoutLast4`, `sanctionsStatus`, `kycReviewState`, `createdAt`,
  `updatedAt`. Indexes: `(partnerId, phone)` unique, `(partnerId, createdAt)`.
- **`b2b_invoices`** (extend): add `sellerId` (FK), `invoicedAmount` (numeric), `invoicedCurrency`
  (text). Generalize line-item unit amounts to the invoice currency.
- **`transfers`**: no new **columns** — `sourceCurrency`/`amountSource`/`destinationCurrency`
  already exist from the any-to-any work. Phase 1 **does** add one new `FundingMethod` value: a
  country-aware buyer bank-debit (`bank_pull`) that generalizes the US-only `ach_pull` so a buyer
  in any of the 9 corridors can be debited by the partner rail.

## Units of work (for the implementation plan — Phase 1)

1. **Currency expansion (HKD)** — types/maps/bank-fields/fallbacks/calling-codes. Pure, TDD'd.
2. **`sellers` table + repo** — schema + migration + partner-scoped repo (encrypted payout). PGlite tests.
3. **Seller onboarding** — WhatsApp-start tool + hosted web onboarding form (payout + KYC + sanctions).
4. **Cross-border invoice model** — extend `b2b_invoices` + repo + migration.
5. **Inverse quote at payment** — `sourceForDest` + buyer-bears fees + quote-lock TTL. Pure, TDD'd.
6. **Buyer cross-border pay path** — pay page shows converted amount + local bank fields + OTP;
   country-aware buyer bank-debit funding method.
7. **Non-custodial cross-border settlement instruction** — extend `settlement.instruct`/partner-rail
   to carry the buyer's local-bank funding leg + the cross-currency payout to the seller profile.
8. **`create_invoice` WhatsApp tool** — onboarded seller creates a bill → pay link → push-if-reachable.
9. **Delivery wiring** — mint link; push to buyer WA within the 24h window; reuse the durable outbox.

## Invariants to preserve (non-negotiable)

- **Non-custodial.** The partner rail performs the buyer debit AND the seller payout; SmartRemit
  never holds, captures, or nets funds. No code path where money rests with SmartRemit.
- **Sanctions screening always runs** — on **both** the seller (at onboarding + at settlement) and
  the buyer (at settlement). Structurally untoggleable.
- **Encryption at rest** — seller payout destinations and any PII are envelope-encrypted; reads are
  masked by default; staff reveals are audited.
- **Tenant isolation** — every seller/invoice/transfer query carries `partnerId`; the WhatsApp
  `create_invoice` tool is `ctx.phone`-owned and cannot bill on another seller's behalf.
- **Claim-first idempotent mint** + durable transactional outbox for every external effect.
- **OTP step-up** on the buyer's payment, as today.

## Error handling & edge cases

- **Rate drift** between quote and payment → quote-lock TTL; re-quote on expiry; the seller's
  obligation is fixed in their currency so they're never short-changed.
- **Seller not fully onboarded** (no payout / sanctions pending) → `create_invoice` refuses with a
  clear "finish onboarding" message.
- **Buyer country unsupported** (outside the 9) → pay page declines that buyer with a clear reason.
- **Sanctions hit** on seller or buyer → block (no settlement), route to review, never silently pass.
- **Partial/failed payout** → existing reconcile sweep (stuck-paid re-instruct) + the reverse seam.
- **Idempotency** — invoice→transfer mint is claim-first; a double-tap pay can't double-charge.

## Testing strategy

- **Pure helpers TDD'd**: currency maps + HK additions; the inverse quote (seller-amount-fixed →
  buyer-amount + fees); fee-on-buyer math; quote-lock expiry.
- **Repo/tx PGlite suites**: `sellers` CRUD + tenant scoping; cross-border invoice create/read;
  claim-first mint.
- **Settlement instruction shape**: a cross-currency B2B instruction posts a **signed** dual-leg
  instruction (buyer debit + seller payout) and performs **no SmartRemit capture**; b2c path
  byte-unchanged.
- **Compliance**: sanctions screen invoked for both parties; blocked on a hit.
- **Post-deploy Playwright smoke**: the cross-border pay page renders the converted amount + the
  buyer's local bank fields (UI not unit-tested per repo convention).

## Open risks

- **Partner-rail capability**: the reference/simulator rail must accept a dual-leg cross-currency
  instruction (buyer local-bank debit + seller payout). The hosted reference rail
  (`/api/partner-rail`) needs extending to simulate this; a real partner must support it.
- **HK bank-field schema** correctness (bank code + branch + account) — validate against a real HK
  format before widening beyond the demo.
- **KYC for sellers** in new jurisdictions — delegatable, but the onboarding UX must make the
  delegation explicit.

## Phase 2 roadmap (not in this build)

Approved Meta **"new invoice" template** for proactive buyer delivery outside the 24h window · full
**admin** cross-border bill creation UI · currencies **beyond the 9** · **card** payment for buyers ·
**configurable** fee-bearer (buyer vs seller) · seller dashboard for issued bills.
