# Claims-vs-Code Audit — Morning Report
**Date:** 2026-06-26
**Scope:** SmartRemit public marketing copy, partner docs, and in-product UI claims audited against live source code.

---

## Summary

| Metric | Count |
|---|---|
| Total claims audited | 28 |
| Supported (no qualification needed) | 0 |
| Narrow (true but requires qualification) | 23 |
| Mismatch (claim contradicts code) | 5 |

**Bottom line:** Every claim has at least one qualification. Five claims are direct mismatches — three of them are high-risk for a regulated money-transmitter (a false "licensed partner" trust badge with no code enforcement, a false corridor claim for Canada, and a "flat fee" claim that is wrong for credit card payments). No claim achieved an unqualified "supported" verdict.

---

## HIGH-RISK MISMATCHES

These five claims are contradicted by code today. They carry the most regulatory and consumer-protection exposure.

---

### MISMATCH-1 — `licensed-partner-badge`
**Risk: HIGH** — public trust badge implies a regulatory guarantee the code cannot enforce.

**Claim text (src/app/page.tsx:269):**
> "Licensed-partner settled"

**Code evidence:**
- `isLicensed` and `licenseTypes` are optional free-text fields on the partner application form (`src/app/partners/apply/[token]/partner-application-form.tsx:290-305`). They are **not required** for submission (`actions.ts:67-71`).
- The `partners` DB table (`src/db/schema.ts:32-50`) has **no license field**. The `Partner` type has no license field.
- Partner creation (`src/app/admin-dashboard/partners/actions.ts:377-393`) sets `status: 'active'` with no check on licensing.
- Every runtime guard (`src/lib/partner-api.ts:47-48`, `src/lib/auth.ts:25`, `src/app/api/whatsapp/[partnerId]/route.ts:19`) checks only `partner.status !== 'active'` — never a license field.
- Settlement (`src/lib/settlement.ts`) and provider dispatch (`src/lib/providers/payment-provider.ts:111-129`) route entirely on `providerType`, not partner licensing.

**Suggested fix:** Either (a) add a `licenseVerifiedAt` timestamp and a non-null `licenseJurisdictions` column to the `partners` table and gate `status: 'active'` on it being set, **or** (b) change the badge copy to "Partner settled" and move the licensing claim to a legal footnote describing the operational/contractual requirement, not a structural code guarantee.

---

### MISMATCH-2 — `corridors-send-and-receive` (Canada excluded)
**Risk: HIGH** — Canada is shown as a send corridor but is structurally excluded from the default platform tenant.

**Claim text (landing page corridor display):**
> All 8 countries (US, Canada, UK, UAE, Singapore, Australia, New Zealand, India) can send and receive.

**Code evidence:**
- `src/lib/defaults.ts:18` — `DEFAULT_PARTNER_COUNTRIES` deliberately excludes `'CA'` with the comment: "Canada shares the +1 NANP code with the US, so a Canadian number can't be distinguished from a US one."
- `src/lib/partner-currency.ts:7` — `CALLING_CODE_TO_COUNTRY` maps `'1': 'US'`, so a Canadian +1 number is treated as a US/USD sender.
- The type-level `CountryCode` union includes `'CA'` but the runtime default excludes it.
- The primary corridors API (`src/lib/partner-api-service.ts:131-149`) hardcodes `destination_country: 'IN'` for all 7 corridors, and the any-to-any capability is an aspirational/secondary feature.

**Suggested fix:** Remove Canada from the corridor display on the landing page, or add a footnote explaining that Canadian numbers share the US dialing code and must use a dedicated partner bot. If any-to-any non-India corridors are genuinely supported, add them to the primary `listCorridors()` response rather than relying on a type annotation.

---

### MISMATCH-3 — `about-fee-and-rate` (credit card flat fee)
**Risk: HIGH** — "low flat fee" is false for credit card funding; a $500 transfer costs ~$17.99 vs the implied ~$1.99.

**Claim text (`src/app/about/page.tsx`):**
> "a low flat fee"

**Code evidence:**
- `src/lib/fx.ts:78-80`: `case 'credit_card': feeUsd = round2(2.99 + 0.03 * amountUsd)` — a variable percentage-based fee (base $2.99 + 3% of amount).
- On $500: fee = $17.99. On $1,000: fee = $32.99. This is not a flat fee.
- `bank_transfer` ($1.99) and `debit_card` ($2.99) are flat, but the landing page copy at `page.tsx:437-439` mentions only the bank-transfer fee.
- The rate-lock and no-markup portions are well-enforced and accurate.

