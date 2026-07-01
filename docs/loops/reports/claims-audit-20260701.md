# Claims-vs-Code Audit — Morning Report
**Date:** 2026-07-01  
**Auditor:** Loop / Claude Sonnet 4.6  
**Scope:** All public-facing and docs marketing claims for SmartRemit (smartremit.ai)  
**Method:** Read-only; no code or copy was modified.

---

## Executive Summary

| Metric | Count |
|--------|-------|
| Total claims audited | 41 |
| Supported (no qualification needed) | 1 |
| Narrow (true but overstated or partially false) | 38 |
| Mismatch (claim directly contradicted by code) | **2** |

**Overall posture:** The codebase is architecturally sound — the non-custodial design, outbox durability, AES-256-GCM encryption, and settlement mechanics are real and correctly implemented. However, nearly every public claim is overstated relative to what the code actually enforces. Three systemic gaps repeat across many claims: (1) the sanctions screener runs against a 3-name mock watchlist, not a real OFAC/SDN feed; (2) the FundingProvider (sender-side PSP capture) is a mock with no real implementation; (3) outbound settlement instruction signing is conditional on `signingSecret` being configured, not structurally enforced. HIGH-RISK mismatches and the most material narrows are listed first.

---

## HIGH-RISK: Mismatches (claim directly contradicted by code)

### MISMATCH-1 — "8 corridors. Any direction." heading
**ID:** `8-corridors-heading`  
**File:** `src/app/page.tsx:387`  
**Claim text:** `"8 corridors. Any direction."`

**Code evidence (contradicts both sub-claims):**
- `src/lib/prompt.ts:51-52,84` — agent prompt instructs "list all 9: US, Canada, UK, UAE, Singapore, Australia, New Zealand, India, **Hong Kong**" and "pays out to 9 countries."
- `src/lib/types.ts:7` — "any of the 9 corridors."
- `src/app/page.tsx:47-58` — `PARTNER_CORRIDORS` array has **9 entries** (includes HK), with inline comment "9 supported corridors + Other."
- `src/lib/defaults.ts:18` — `DEFAULT_PARTNER_COUNTRIES` includes `'HK'`.
- `src/lib/types.ts:588-589` — "destination is always IN in v1." — "Any direction" overstates bidirectionality; the destination is architecturally fixed to India in v1.

**Suggested fix (narrow the copy):** Change heading to `"9 corridors. Send to India."` or `"9 source countries. India delivery today."` Both match the agent prompt, the type system, and the platform overview. Do not use "any direction" until any-to-any settlement is implemented end-to-end.

---

### MISMATCH-2 — Test suite count in platform overview doc
**ID:** `doc-platform-test-count`  
**File:** `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` (claimed ~140 files / ~1,665 tests)  
**Claim text:** `"~140 test files / ~1,665 tests"` (approximate, from the doc)

**Code evidence (contradicts the numbers):**
- Filesystem count (July 2026): **169 total test files** (167 `.test.ts/.tsx` + 2 `.spec.ts`).
- Grep for `it(` / `test(` declarations: **~2,043 test cases**.
- Even the internal `CLAUDE.md:14` disagrees (says "~120 test files / ~1,270 tests"), showing the numbers have drifted in multiple directions.
- The post-deploy smoke suite claim (`smoke.yml`) is accurate and unaffected.

**Suggested fix (fix the copy):** Update to `"~170 test files / ~2,000 tests"` or, to avoid future drift, replace with a badge generated from CI (`$(find tests -name '*.test.ts' | wc -l)` test files). Sync `CLAUDE.md` at the same time.

---

## HIGH-RISK: Narrows — Sanctions Screening (8 claims)

All sanctions-related claims share the same two root defects:

