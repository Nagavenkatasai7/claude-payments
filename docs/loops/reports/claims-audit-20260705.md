# Claims-vs-Code Audit — Morning Report
**Date:** 2026-07-05  
**Model:** Claude Sonnet 4.6 (subagent)  
**Product:** SmartRemit (smartremit.ai)

---

## Executive Summary

| Metric | Count |
|--------|-------|
| Total claims audited | 30 |
| Supported (no gap) | 0 |
| Narrow (claim overstates enforced code) | 29 |
| Mismatch (claim directly contradicted by code) | 1 |

**0 claims passed without qualification.** Every audited claim has at least one gap between the marketing/docs assertion and what the code actually enforces. The single outright mismatch is in the PII audit-trail showcase. The 29 narrows cluster around four systemic themes: (1) mock-only funding provider / non-custodial claims that hold today but are not structurally enforced; (2) conditional sender-side sanctions screening across most mint paths; (3) the settlement money-movement event not written to `audit_events`; and (4) conditional outbound HMAC signing.

---

## HIGH-RISK FINDINGS

### MISMATCH-01 — `pii-encrypted-at-rest-showcase`

**Claim (src/app/landing/showcase.tsx:109):**
> "PII encrypted at rest — every staff reveal is audited."

**Code evidence:**
The `pii.reveal` audit event is written in exactly **one** place: `src/app/admin-dashboard/actions.ts:199-206`, inside the explicit staff-only `revealDestinationAction`. The following decrypt paths execute with **zero** audit log entries:

1. `src/lib/b2b-pay-finalize.ts:109` — `store.getSellerDecrypted()` during B2B payment settlement (full bank account number, no audit).
2. `src/lib/tools.ts:2970` — `store.getTransferDecrypted()` inside the AI agent's repeat-transfer tool (no audit).
3. `src/app/account/receipt/[transferId]/page.tsx:113` — B2B receipts decrypt sender/recipient business names (no audit).
4. `src/app/account/settings/page.tsx:51` — bare `decryptField(customer.email)` for customer self-service (no audit).

Additionally, the actual showcase copy says "**every staff reveal**" — not "every reveal". The audit task audit removed the "staff" qualifier when framing this claim, making the gap even wider.

The B2B settlement path at `b2b-pay-finalize.ts:109` reads a full bank account number on every B2B payment with no audit trail — the highest-risk gap.

**Suggested fix:**
- **Code:** Add `createAuditRepo().record()` calls at each unaudited decrypt site. The settlement and agent paths are higher-priority than the customer self-service path.
- **Copy:** If only staff-dashboard reveals are to be audited, restore "staff" qualifier and explicitly exclude settlement-time and agent decryptions. Do not drop the qualifier in any external-facing material.

---

### NARROW-01 — `non-custodial-badge` / `never-holds-footer` / `never-holds-about-hero` / `funds-never-touch-showcase` / `funds-never-touch-docs`
*(Five claims, one systemic gap — grouped for brevity; each referenced separately below)*

**Claims (various pages):**
> "Non-custodial" (trust band, about hero, footer disclaimer)  
> "SmartRemit never holds or receives funds"  
> "Funds never touch us"  
> "SmartRemit never holds, disburses, or custodies funds" (docs)

**Code evidence:**
- **B2B ach_pull/bank_pull (strong — non-custodial by construction):** `src/app/api/pay/[transferId]/route.ts:126-133` structurally skips `captureFunding()` for `isPartnerPulled()` methods. The partner's signed instruction handles the debit. No SmartRemit merchant account is involved.
- **Settlement/payout side (strong):** `src/lib/settlement.ts:43-68` and `src/lib/providers/http-payment-provider.ts:177-216` only POST a signed instruction to the partner's `settlementUrl`; no balance is written, no fund is moved by SmartRemit.
- **B2C card/bank_transfer path (critical gap):** `src/lib/providers/funding-provider.ts:83-85` — `getFundingProvider()` is **hardcoded** to `new MockFundingProvider()`. No real PSP is wired. Comments at `funding-provider.ts:8-9` explicitly document the real target: "a PSP/sponsor-bank integration (Plaid + processor, Stripe, …) that charges the SENDER." `src/lib/env.ts:192` names `FUNDING_WEBHOOK_SECRET_STRIPE`. `/api/funding-webhook/[provider]` is wired and ready. When a real PSP lands, captured funds flow into a SmartRemit merchant account before the settlement instruction — a transient custodial moment not currently addressed in code.
- **No wallet table:** `src/db/schema.ts` has 14 tables; no wallet, balance, or custodial-account column exists.