**Suggested fix:** Replace "a low flat fee" with "a low fee (from $1.99 for bank transfer; card rates vary)" and link to the full fee schedule. The credit card 3% surcharge must be disclosed before a customer commits to a funding method.

---

### MISMATCH-4 — `about-never-receives-or-holds`
**Risk: HIGH** — present-tense claim that "the partner's rail processes the payment" has no live implementation; the only funding provider in the codebase is a mock.

**Claim text (`src/app/about/page.tsx`, Step 3):**
> "You pay the licensed partner directly... the partner's rail processes the payment"

**Code evidence:**
- `src/lib/providers/funding-provider.ts:83-85` — `getFundingProvider()` unconditionally returns `new MockFundingProvider()`.
- `MockFundingProvider.capture()` (line 53-55) returns `mockfund-<id>` — no real money moves.
- `src/lib/env.ts:117-120` — `get paymentProviderMode()` returns `'mock'` from both branches of its ternary (both branches are literally `'mock'`): no real PSP can be selected.
- The settlement rail (`providerType: 'simulator'`) routes to `/api/partner-rail`, which declares "NON-CUSTODIAL: no funds exist here; this is the integration loop, hosted" (`src/app/api/partner-rail/route.ts:19`). No licensed partner's real rail processes payment.
- The page carries a "demonstration status" disclaimer, but the specific Step 3 copy makes present-tense affirmative claims about real payment rails.

**Suggested fix:** Update Step 3 to make the tense and status explicit: "In production, you would pay through the licensed partner's hosted page; in demo mode, fund movement is simulated." Alternatively, fix `env.ts:117-120` to read a real `PAYMENT_PROVIDER_MODE` env var so a live PSP can be wired in, then update the copy once a live path exists.

---

### MISMATCH-5 — `calculator-fee-schedule`
**Risk: MEDIUM-HIGH** — the rate calculator widget advertises "$1.99" as the post-first-transfer fee with no payment-method caveat.

**Claim text (`src/app/landing/RateCalculator.tsx:86`):**
> "Fee: $0 on your first transfer, then $1.99."

**Code evidence:**
- `src/lib/fx.ts:64-88`: fee schedule is: `transferCount===0` → $0; `bank_transfer`/`ach_pull` → $1.99; `debit_card` → $2.99; `credit_card` → $2.99 + 3% of amount.
- The calculator shows no payment-method selector. A customer who pays by debit card pays $2.99; credit card is $2.99 + 3%.
- The "first transfer free" mechanic (`src/db/repos/transfer-repo.ts:380-386`) is correctly enforced end-to-end.

**Suggested fix:** Add a funding-method selector to `RateCalculator.tsx` and compute the displayed fee dynamically from the `wouldBeFeeUsd()` helper (`src/lib/fx.ts:123-133`), or add a disclosure line: "Fee shown for bank transfer. Card payments from $2.99."

---

## NARROW CLAIMS (true but require qualification)

Each of the following 23 claims is directionally accurate but overstates a guarantee or omits a material exception.