> **ROOT DEFECT A:** The watchlist is `['john doe', 'jane roe', 'test blocked']` (`src/lib/compliance-config.ts:6`) — a 3-entry stub of obviously fake names. `getSanctionsScreener()` always returns `MockSanctionsScreener` (`src/lib/providers/sanctions-provider.ts:40-42`). No real OFAC/SDN/ComplyAdvantage integration exists.

> **ROOT DEFECT B:** Sender screening is conditional — `compliance.ts:36-38` short-circuits to `{ matched: false }` when `senderName` is absent. The cron path (`cron-run.ts:75-87`) never passes `senderName`, so scheduled-transfer senders are unscreened by name.

Each claim that asserts "sanctions screening on every transfer" or "structurally impossible to switch off" is accurate for the *code path* but not for *protective effect*. Screening a live transfer against a 3-name fake list does not constitute real AML/sanctions compliance.

### NARROW-S1 — Landing page "sanctions-screened" pillar
**ID:** `sanctions-always-on-landing`  
**File:** `src/app/page.tsx` (trust pillar)  
**Suggested fix:** Add a status qualifier: `"Sanctions screened (OFAC integration in roadmap)"` or move this pillar to the About page's status-note section until a real feed is wired.

### NARROW-S2 — "Structurally impossible to switch off" about-page claim
**ID:** `sanctions-impossible-off`  
**File:** `src/app/about/page.tsx`  
**Note:** The code-path claim is true; the protective-value claim is not. The current wording implies real regulatory protection.  
**Suggested fix:** Add inline: `"…against our built-in reference rule set (live commercial feed: roadmap item)."` This mirrors the about-page's own status-note for the mock list.

### NARROW-S3 — About-page "sanctions screening" pillar
**ID:** `sanctions-always-on-about`  
**Additional gap:** Cron path never passes `senderName` — scheduled-transfer senders are name-unscreened.  
**Suggested fix (fix the code):** Pass `senderName: customer.fullName` in `cron-run.ts:75-87`'s `createTransfer` call to close the scheduled-transfer sender gap. Separately, qualify mock-list status in copy.

### NARROW-S4 — "Step 4: every transfer screened" flow diagram
**ID:** `sanctions-step4-every-transfer`  
**Additional gap:** The claim "a match stops the transfer *before it's ever created*" is false — `recordBlockedAttempt` writes the row to the DB with `status='blocked'` before returning. The row is created; it just cannot proceed to payment.  
**Suggested fix (narrow the copy):** Change "stops the transfer before it's ever created" to "blocks the transfer immediately — it is recorded but never charged."

### NARROW-S5 — Idempotency replay returns 200 for blocked transfers
**ID:** `sanctions-runs-on-every-mint`  
**File:** `src/lib/partner-api-service.ts:255-259`  
**Suggested fix (fix the code):** After fetching the existing transfer in the idempotency-replay branch, check `if (t.complianceStatus === 'blocked') return err(422, 'This transfer was blocked by compliance screening.')` before returning the 200 replay. This makes blocked-transfer idempotency consistent with the first-call behavior.

### NARROW-S6, S7, S8 — "Sanctions always runs" in docs, partner integration guide, and team docs
**IDs:** `sanctions-not-delegable-docs`, `doc-platform-overview-sanctions`, `doc-platform-velocity`  
**Shared note:** The `>= 5` velocity trigger is stricter than the doc says ("more than 5") — the 5th transfer (not the 6th) triggers the flag. For a compliance boundary this is material.  
**Suggested fix:** Change "more than 5 transfers/day" to "5 or more transfers/day (i.e., the 5th transfer flags the customer)."

---

## HIGH-RISK: Narrows — "Funds Never Touch Us" / Non-Custodial Claims (7 claims)

All share the same root defect:

> **ROOT DEFECT:** `getFundingProvider()` at `src/lib/providers/funding-provider.ts:83-85` unconditionally returns `MockFundingProvider`. There is no real PSP (Stripe, Plaid, etc.) implemented. The non-custodial property on the sender-capture side is enforced by *absence of implementation*, not by structural code constraints. Wiring a real PSP would have SmartRemit transiently receive sender funds.