**Suggested fix:**
- **Code (preferred):** Implement the real funding provider as a **direct-to-partner card capture** or pass-through PSP arrangement (e.g. Stripe Connect with immediate transfer to the licensed partner merchant account) so SmartRemit is never merchant-of-record. Add a `boot-assert` that rejects any non-ACH-pull configuration that does not use a partner-routed PSP.
- **Copy (interim):** Add a qualifier: "SmartRemit is architecturally non-custodial. For B2B bank-pull transfers, this is structurally enforced today. B2C card capture is currently simulated; the production funding provider will be structured to route funds directly to the licensed partner."

---

### NARROW-02 — `sanctions-every-transfer-trust-band` / `sanctions-impossible-switch-off-showcase` / `sanctions-cannot-switch-off-about` / `sanctions-always-runs` / `sanctions-always-runs-422-recorded`
*(Five claims, two systemic gaps — grouped)*

**Claims (trust band, showcase, about page, docs):**
> "Sanctions-screened on every transfer"  
> "Impossible to switch off"  
> "Stops the transfer before it's ever created"  
> "Every transfer screened — blocked → 422"

**Code evidence — Gap A (sender screening is conditional):**
- `src/lib/compliance.ts:36-38` — `screenTransfer` hard-codes `senderHit = { matched: false }` when `input.senderName` is falsy. No watchlist lookup is made for the sender.
- `src/lib/transfer-create.ts:136` comment reads "screens the recipient (**and sender, when a name is present**)" — the conditional is documented in the code itself.
- `src/lib/partner-api-service.ts:304` — `senderName: str(sender.name) || undefined`. A delegated-KYC partner calling the API without `sender.name` can pass a watchlist-listed sender unchecked.
- `src/lib/pay-finalize.ts:168` — resolves to `customer.fullName`, which is null for customers under a delegated-KYC partner who have never completed identity collection. `senderName` is then `undefined`.
- `src/lib/b2b-pay-finalize.ts:171-174` **explicitly closes this gap** in the B2B path with a fail-closed `buyer_unscreened` guard. The consumer pay-page, chat-agent, and partner REST API paths have no equivalent.

**Code evidence — Gap B (screener is a mock against 3 names):**
- `src/lib/providers/sanctions-provider.ts:40-42` — `getSanctionsScreener()` always returns `MockSanctionsScreener`.
- `src/lib/compliance-config.ts:6` — `WATCHLIST = ['john doe', 'jane roe', 'test blocked']`. Source comment: "Mock sanctions/watchlist — clearly fake names for the prototype."
- No real OFAC/SDN, FinCEN, or ComplyAdvantage feed is wired.

**Code evidence — Gap C (`sanctions-cannot-switch-off-about` sub-claims):**
- `src/lib/compliance.ts:26` exposes an optional `screener?: SanctionsScreener` injection parameter — a structural bypass seam. No production call site uses it, but the "structurally impossible" assertion is technically overstated.
- `src/lib/transfer-create.ts` — a blocked transfer is still written to the DB as `status='blocked'` via `store.saveTransfer()`. "Stops before it's ever created" inverts this.
- `src/app/api/pay/[transferId]/route.ts:126-147` — for `complianceStatus==='flagged'`, `captureFunding()` runs **before** the hold. Funds are captured before the human-review pause, not after.