| ID | Claim summary | Key qualification | Fix direction |
|---|---|---|---|
| `non-custodial-funds` | "Non-custodial, rate locked at confirmation" | (a) `getFundingProvider()` mock-only — non-custodial not yet exercised for real card capture; (b) legacy non-USD drafts without `feeSource` re-quote at live rate (`pay-finalize.ts:108-120`) | Qualify: "funding capture is simulated today"; fix legacy fallback or document it |
| `non-custodial-hero-subtext` | "AI quotes mid-market rate; every step signed, screened, audited" | (a) `marginBps` routing can deviate from raw mid-market; (b) `createTransfer` and `beginSettlement` do not write `audit_events` rows — audit coverage is incomplete | Add "best available rate" instead of "mid-market"; or disclose `marginBps`; document audit scope |
| `non-custodial-badge` | "Non-custodial" badge | `getFundingProvider()` always mock — the non-custodial invariant on the sender/capture side is architectural intent, not yet production-verified | Add "(architecture; live funding TBD)" or wire real PSP with enforced pass-through |
| `sanctions-screening-badge` | "Sanctions screening" trust badge | `WATCHLIST = ['john doe', 'jane roe', 'test blocked']` — three fake names, no real OFAC/SDN data (`compliance-config.ts:6`, `sanctions-provider.ts:26-42`) | Wire a real sanctions feed or add "prototype watchlist" disclaimer to the badge |
| `agent-never-holds-funds` | Agent "locks the live mid-market rate and holds it for you" | (a) UI says "~10 min" but draft TTL is 30 min (`draft-store.ts:6`, `tools.ts:187`); (b) legacy non-USD drafts can re-quote at live FX | Align copy to "locked for up to 30 minutes"; fix or document legacy re-quote path |
| `settlement-funds-never-touch` | "Funds never touch us" | Sender-side capture is mock-only today; the guarantee on the collection leg is architectural, not code-proven in production | Qualify claim to "on the settlement/payout side; funding capture is simulated" |
| `sanctions-structurally-impossible-off` | "Sanctions structurally impossible to switch off" | (a) `senderName` is optional — cron path never passes it, so sender can go unscreened; (b) `screener` parameter is injectable, allowing a future no-op; (c) mock watchlist | See `sanctions-always-runs` fix below |
| `corridor-count` | "8 corridors, any direction" | Primary corridors API returns 7 (all → IN); any-to-any is additive/secondary; CA excluded at runtime | Copy: "7 primary corridors (others in beta)" |
| `fx-no-markup` | "No markup on the rate; $1.99 after first free transfer" | (a) partner API hardcodes `transferCount=1` — never shows free first transfer (`partner-api-service.ts:175`); (b) `countByPhone` is cross-tenant; (c) card fees undisclosed | Disclose card fee tiers; fix `transferCount=1` or document partner-API exception |
| `live-mid-market-rate` | Landing page shows "(live mid-market rate)" | Silent fallback to static `FALLBACK_FX_RATE=85` on Frankfurter failure — label does not change (`rate.ts:9`, `page.tsx:435`) | Show "(estimated)" or "~85" when fallback is active |
| `pii-encrypted-at-rest` | "PII encrypted at rest; every reveal audited" | Customer PII (`fullName`, DOB, address, govId) is decrypted by default at repo layer and displayed on admin customer detail page without any `pii.reveal` audit event | Either mask customer PII by default and add audited reveal, or narrow claim to "payout destinations" |
| `partner-keeps-licence-and-funds` | "You keep the licence and funds flow through you" | (a) "licence" is a legal claim with no code gate; (b) sender-side capture mock-only; (c) "self-service dashboard" is a scoped view, not a standalone portal | Qualify licence claim as contractual/legal; note funding simulation status |
| `about-non-custodial-definition` | "We never hold your money" (about page hero) | Flagged-transfer code path captures funds before compliance hold (`pay/[transferId]/route.ts:125-146`) — once a real PSP is wired, funds would be held pending review | Add exception: "except briefly for transfers under compliance review" |
| `about-sanctions-cannot-be-switched-off` | "A match stops the transfer BEFORE IT'S EVER CREATED" | Blocked transfers ARE written to the ledger (`transfer-create.ts:209, 232`); a blocked attempt creates a row with `status='blocked'` — it is not rejected before creation | Change to "stops the transfer before funds are ever collected" |
| `about-signed-settlement-instruction` | "Cryptographically signed" (about page) | Signing is conditional on `signingSecret` being configured — absent secret silently drops the header (`http-payment-provider.ts:126-128`, `outbox-worker.ts:168-170`) | "Signed when a signing secret is configured; required for all production partners" |
| `about-delivery-notification` | "Both parties get a WhatsApp message" | Recipient notification is silently skipped when `recipientPhone` is empty (default `''`) — a common path (`schema.ts:78`, `outbox-worker.ts:122`) | Change to "Sender always notified; recipient notified when phone on file" |
| `about-multi-tenant-isolation` | "Fully isolated per-tenant dashboard and data" | `customers` table uses `phone` as global PK — customer record re-attributes across tenants on next inbound contact (`customer-repo.ts:143-196`) | Qualify: "transfers and financial records are strictly isolated; customer identity record follows most-recent contact" |
| `about-signed-webhooks-fail-closed` | "Instructions and callbacks HMAC-signed, fail-closed" | Outbound signing is conditional on `signingSecret` presence — absence does not block the POST | Same fix as above: enforce signing secret as required field before partner activation |
| `claim-partner-api-idempotency` | "A retry never duplicates a transfer" | Crash-replay re-quotes at live FX and re-runs compliance — same transfer ID, potentially different financial figures | Document: "same transfer ID guaranteed; financial terms are re-quoted on crash-replay" |
| `about-trust-non-custodial-pillar` | "Never holds, receives, or disburses funds" | `FundingProvider.capture()` seam is designed to receive real sender funds once a PSP is wired — claim will become inaccurate at that point | Add: "on the payout side; sender-side funding model is evolving" |
| `about-sanctions-always-on-pillar` | "Sanctions run on every transfer, impossible to switch off" | Sender screening is skipped when `senderName` is absent (cron path, optional partner API field); `screener` parameter injectable | Enforce `senderName` or screen by phone; document injectable screener test-only |
| `about-licensed-partners-move-money` | "Licensed partners hold the licence and move money" | No code gate enforces licence-holding; `isLicensed` optional free text, not checked at runtime | Same fix as MISMATCH-1: add licence verification gate or narrow copy |
| `about-encryption-at-rest` | "Customer data masked in dashboards; reveals audited" | Admin customer detail page (`admin-dashboard/customers/[phone]/page.tsx:92-96`) renders `fullName`, DOB, address in plaintext — no masking, no audit event | Mask customer PII on detail page and route through audited reveal server action |
| `about-demo-status-note` | "Production identity verification vendor...simulated today" | `getKycProvider()` (`kyc-provider.ts:68-76`) uses real Persona when `env.personaApiKey` is set — KYC is NOT unconditionally simulated | "Simulated by default; live Persona KYC activates when API key is configured" |
| `docs-funds-never-touch` | "Funds never touch SmartRemit (partner docs)" | Sender-side funding capture mock-only — non-custodial on collection side is architectural intent | Qualify to "on the payout/settlement leg" |
| `partner-rate-limit-claim` | "429 Retry-After: 60 on limit breach" | (a) `Retry-After: 60` is static — bucket resets at wall-clock minute boundary, so actual wait can be ~2s; (b) Redis error throws unhandled out of `guardPartner` (no fail-open wrapper) | Compute `Retry-After` dynamically: `Math.ceil((60000 - Date.now() % 60000) / 1000)`; add try/catch fail-open |
| `docs-sanctions-every-mint` | "A watchlist hit returns 422" (partner docs) | 422 is only returned by the partner REST API path; pay-page returns 400; WhatsApp chat returns no HTTP error code at all | Qualify docs to "422 on the POST /transactions API; pay-page returns 400; chat path handles in-conversation" |
| `docs-settlement-signed-with-retry` | "Settlement instructions are HMAC-SHA256 signed with retry" | Signing conditional on `signingSecret`; unsigned instruction sent if secret absent with no local error | Enforce `signingSecret` requirement at partner activation, or error before sending unsigned |
| `docs-webhook-fail-closed` | "Unsigned or mis-signed callbacks rejected 401, fail-closed" | `provider === 'mock'` with a mock-providerType partner bypasses HMAC gate entirely | Document mock-provider carve-out; enforce that production partners cannot use `providerType: 'mock'` |
| `calculator-rate-locked` | "Rate updated hourly; locked when you confirm" | Landing page ISR cache is 1 hour (`revalidate=3600`) but in-chat FX cache is 5 min — the displayed rate can be 1h stale before the customer enters chat; approval card says "~10 min" but draft TTL is 30 min | Either set `revalidate=300` to match FX cache, or add "rates in the calculator update hourly; final rate confirmed in chat" |
| `sanctions-always-runs` | "Sanctions screening always runs on every transfer" | Sender screening is conditionally skipped when `senderName` is absent — cron/scheduled path never passes `senderName` (`cron-run.ts:75-87`); partner API omits it when `sender.name` absent | Make `senderName` required in `CreateTransferInput`, or screen sender by phone when name unavailable |