### NARROW-N1 — Hero "non-custodial design" claim
**ID:** `non-custodial-design`  
**File:** `src/app/page.tsx` (hero section)  
**Suggested fix (narrow the copy):** Add a qualifier: `"Non-custodial by design — we send signed settlement instructions to licensed partners; we never hold or disburse recipient funds. Sender-side PSP capture is pass-through (integration in progress)."` The settlement/payout side is structurally enforced; only be explicit about the sender-capture seam.

### NARROW-N2 — "Never holds funds" hero block
**ID:** `never-holds-funds-hero`  
**File:** `src/app/page.tsx` (5-step flow hero)  
**Critical sub-gap:** "EVERY STEP SIGNED" is not structurally enforced. Outbound settlement instruction signing at `outbox-worker.ts:171` is conditional: `...(signingSecret ? { 'x-signature': signBody(...) } : {})`. A partner with no `signingSecret` receives unsigned instructions with no error.  
**Suggested fix (fix the code):** Fail hard when `signingSecret` is absent for `http` providers — throw in `buildSettlementInstruction` when `providerType === 'http' && !credentials.signingSecret`. Add a boot-time or partner-activation assertion. Narrow the copy: "settlement instructions are HMAC-signed (required for http partners)."

### NARROW-N3 — "Funds never touch SmartRemit" trust band
**ID:** `funds-never-touch-us`  
**File:** `src/app/page.tsx:276` (trust band)  
**Suggested fix (narrow the copy):** `"SmartRemit never holds or disburses recipient funds — licensed partners settle on their own rails via signed instructions."` Remove the absolute "funds never touch us" framing until the sender-PSP seam is production-wired.

### NARROW-N4 — About-page "How a send works" Step 3
**ID:** `partner-never-receive-hold`  
**File:** `src/app/about/page.tsx` (Step 3)  
**Specific gap:** Step 3 states in present tense that "the partner's rail processes the payment" — the about page itself acknowledges at line 221 that the payout rail is "simulated today," but Step 3 makes no such qualification.  
**Suggested fix (narrow the copy):** Add `"(simulated today; live partner rail in roadmap)"` inline to Step 3.

### NARROW-N5 — Non-custodial / "not a bank" about-page pillar
**ID:** `non-custodial-not-bank`  
**ID:** `licensed-partner-settles-about`, `licensed-partner-settles-trust-band`, `licensed-partner-step5`  
**Shared gap (signing):** Settlement instruction signing is conditional on `signingSecret`; the inbound callback is fail-closed, but the outbound instruction is not. A misconfigured partner integration sends unsigned instructions with no alert.  
**Suggested fix (fix the code):** See NARROW-N2. Also for `doc-funds-never-touch`: "funds never touch SmartRemit" in the partner integration guide specifically covers the payout leg — qualify "this applies to recipient disbursement; sender-side capture is via a PSP integration (currently mocked)."

---

## MEDIUM-RISK: Narrows — Rate / Fee Claims (5 claims)

### NARROW-R1 — "No hidden markup" rate claim
**ID:** `rate-no-hidden-markup`  
**File:** `src/app/page.tsx` (rate section)  
**Gaps:** (a) On Frankfurter error, the UI silently shows the hardcoded fallback `FALLBACK_FX_RATE = 85` (`src/lib/rate.ts:9`) while still labeling it "live mid-market rate." (b) The partner best-rate `> mid` guard (`src/lib/tools.ts:896`) is a code-layer check, not a DB constraint — one change removes it.  
**Suggested fix (fix the code for gap a):** When the fallback rate fires, set a different label (e.g., "indicative rate — live feed temporarily unavailable") instead of "live mid-market rate."