**Code evidence — Gap D (idempotency replay, `sanctions-always-runs-422-recorded`):**
- `src/lib/partner-api-service.ts:255-259` returns `ok(200, ...)` for any existing transfer found on idempotency key collision, including blocked ones. The blocked-transfer check at line 325-327 is never reached on the replay path.

**Suggested fix:**
- **Code (high priority):** Add a fail-closed sender-name guard to `pay-finalize.ts` and `partner-api-service.ts` mirroring the pattern in `b2b-pay-finalize.ts:171-174`. Either require `senderName` or explicitly return a `sender_unscreened` error.
- **Code (high priority):** Wire a real sanctions provider (OFAC SDN, ComplyAdvantage, or equivalent) behind the `getSanctionsScreener()` factory before any live corridor goes live.
- **Code (medium):** In the idempotency replay path, check for blocked status and return 422 (not 200) for blocked replays.
- **Copy:** Replace "every transfer screened" with "recipient screened on every transfer; sender screened when identity is on file." Replace "impossible to switch off" with "no toggle exists; the check runs in all KYC modes." Add that the current screener is a mock feed not yet wired to a live regulatory database.

---

### NARROW-03 — `full-audit-trail-trust-band`

**Claim (trust band):**
> "Full audit trail"

**Code evidence:**
`audit_events` table exists and is written for: staff mutations, PII reveals, partner API-key transactions, ops retries, B2B invoice lifecycle, and copilot actions. However, the primary consumer money-movement path writes **zero** audit rows:
- `src/lib/transfer-create.ts` — no audit calls.
- `src/lib/settlement.ts` — no audit calls. The `paid` flip and rail instruction enqueue happen with no audit record.
- `src/lib/pay-finalize.ts` — no audit calls.
- `src/app/api/payment-webhook/` — no audit calls.
- `src/app/api/partner-rail/` — no audit calls.

The transfers ledger and outbox record state durably but are not the audit trail.

**Suggested fix:**
- **Code:** Add `createAuditRepo().record()` inside `beginSettlement()` (`src/lib/settlement.ts`) and inside the `settlement.instruct` outbox handler (`src/lib/outbox-worker.ts:149-188`). At minimum: `transfer.create`, `transfer.paid`, `transfer.instruct`, `transfer.delivered` events.
- **Copy:** Replace "Full audit trail" with "Audit trail for staff and API-key operations; transfer ledger for money movement."

---

### NARROW-04 — `licensed-partner-settles-hero`

**Claim (hero):**
> "Every step signed, screened, and audited — by your licensed partner"

**Code evidence:**
- **"Screened"** — genuinely structurally enforced (recipient always). Sender conditional (see NARROW-02).
- **"Signed"** — conditional, not universal. `src/lib/outbox-worker.ts:171` and `src/lib/providers/http-payment-provider.ts:199` both use: `...(signingSecret ? { 'x-signature': signBody(...) } : {})`. An unconfigured partner (empty `signingSecret`) receives an unsigned instruction. Inbound verification is fail-closed; outbound is not.
- **"Audited"** — partial. The settlement dispatch itself writes no `audit_events` row (see NARROW-03).
- **"Licensed partner"** — unverifiable from code. No runtime check confirms the partner holds a money-transmitter license.

**Suggested fix:**
- **Code:** Make `signingSecret` a required field (partner-onboarding validation or boot-assert) so the conditional spread is unreachable in production.
- **Copy:** Qualify to "HMAC-signed when configured" / "transfer activity logged" until signing is made mandatory and settlement events are audited.

---

### NARROW-05 — `signed-webhooks-fail-closed-about` / `signed-webhooks-fail-closed-docs`

**Claims (about page, docs):**
> "Callbacks verified fail-closed — unsigned callbacks rejected with 401"