---

## Counts by file area

| Area | Mismatches | Narrow |
|---|---|---|
| Landing / calculator (page.tsx, RateCalculator.tsx) | 2 | 4 |
| About page (about/page.tsx) | 2 | 10 |
| Partner docs / API | 0 | 4 |
| Core lib (transfer-create, compliance, settlement) | 0 | 4 |
| Admin dashboard | 0 | 1 |

---

## Recommended immediate actions (priority order)

1. **Fix `env.ts:117-120`** — both ternary branches return `'mock'`; this is almost certainly a typo and prevents any live PSP from ever being selected.
2. **Add licence gate** — before a partner can be set `active`, require `licenseVerifiedAt` (timestamp set by a platform admin) or remove the "Licensed-partner settled" badge.
3. **Fix `RateCalculator.tsx:86`** — display fee as funding-method-dependent or add card-fee disclosure; the current "$1.99" is false for card users.
4. **Remove Canada from corridor display** or add a footnote explaining NANP ambiguity (`defaults.ts:18`).
5. **Wire a real sanctions feed** or downgrade all "sanctions screening" trust copy to "prototype watchlist" until a real OFAC/SDN feed is connected.
6. **Fix `Retry-After` computation** in `partner-rate-limit.ts` (dynamic value, not static `60`).
7. **Audit customer PII reveal** — route `admin-dashboard/customers/[phone]/page.tsx` through an audited server action before rendering `fullName`/DOB in plaintext.