### NARROW-R2 — "Live mid-market rate" landing page display
**ID:** `rate-live-mid-market`  
**File:** `src/app/page.tsx:435`  
**Gap:** ISR `revalidate = 3600` means the rendered rate can be 1 hour stale, still labeled "live mid-market rate." During Frankfurter downtime, the page shows `₹85` (static fallback) with the same "live" label.  
**Suggested fix:** Change label to "mid-market rate (updated hourly)" or add a freshness timestamp. On fallback, show "indicative rate."

### NARROW-R3 — "Flat $1.99 per bank transfer / first transfer free"
**ID:** `fee-first-free`, `fee-about-flat`  
**File:** `src/app/page.tsx`, `src/app/about/page.tsx`  
**Gap:** The complete fee schedule (`src/lib/fx.ts:82-107`) has undisclosed tiers: debit card → $2.99; credit card → $2.99 + 3% of USD amount. A customer reading "flat $1.99" could reasonably believe all non-free transfers cost $1.99.  
**Suggested fix (narrow the copy):** State the full schedule: "Bank transfer: $1.99 · Debit card: $2.99 · Credit card: $2.99 + 3%. First transfer always free."

### NARROW-R4 — "Rate locked at confirmation"
**ID:** `rate-locked-at-confirmation`, `doc-platform-fx-locked`  
**Gaps:** (a) Scheduled recurring transfers (`cron-run.ts`) always re-quote live — no draft, no lock. (b) Legacy non-USD drafts lacking `feeSource`/`totalChargeSource` fall back to a live re-quote at mint time. (c) Partner REST API (`POST /partner/v1/transactions`) never passes a quote override.  
**Suggested fix (narrow the copy):** "Rate is locked for ad-hoc transfers approved via the approval card. Recurring scheduled transfers re-quote at execution time."

---

## MEDIUM-RISK: Narrows — Audit Trail / PII Claims (4 claims)

### NARROW-A1 — "Full audit trail" trust band
**ID:** `audit-trail-trust-band`  
**File:** `src/app/page.tsx:276`  
**Gap:** Core money events (transfer creation, payment, settlement via WhatsApp/pay-page/partner API) write **no** `audit_events` rows. KYC decisions go to a **Redis hash** with no TTL and code comments flagging them as "Phase-5 concern" for durable export. "Full" is not code-enforced.  
**Suggested fix (narrow the copy):** "Audited staff actions and PII reveals." Reserve "full audit trail" for after core money events and KYC decisions are written to the Postgres `audit_events` table.

### NARROW-A2 — "Every reveal is audited"
**ID:** `pii-reveals-audited`  
**Gap:** Only `revealDestinationAction` writes a `pii.reveal` audit event. Customer PII (fullName, DOB, address, govIdNumber) is decrypted by default on every `customer-repo` read (`customer-repo.ts:21`) and rendered plaintext on the admin customer detail page with no audit entry. The agent (`tools.ts:2932`), the outbox worker (settlement/refund paths), and B2B pay-finalize also call decrypted reads without audit events.  
**Suggested fix (fix the code):** Add `pii.reveal` audit events when the admin customer detail page renders, or gate that page behind an explicit reveal action. Alternatively, make `rowToCustomer` mask by default and add an explicit decrypt flag (mirroring the transfer pattern).

### NARROW-A3 — "KYC decisions logged" claim
**ID:** `audit-trail`  
**Gap:** `reviewKycAction` → `kyc-case-store.review()` appends to a **Redis hash** (`kyc_audit:<phone>`), not Postgres `audit_events`. Redis is not append-only (HDEL is possible) and the code itself notes "Durable-beyond-Redis export of the audit log is a Phase-5 concern" (`kyc-case-store.ts:13-15`). Additionally, `markCustomerVerifiedAction` and `markCustomerRejectedAction` write no audit event at all.  
**Suggested fix (fix the code):** Write KYC decisions to `audit_events` in addition to (or instead of) the Redis hash. Add audit writes to `markCustomerVerifiedAction` / `markCustomerRejectedAction`.