**Code evidence:**
- **Incoming (verification) — CORRECT:** `src/lib/providers/payment-webhook-verify.ts:18` returns `false` for empty key or empty signature; `payment-webhook/route.ts:81-83`, `partner-rail/route.ts:69-71`, `funding-webhook/route.ts:45-47` all return HTTP 401 on failure.
- **Outgoing (signing) — NOT fail-closed:** `src/lib/providers/http-payment-provider.ts:197-200` and `src/lib/outbox-worker.ts:171` use the conditional spread: `...(signingSecret ? { 'x-signature': signBody(...) } : {})`. Empty `signingSecret` → unsigned instruction sent, no error thrown.
- **Mock endpoint bypass (`-docs` variant):** A POST to `/api/payment-webhook/mock` where the resolved rail is neither `http` nor `simulator` bypasses verification entirely and returns HTTP 200-ignored rather than 401. No money state is mutated, but the docs assert all unsigned callbacks get 401.

**Suggested fix:**
- **Code:** Require `signingSecret` at partner onboarding; fail-close the outbound path to match the inbound. For the mock endpoint, return 401 for unverified requests even when the handler is a no-op, so the documented behaviour is consistent.
- **Copy:** Qualify "fail-closed" as applying to the incoming verification direction; note that outbound signing requires `signingSecret` configuration.

---

### NARROW-06 — `encryption-aes256gcm-about`

**Claim (about page):**
> "AES-256-GCM at rest — masked in dashboards; staff reveals are audited"

**Code evidence:**
- **Encryption:** Confirmed. All PII `*Enc` columns use AES-256-GCM envelope encryption (`src/lib/field-crypto.ts:34-57`).
- **Transfer-level masking + audit:** Confirmed for payout destinations. `src/db/repos/mappers.ts:136-140, 192-203` returns `****last4` by default; `revealDestinationAction` writes `pii.reveal` to audit.
- **Customer PII — NOT masked, NOT audited:** `src/db/repos/customer-repo.ts` (comment: "DECRYPTED BY DEFAULT on read") decrypts `fullName`, `dateOfBirth`, `residentialAddress`, `govIdNumber` on every read. `src/app/admin-dashboard/customers/[phone]/page.tsx:92-95` renders these in plaintext. No `pii.reveal` event is ever written for customer PII access in the admin dashboard.

**Suggested fix:**
- **Code:** Apply the same masked-by-default / explicit-reveal pattern from `mappers.ts` to `customer-repo.ts`. Add `pii.reveal` audit events to the customer detail page for any PII fields surfaced.
- **Copy:** Qualify: "Transfer payout destinations masked by default; staff reveals audited. Customer PII stored encrypted; admin read access is not currently gated or audited."

---

### NARROW-07 — `idempotency-concurrent-toctou`

**Claim (docs/partner API):**
> "Idempotency — duplicate requests produce the same result; race conditions are handled"

**Code evidence:**
The structural guarantee (no duplicate DB rows) is sound: PK `(partner_id, key)` on `idempotency_keys` forces a single `reservedId`. `saveTransfer` uses `onConflictDoUpdate`, so two concurrent writes to the same id produce one row. However:

- **INSERT winner bypasses replay guard:** `src/lib/partner-api-service.ts:255-260` — the INSERT winner has `reservedId === candidateId` and skips the guard entirely, proceeding to execute full business logic without checking whether a row already exists.
- Two truly concurrent same-key requests both execute mint logic with `id = candidateId`. Last writer's `fxRate`, `amountInr`, and quote figures silently overwrite the first's via UPSERT. Both callers receive 201 with different financial figures; one disagrees with what is stored.
- `incrementTodayTransferCount` (Redis INCR) is called by both → velocity counter inflated by 1.
- `monthlyVolumeStore.addCents` (non-atomic GET+SET at `src/lib/monthly-volume-store.ts:19-21`) is called by both → monthly volume over-counted by one full transfer amount, potentially triggering false EDD flags or prematurely breaching caps.

The claim holds for sequential retries (the common case). It does not hold for concurrent same-key requests.

**Suggested fix:**
- **Code:** After winning the idempotency INSERT (`reservedId === candidateId`), immediately check whether a transfer row with that id already exists before executing business logic. Alternatively, use a distributed lock (Redis `SET NX`) around the claim-through-mint sequence.
- **Copy:** Qualify: "Idempotent for sequential retries. Concurrent identical requests may produce duplicate side-effects in analytics counters; row-level deduplication is guaranteed."