### NARROW-A4 — "Encryption at rest, masked by default"
**ID:** `encryption-at-rest`, `doc-platform-overview-encryption`  
**Gap:** Customer PII (fullName, DOB, residentialAddress, govIdNumber) is decrypted **by default** on every `customer-repo` read (`customer-repo.ts:21`; comment: "DECRYPTED BY DEFAULT on read — the agent's hot path screens sanctions against customer.fullName"). The admin customer detail page renders all these fields in full plaintext with no mask and no reveal step.  
**Suggested fix (fix the code):** Separate the agent's name-read for sanctions from the admin display path. The admin page should use an explicit reveal action (mirroring `revealDestinationAction`) so PII is masked by default and reveals are audited.

---

## MEDIUM-RISK: Narrows — Corridor / Country Claims (5 claims)

All corridor claims share the same root: the codebase supports **9** corridors (including Hong Kong), `DEFAULT_PARTNER_COUNTRIES` excludes Canada on the default tenant (NANP +1 ambiguity), and "any direction" overstates a product that defaults to US→India.

### NARROW-C1 — "8 corridors" in OpenGraph metadata
**ID:** `8-corridors-meta`, `8-corridors-meta-desc`  
**File:** `src/app/page.tsx:23`  
**Suggested fix:** Update `og:description` to "9 corridors" to match `PARTNER_CORRIDORS` and `CountryCode` type union.

### NARROW-C2 — Canada listed as a send corridor
**ID:** `corridors-countries`, `corridors-overview-doc`  
**Gap:** `src/lib/defaults.ts:18` explicitly excludes `'CA'` with comment "CA deliberately EXCLUDED — shares +1 NANP with US." The migration `drizzle/0006_default_partner_any_to_any.sql` confirms the live default partner row omits CA.  
**Suggested fix (narrow the copy):** Remove Canada from corridor claims on the default/SmartRemit product. Note it as "available for white-label partners with dedicated CA phone numbers."

---

## LOWER-RISK: Narrows — Compliance Architecture Claims (5 claims)

### NARROW-L1 — Transaction limits bypass via partner REST API
**ID:** `doc-platform-transaction-limits`  
**File:** `src/lib/partner-api-service.ts:298`  
**Gap:** `createTransaction` (the partner REST API `POST /api/partner/v1/transactions`) calls `createTransfer` directly with **no** `evaluateCap` call. A partner can mint a transfer for any amount regardless of T0/T1 daily caps.  
**Suggested fix (fix the code):** Call `evaluateCap(customer.tier, amountUsd, getDailyVolumeStore())` in `partner-api-service.ts:createTransaction` before calling `createTransfer`, identically to the chat and pay-page paths.

### NARROW-L2 — KYC "human-only terminal state" gap for legacy paths
**ID:** `doc-platform-kyc-human-only`  
**Gap:** `markCustomerVerifiedAction` sets `kycStatus: 'verified'` WITHOUT setting `kycReviewState: 'approved'`. The `HUMAN_TERMINAL` guard in `applyKycEvent` checks `kycReviewState`, not `kycStatus` — a subsequent Persona webhook can still move `kycReviewState` to `needs_review` for a customer verified via the legacy path.  
**Suggested fix (fix the code):** In `markCustomerVerifiedAction`, also set `kycReviewState: 'approved'` (and in `markCustomerRejectedAction`, set `kycReviewState: 'rejected'`) so the `HUMAN_TERMINAL` guard fires correctly regardless of which path made the terminal decision.

### NARROW-L3 — "Durable and idempotent" outbox claim
**ID:** `durable-idempotent`  
**Gap:** The compliance-flagged (`in_review`) branch at `src/app/api/pay/[transferId]/route.ts:135-141` calls `completePaymentStage1` then `await sendText(...)` directly — outside the outbox. A crash after the status flip but before `sendText` completes leaves the customer charged but unnotified, with no retry path.  
**Suggested fix (fix the code):** Enqueue the stage-1 "payment received" WhatsApp message as a durable outbox row for the `in_review` branch, matching the happy-path outbox pattern.

### NARROW-L4 — "Signed settlement webhooks" claim (outbound signing conditional)
**ID:** `signed-settlement-webhooks`, `docs-funds-never-touch`  
**Gap:** Outbound signing at `outbox-worker.ts:171` uses `...(signingSecret ? { 'x-signature': ... } : {})`. An `http` partner with no `signingSecret` receives unsigned settlement instructions silently. Inbound callback verification IS fail-closed.  
**Suggested fix (fix the code):** Throw in `outbox-worker.ts` (or in `buildSettlementInstruction`) when `providerType === 'http' && !credentials.signingSecret`. Add a partner-activation guard so `http` partners cannot be activated without a `signingSecret`.

### NARROW-L5 — "Reconciliation" window for reviews measured from paidAt
**ID:** `doc-platform-reconciliation`  
**Gap:** The 24-hour stale-review alert (`findInReviewOlderThan(24)`) measures from `paidAt`, not from when the transfer entered `in_review`. A transfer paid early and flagged hours later may alert before 24 hours of actual review hold.  
**Suggested fix (fix the code):** Add an `in_review_at` timestamp column, set it when `status` transitions to `in_review`, and use it as the window anchor in `findInReviewOlderThan`.

---

## LOWER-RISK: Narrows — Delivery / Refund / EDD / Crypto-Shred Claims

### NARROW-M1 — "Both sender and recipient notified on delivery"
**ID:** `delivery-notification-both`, `paid_out-delivered-branded-whatsapp-notification-claim`  
**Gaps:** (a) Recipient notification is conditional on `recipientPhone` being non-empty (defaults to `''`). (b) For `http`/`simulator` rails, delivery notifications fire inside a non-durable `next/after()` block — lost on function death with no retry. (c) For transfers in `in_review`, `cancelled`, or `blocked` states, `updateTransferFromWebhook` returns `null` and no notification fires even when the partner posts `paid_out`.  
**Suggested fix (fix the code):** Move delivery notifications for `http`/`simulator` rails into the outbox (consistent with the mock path). Guard the `null`-return path explicitly and emit an ops alert when `paid_out` arrives for a transfer that cannot be updated.

### NARROW-M2 — EDD field list conflates two compliance tiers
**ID:** `doc-platform-edd-travel-rule`  
**Gap:** The doc lists 5 EDD fields triggered at $3,000. Only `source_of_funds` and `occupation` are enforced by `evaluateEddForTransfer` (`tier-rules.ts:92-99`). The other three (`relationship`, `purpose`, `recipient_legal_name`) are optional Travel-Rule (Tier 2) per-transfer metadata, not EDD fields.  
**Suggested fix (narrow the copy):** "At $3,000 cumulative/month, two EDD fields are collected: source_of_funds and occupation. Travel-rule fields (purpose, recipient relationship, recipient legal name) are optional per-transfer metadata collected separately."

### NARROW-M3 — Crypto-shred claim overstated
**ID:** `doc-platform-crypto-shred`  
**Gaps:** (a) Plaintext `*_last4` sibling columns survive any ciphertext drop — full row deletion is required. (b) No `deleteTransfer()` or `deleteCustomer()` function exists; only `deleteIntegrations()` (which correctly comments "Crypto-shred"). (c) The shared master key is "set-once, never rotate" — true crypto-shred requires the master key or per-record KMS key to be invalidated, not just the wrapped DEK blob.  
**Suggested fix (narrow the copy):** Scope the crypto-shred claim to integration secrets (which have a real delete path). Add a note: "PII disposal for transfers and customer records requires full row deletion (last-4 residuals also purged)."