---

## REMAINING NARROW FINDINGS

The following findings are material but lower-urgency than the above. Each identifies a specific line-level discrepancy.

---

### NARROW-08 — `licensed-partner-settles-footer`

**Claim (footer):**
> "All funds settled on licensed partners' own rails"

**Gap:** `src/lib/providers/payment-provider.ts:122-134` — `MockPaymentProvider` is the default for absent/`mock`/unknown `providerType`; it self-advances settlement in-process with no licensed partner rail. `src/app/admin-dashboard/partners/new/wizard.tsx:281` — `'mock'` is explicitly selectable in production with no code gate preventing live use. `src/lib/env.ts:117-119` — `PaymentProviderMode` is `'mock'` only globally.

**Suggested fix:** Gate the `mock` provider type behind a development-only env flag; require `http` or a named rail for any non-sandbox partner. Update copy to scope "on their own rails" to non-mock integrations.

---

### NARROW-09 — `fee-first-free-then-flat-landing` / `fee-first-free-then-vague-about`

**Claim (landing, about):**
> "Your first transfer is free — then a low flat fee" / "adds a clear, flat fee"

**Gap:**
- `src/lib/fx.ts:83-84` — first-free is gated on `transferCount === 0` using `countByPhone`, which counts `awaiting_payment` (abandoned/unpaid) rows. An abandoned first transfer consumes the free slot.
- `src/lib/fx.ts:87-107` — `bank_transfer`/`ach_pull`/`bank_pull` are $1.99 (flat). `debit_card` is $2.99 (flat). **`credit_card` is `$2.99 + 3% × amountUsd`** — not flat. On a $500 send the credit card fee is ~$17.99.

**Suggested fix:** Change `countByPhone` to count only `status IN ('paid', 'in_review', 'delivered')` rows for the free-transfer determination. Add funding-method qualification to the fee copy: "per bank transfer" (already present on landing) and for about page replace "flat fee" with "fee" and link to the pricing schedule showing the $2.99 + 3% credit-card rate.

---

### NARROW-10 — `fx-live-midmarket-landing`

**Claim (landing):**
> "Live mid-market rate (no markup)"

**Gap:**
- `src/app/page.tsx:30` — `export const revalidate = 3600`. Rendered HTML rate can be up to 1 hour stale.
- `src/lib/rate.ts:83, 107-108` — on any Frankfurter failure, silently falls back to static hardcoded `FALLBACK_FX_RATE=85`. Page still displays "(live mid-market rate)" with no user-visible caveat.
- Frankfurter/ECB rates are published once per business day (~4 PM CET), not a real-time feed.

**Suggested fix:** Replace `revalidate = 3600` with a shorter TTL (e.g. 300), add a visible "last updated" timestamp to the rate display, and show a stale-data indicator when the fallback is in use. Update copy to "indicative mid-market rate (ECB reference, updated daily)."

---

### NARROW-11 — `fx-rate-locked-footer`

**Claim (footer):**
> "Rate locked when you confirm"

**Gap:**
- Rate is locked at **draft-creation time** (when the approval card is shown), not at the confirmation tap. The two events are separated by up to the 30-minute draft TTL.
- `src/lib/transfer-create.ts:120` — for legacy non-USD drafts missing `feeSource`/`totalChargeSource`, `quoteOverrideFromDraft` returns `undefined` and `createTransfer` falls back to a live re-quote at current FX rates. The locked rate is not honoured.

**Suggested fix:** Update copy to "Rate locked when your approval card is shown (valid for 30 minutes)." Add a migration that backfills `feeSource`/`totalChargeSource` on legacy drafts or treat missing fields as an error rather than a silent live-requote.

---

### NARROW-12 — `corridor-count-8`

**Claim (landing):**
> "8 corridors, any direction"