### NARROW-M4 — "Beneficiary payout details encrypted at rest"
**ID:** `store-beneficiary-encrypted-at-rest`  
**Gap:** `beneficiaries.name` is stored as plaintext (`src/db/schema.ts:379`: `name: text('name').notNull()`). No `nameEnc` column exists. CLAUDE.md lists "recipient legal names" as encrypted; the `transfers.recipientLegalNameEnc` column exists, but the equivalent field on `beneficiaries` does not.  
**Suggested fix (fix the code):** Add `name_enc` / `name_last4` columns to the `beneficiaries` table (mirroring the `transfers.recipientLegalNameEnc` pattern) and encrypt on write in `createBeneficiary`. Migration required.

### NARROW-M5 — "Honest status note" on about page — KYC not definitively simulated
**ID:** `honest-status-note`  
**Gap:** The about page says "production identity-verification vendor simulated today," but `getKycProvider()` (`src/lib/providers/kyc-provider.ts:68-75`) activates a live Persona integration silently if `PERSONA_API_KEY` is set. This env var is not in `REQUIRED_PRODUCTION_VARS` (`boot-assert.ts`). If set in production without updating the about page, real identity data flows to Persona while the status note still says "simulated."  
**Suggested fix (fix the code):** Add `PERSONA_API_KEY` (when present) to a check that updates the status note, or invert: add a `KYC_SIMULATION_MODE=true` env var that must be explicitly set to use the mock, making live Persona opt-in rather than opt-out.

### NARROW-M6 — "Rate locked at API confirmation" partner API
**ID:** `REST API + idempotent transfers`  
**File:** `src/lib/partner-api-service.ts`  
**Already covered under NARROW-R4 — API always re-quotes live.**

### NARROW-M7 — "API rate limit with accurate Retry-After"
**ID:** `api-rate-limit`  
**Gap:** `Retry-After` is hardcoded to `'60'` (`src/lib/partner-api.ts:42`) rather than the actual remaining seconds in the current window. A request hitting the limit with 5 seconds left in the window is told to wait 60 seconds.  
**Suggested fix (fix the code):** Compute `window_remaining_seconds` from the Redis TTL on the rate-limit key and use that value in `Retry-After`, matching the pattern already used in `ip-rate-limit.ts:86-88`.

---

## SUPPORTED (no action needed)

### SUPPORTED-1 — About page footer placeholder
**ID:** `claim-about-page-footer-placeholder`  
**File:** `src/app/about/page.tsx:259`  
`[Placeholder: licensing & regulatory disclosures]` renders unconditionally as a static span. The claim is accurate — this is a known in-progress item, not a false assertion.

---

## Systemic Recommendations

1. **Wire a real sanctions feed before using "sanctions-screened" in marketing.** The `SanctionsScreener` interface is already a plug-in seam (`src/lib/providers/sanctions-provider.ts:40`). Until a real OFAC/ComplyAdvantage provider is wired, all "sanctions screening" claims should carry the about-page's own disclaimer ("reference rule set, not yet a live commercial AML feed").

2. **Make outbound settlement instruction signing fail-closed.** The asymmetry between fail-closed inbound verification and optional outbound signing is the most operationally dangerous gap. A `signingSecret` check should be a hard error at partner activation, not a silent omission at send time.

3. **Enforce transaction limits in the partner REST API.** `evaluateCap` is called in all customer-facing paths but is absent from `partner-api-service.ts:createTransaction`. This is a gap in the T0/T1 limit enforcement that a partner integration can inadvertently bypass.

4. **Migrate KYC audit log from Redis to Postgres.** The `kyc_audit:<phone>` Redis hash is not append-only, has no TTL, and the code itself flags it as "Phase-5 concern." For a money-services company, KYC decision audit records should be in the durable, queryable `audit_events` table.

5. **Unify customer PII access pattern with transfer PII.** Transfer payout destinations are masked by default and reveals are audited — customer fullName/DOB/address/govId should match that pattern. Currently `customer-repo` decrypts by default, making the masking guarantee asymmetric.