**Gap:**
`src/lib/types.ts:511-512` defines `CountryCode` with 10 members (adds HK, MX). `DEFAULT_CURRENCY_FOR_COUNTRY` maps all 10. `src/lib/partner-currency.ts:7` routes HK ('852') and MX ('52') prefixes. `src/lib/corridor-demand.ts:87-96` `SUPPORTED_ALIASES` covers only 8 countries — HK and MX absent — creating an internal analytics inconsistency. The 8-count is a marketing undercount (safe), but HK/MX corridor demand is misclassified as unsupported.

**Suggested fix (code):** Add HK and MX to `SUPPORTED_ALIASES` in `corridor-demand.ts` so analytics correctly classifies their demand. **Copy** can remain "8 corridors" if those corridors are not yet live for customers, but the landing page `COUNTRIES` array and `PARTNER_CORRIDORS` form should be aligned on the same number.

---

### NARROW-13 — `transfer-marked-delivered-about`

**Claim (about):**
> "Once payment is taken, a signed settlement instruction goes to the licensed partner's rail; when they confirm payout, the transfer is marked delivered"

**Gap:**
For the `mock` provider type, the entire signed loop is bypassed: `src/lib/settlement.ts:59-66` enqueues `mock.settle` instead; `src/lib/outbox-worker.ts:117-146` calls `completePaymentStage2()` directly with no partner endpoint POST and no HMAC verification in either direction. Mock is a real deployed configuration option (see NARROW-08).

**Suggested fix:** Same as NARROW-08 — gate the mock provider to non-production, or qualify the about page statement to "on real partner rails."

---

### NARROW-14 — `delivery-notification-both-parties`

**Claim (feature description):**
> "Both sender and recipient notified when funds are on their way"

**Gap:**
These are two separate lifecycle events, not one simultaneous send:
- Sender message fires at `paid` (stage 1), inside `beginSettlement()`.
- Recipient message fires at `delivered` (after payout confirmation) — and **only if** `recipientPhone` is non-empty. Schema default is `''` (`src/db/schema.ts:78`); `src/lib/partner-api-service.ts:220` allows `recipient_phone` to be absent. An empty `recipientPhone` silently suppresses the recipient notification.

**Suggested fix:** Make `recipientPhone` required for WhatsApp-originated transfers. For Partner API transfers, document that the recipient notification is conditional on providing `recipient_phone`. Update copy to reflect the two-stage lifecycle.

---

### NARROW-15 — `sanctions-demo-feed-caveat`

**Claim (about — "honest status note"):**
> "Sanctions: built-in reference rule set, not yet a live commercial AML feed — structurally impossible to switch off"

**Gap:**
The "structurally impossible to switch off" part is technically overstated: `src/lib/compliance.ts:26` exposes an optional `screener?: SanctionsScreener` injection parameter. No production call site uses it, but the parameter exists as a structural bypass seam. The rest of the claim (always runs, mock feed, demo caveat) is accurate.

**Suggested fix:** Remove the optional `screener` parameter or replace it with a type-checked registry approach that requires a real provider in production. The copy caveat is otherwise acceptable.

---

### NARROW-16 — `demo-status-simulated`

**Claim (about — "honest status note"):**
> "Production identity-verification vendor simulated today"

**Gap:**
`src/lib/providers/kyc-provider.ts:59-77` contains a working `PersonaKycProvider` that activates whenever `PERSONA_API_KEY` is set. `personaEnvironment` defaults to `'sandbox'` but is overridable. The "simulated" status is a deployment/env-var fact, not a code fact. Setting `PERSONA_API_KEY` in the production env would activate live Persona calls with no code change.

**Suggested fix (code):** Add a `PERSONA_ENV=production` explicit guard (or `NODE_ENV === 'production'` check in the provider factory) so accidental live activation in prod is not a one-env-var slip. **Copy** can retain the caveat as accurate for the current deployment.

---

### NARROW-17 — `about-page-licensing-placeholder`

**Claim (about page footer slot):**
> *(placeholder text only — no regulatory identifiers)*

**Gap:**
The footer slot at `src/app/about/page.tsx:259` is placeholder-only. Formal regulatory identifiers (NMLS numbers, FinCEN registration, state license numbers) are absent from the entire file and from the `/about` footer, while the main page footer (`src/app/page.tsx:772-778`) carries a full non-custodial/exchange-rate disclaimer.

**Suggested fix:** Replace the about-page footer placeholder with the same disclaimer block used on the landing page. Add formal regulatory identifiers once licensing is obtained.

---

### NARROW-18 — `settlement-instruction-retries-docs`

**Claim (docs):**
> "Settlement instructions retry with exponential backoff until your rail acks 2xx"

**Gap:**
`src/db/repos/outbox-repo.ts:33` — `MAX_ATTEMPTS = 8`. After 8 attempts, `markFailed()` sets status `'dead'`; no further automatic retries. Delivery stops until ops manually calls `retryDead()`. "Until 2xx" implies unbounded delivery guarantee; the actual guarantee is at-most-8-attempts then dead-letter.

**Suggested fix:** Update docs to: "Settlement instructions retry with exponential backoff (up to 8 attempts, capped at 1-hour intervals). After the 8th failure the instruction is dead-lettered and an ops alert fires for manual review."

---

### NARROW-19 — `partner-rate-limit-claim`

**Claim (docs/API reference):**
> "120 requests per minute per partner — retry after 60 seconds"

**Gap:**
`src/lib/partner-rate-limit.ts:21` uses `Math.floor(Date.now() / 60_000)` — a per-calendar-minute fixed window. `src/app/api/partner/v1/partner-api.ts:42` returns `Retry-After: '60'` hardcoded on every 429. True time-to-reset ranges from ~1 second (limit hit just before boundary) to ~59 seconds. A client following the header may wait up to 59 seconds longer than necessary.

**Suggested fix (code):** Replace the hardcoded `'60'` with: `String(Math.ceil((Math.ceil(Date.now() / 60_000) * 60_000 - Date.now()) / 1000))`. **Copy** can retain "120 requests per minute."

---

## Appendix: Claim-to-Status Index

| ID | Location | Status |
|----|----------|--------|
| pii-encrypted-at-rest-showcase | landing/showcase.tsx:109 | **MISMATCH** |
| non-custodial-badge | page.tsx trust band | narrow |
| never-holds-footer | page.tsx footer | narrow |
| licensed-partner-settles-hero | hero section | narrow |
| licensed-partner-settles-footer | page.tsx footer | narrow |
| funds-never-touch-showcase | landing showcase | narrow |
| sanctions-every-transfer-trust-band | trust band | narrow |
| sanctions-impossible-switch-off-showcase | showcase | narrow |
| fee-first-free-then-flat-landing | landing | narrow |
| fx-live-midmarket-landing | landing | narrow |
| fx-rate-locked-footer | footer | narrow |
| corridor-count-8 | landing h2 | narrow |
| full-audit-trail-trust-band | trust band | narrow |
| never-holds-about-hero | about hero | narrow |
| fee-first-free-then-vague-about | about | narrow |
| sanctions-cannot-switch-off-about | about | narrow |
| transfer-marked-delivered-about | about | narrow |
| delivery-notification-both-parties | feature description | narrow |
| encryption-aes256gcm-about | about | narrow |
| sanctions-demo-feed-caveat | about status note | narrow |
| signed-webhooks-fail-closed-about | about | narrow |
| demo-status-simulated | about status note | narrow |
| about-page-licensing-placeholder | about footer | narrow |
| funds-never-touch-docs | docs | narrow |
| sanctions-always-runs-422-recorded | docs/partner API | narrow |
| sanctions-always-runs | docs | narrow |
| signed-webhooks-fail-closed-docs | docs | narrow |
| settlement-instruction-retries-docs | docs | narrow |
| idempotency-concurrent-toctou | docs/partner API | narrow |
| partner-rate-limit-claim | docs/API reference | narrow |
