# Morning Claims-vs-Code Audit — 2026-06-28

**Project:** SmartRemit (smartremit.ai)
**Auditor:** Claude Opus 4.8 (1M context) via loop
**Scope:** All public-facing and partner-facing claims about non-custody, rate locks, fees, sanctions, encryption, audit trails, delivery, and corridor count.

---

## Summary

| Metric | Count |
|---|---|
| Total claims audited | 34 |
| Supported | 0 |
| Narrow (claim holds in architecture but overstates current state) | 33 |
| Mismatch (claim is factually wrong for a reachable code path) | 1 |

Every claim touches the architectural intent accurately; the single mismatch and many narrows arise because marketing copy presents design intent as operational fact, or omits material qualifications required for a licensed money company.

---

## HIGH-RISK MISMATCHES (Claim is Factually Wrong)

### 1. `fee-schedule-about-step2` — "a clear, flat fee" [MISMATCH]

**Claim (src/app/about/page.tsx ~line 134):**
> "a clear, flat fee"

**Code evidence:**
`src/lib/fx.ts:78-80`:
```
case 'credit_card': feeUsd = round2(2.99 + 0.03 * amountUsd);
```
The credit card fee is **$2.99 PLUS 3% of the USD send amount** — explicitly percentage-based, not flat. Bank transfer ($1.99) and debit card ($2.99) are flat, but the credit card path is variable and can be materially higher (e.g., a $500 send costs $17.99 in fees, not $2.99).

**Suggested fix (narrow the copy):**
Change "a clear, flat fee" to "a clear fee — flat for bank and debit card transfers; a small fixed fee plus a card processing percentage for credit card." Alternatively, fix the code by making credit card fees flat (removing the `0.03 * amountUsd` component), but that is a product decision.

**Risk:** For a regulated money transmission product, advertising a "flat fee" when the credit card path contains an ad valorem component is a material misrepresentation to consumers and a potential disclosure violation.

---

## NARROWS — HIGH RISK (Architecture real; current implementation understates or absent)

### 2. `sanctions-always-on-trust-band` / `sanctions-structurally-impossible-off` / `sanctions-screening-always-on` / `sanctions-step4-about` / `sanctions-not-delegable-docs` / `sanctions-screening-claim`

**Claim family:** "Sanctions screening always runs on every transfer — structurally impossible to switch off."

**Code evidence (gap):**
- `src/lib/providers/sanctions-provider.ts:40-42`: `getSanctionsScreener()` unconditionally returns `MockSanctionsScreener`.
- `src/lib/compliance-config.ts:6`: watchlist = `['john doe', 'jane roe', 'test blocked']` — three fictional placeholder names; not OFAC/SDN/UN/EU data.
- `src/lib/compliance.ts:36-38`: sender screening is conditional — `input.senderName ? await screener.screen(...) : { matched: false }`. A partner that omits `sender.name` silently skips sender-side screening.
- `src/lib/cron-run.ts:75-87`: scheduled/cron transfers call `createTransfer()` without passing `senderName` — sender is never screened in cron-fired scheduled transfers.
- `src/lib/tools.ts:1149-1150` (approve-tap chat path): velocity/volume counters are incremented even when `status: 'blocked'` is returned by `createTransfer`, contradicting the `recordBlockedAttempt` documented invariant.
- `src/app/about/page.tsx:140-141`: "A match stops the transfer before it's ever created" — factually wrong; blocked transfers ARE persisted as `status='blocked'` rows (`transfer-create.ts:209,232`).
- `src/app/about/page.tsx:141`: "A flag routes it to a human reviewer" — flagged transfers proceed to `status:'awaiting_payment'` (same as cleared), with no enforced human-review queue in code.

**Suggested fix:**
1. Integrate a real OFAC/SDN feed via the `SanctionsScreener` seam before any production launch.
2. Make sender screening unconditional (error or default-to-block if `senderName` is absent, rather than `{ matched: false }`).
3. Pass `senderName` in `cron-run.ts`.
4. Correct the about page copy: "blocked transfers are persisted as auditable ledger rows and cannot proceed to payment" (accurate); "flagged transfers are surfaced for staff review" (accurate, not "routed" with enforcement).
5. Add a check in the approve-tap path: if `status === 'blocked'`, skip velocity counter increments.

**Risk:** A regulator reading "sanctions screening always on" and auditing the code would find a prototype mock watchlist — not OFAC data. Sender screening silently no-ops for cron paths and any partner omitting sender name.

---

### 3. `smartremit-non-custodial-claim` / `never-holds-funds-hero` / `non-custodial-about-hero` / `non-custodial-design` / `never-holds-footer-disclaimer` / `never-holds-funds-showcase` / `funds-never-touch-us-rail` / `non-custodial-page-badge`

**Claim family:** "Never holds your funds / funds never touch us / non-custodial."

**Code evidence (gap):**
- `src/lib/providers/funding-provider.ts:83-85`: `getFundingProvider()` unconditionally returns `MockFundingProvider` — returns `mockfund-${transfer.id}` with zero real PSP interaction. No real sender-side capture exists.
- `src/app/api/pay/[transferId]/route.ts:125-132`: for `bank_transfer` (b2c), `captureFunding()` IS called — this is a SmartRemit-owned capture seam, not the licensed partner's rail. A real PSP here would mean the sender's funds flow through SmartRemit's processor before a settlement instruction goes to the partner.
- `src/app/api/pay/[transferId]/route.ts:134-147` comment "Funds captured above; hold for manual review" for flagged transfers: funds are captured by SmartRemit and held in `in_review` status — a custodial pattern.
- Outgoing settlement instruction signing is conditional: `src/lib/outbox-worker.ts:166-172` — `...(signingSecret ? { 'x-signature': ... } : {})` — unsigned POSTs are sent silently if `signingSecret` is unconfigured.
- `src/lib/providers/payment-provider.ts:131-133`: default for all partners is `MockPaymentProvider`, bypassing the entire signed-instruction/callback loop.

**Suggested fix:**
1. The settlement side (outbound instruction, no SmartRemit custody on payout) is genuinely non-custodial and correctly architected — keep that claim.
2. Qualify copy for the sender side: "when a real payment processor is connected for card/bank transfers, funds pass through a licensed PSP before being instructed to the partner's rail."
3. Enforce that `signingSecret` is required before a partner with `providerType: 'http'` can go active (code gate in partner wizard, not just convention).
4. Add the honest-status disclosure already present on the about page to the hero and badge copy — or remove the present-tense operational framing until a real PSP is wired.

**Risk:** For any money-company regulatory review, advertising "we never hold funds" while the code contains a `captureFunding()` seam owned by SmartRemit (even if currently mock) and an explicit "Funds captured above; hold for manual review" comment is a material gap.

---

### 4. `encryption-at-rest-pii` / `encryption-aes256-gcm-about` / `full-audit-trail-trust-band` / `full-audit-trail-about`

**Claim family:** "AES-256-GCM encryption, all PII masked in dashboards, staff reveals audited, full audit trail."

**Code evidence (gaps):**
- `src/db/repos/customer-repo.ts` (comment line 21): customer PII (`fullNameEnc`, `dateOfBirthEnc`, `residentialAddressEnc`, `govIdNumberEnc`) is "DECRYPTED BY DEFAULT on read." Staff viewing `customers/[phone]/page.tsx:92-96` see plaintext PII with no masking and no audit event written.
- `src/db/schema.ts:77`: `transfers.recipientName` column is plaintext — only `recipientLegalNameEnc` (EDD/Travel-Rule) is encrypted.
- `src/db/schema.ts:345,350`: beneficiary `name` and `recipient_phone` are stored as cleartext; only the payout destination string is encrypted.
- `audit_events` writes do NOT cover: transfer creation (`transfer-create.ts`), payment capture (`pay-finalize.ts`), settlement instruction dispatch (`settlement.ts`), or webhook delivery confirmation (`payment-webhook/route.ts`).
- KYC decisions via `markCustomerVerifiedAction` / `markCustomerRejectedAction` (`admin-dashboard/customers/actions.ts`) write no audit event. The `reviewKycAction` path writes to a Redis hash (`kyc_audit:<phone>`), not the durable Postgres `audit_events` table; the Redis store has no explicit TTL and the comment defers Postgres durability to "Phase-5."
- `audit_events` table has no DDL-level DELETE restriction or RLS — "append-only" is application convention only.

**Suggested fix:**
1. Encrypt beneficiary `name` and `recipient_phone` columns, or qualify the claim to "payout account number encrypted."
2. Add masking to the customer PII detail page (same `****last4` pattern), or add a `pii.reveal` audit write for every staff customer-detail page load.
3. Write `audit_events` rows for transfer creation, settlement instruction dispatch, and webhook delivery.
4. Migrate KYC audit from Redis to Postgres `audit_events`.
5. Qualify copy: "core PII and payout routing data encrypted at rest; staff dashboard reveals of payout destinations audited; full money-lifecycle audit log is in progress."

**Risk:** A compliance audit of PII masking would find customer full names, DOB, and residential addresses rendered in plaintext in the staff dashboard with no audit trail.

---

## NARROWS — MEDIUM RISK

### 5. `licensed-partner-settled-trust-band` — "Licensed-partner settled" [NARROW]

**Claim (src/app/page.tsx:269):** "Licensed-partner settled."

**Code evidence:** `src/app/admin-dashboard/partners/actions.ts:362-393` creates partners as `status: 'active'` unconditionally. No `licensed` column in `src/db/schema.ts:32-50`. The `isLicensed` field in the application form is optional (`src/app/partners/apply/[token]/actions.ts:67-71`). Settlement code checks only rail config, not partner licensing.

**Suggested fix:** Either add a code-enforced licensing gate on partner activation (e.g., require `isLicensed` attestation before `status: 'active'`), or soften the badge copy to "Partner-settled" without the licensing assertion.

---

### 6. `hmac-signed-settlement-fail-closed` / `hmac-signed-docs` — Outgoing instructions NOT fail-closed on signing [NARROW]

**Claim:** "Every step signed / HMAC fail-closed."

**Code evidence:** `src/lib/outbox-worker.ts:170`: `...(signingSecret ? { 'x-signature': signBody(...) } : {})` — if `signingSecret` is empty, the settlement instruction is sent unsigned with no error. The `http` partner type has no code gate requiring `signingSecret` before going live. Docs say "until your rail acks 2xx" but retries are capped at 8 attempts (`src/db/repos/outbox-repo.ts:33` `MAX_ATTEMPTS = 8`) then dead-lettered.

**Suggested fix:** Require `signingSecret` to be non-empty before a partner with `providerType: 'http'` can be activated. Docs should state "up to 8 retries with exponential backoff; ops alert on dead-letter" rather than "until acks 2xx."

---

### 7. `rate-locked-at-confirm` / `never-holds-funds-showcase` — Rate lock window mismatch and API path not locked [NARROW]

**Claim:** "Rate locked when you confirm."

**Code evidence:**
- `src/lib/tools.ts:187`: approve card says "Rate locked ~10 min."
- `src/lib/draft-store.ts:6`: `DRAFT_TTL_SECONDS = 1800` (30 minutes) — actual window is 3x what is advertised.
- `src/lib/partner-api-service.ts:298-314`: partner REST API (`POST /api/partner/v1/transactions`) always re-quotes live at mint; no rate-lock mechanism exists for the API path.

**Suggested fix:** Change approve card text to "~30 min" to match `DRAFT_TTL_SECONDS`, or reduce the draft TTL to 600s to match the claim. Add a note that the rate-lock applies to the WhatsApp/web chat channel; API-created transactions are priced at live rates at mint time.

---

### 8. `mid-market-rate-no-markup` — Silent fallback and partner margin [NARROW]

**Claim:** "Live mid-market rate, no markup."

**Code evidence:**
- `src/lib/rate.ts:9`: `FALLBACK_FX_RATE = 85` is served silently when Frankfurter is unreachable; no UI disclosure.
- `src/lib/partner-rates.ts:40-41`: `effectiveRateFor()` can return `mid * (1 + rate.marginBps / 10_000)` — a negative `marginBps` yields worse-than-mid for the customer.
- `src/app/page.tsx` `revalidate = 3600`: landing page rate can be up to 1 hour stale.

**Suggested fix:** Add UI disclosure when serving the fallback rate. Guarantee `marginBps >= 0` for any partner claiming mid-market rates to customers (code validation on partner save). Update landing page footnote to "rates updated every 5 minutes" (actual cache TTL) rather than "hourly."

---

### 9. `delivery-notification-both-parties` — Recipients notified at delivery, not departure [NARROW]

**Claim:** "Both get a WhatsApp message when the money is on its way."

**Code evidence:**
- Sender gets Stage 1 ("payment received, on its way") at `beginSettlement()` — at payment capture.
- Recipient gets Stage 2 ("delivered") only after the rail confirms payout — a different event, potentially minutes to hours later.
- Recipient notification is conditional on `recipientPhone` being non-empty (`src/db/schema.ts:78` defaults to `''`); an empty phone produces no notification.

**Suggested fix:** Change copy to "the sender gets an immediate payment confirmation; the recipient is notified when funds are delivered."

---

### 10. `durable-idempotent-about` / `paid-out-webhook-triggers-delivery-notice-docs` — Delivery notifications NOT durable on real rails [NARROW]

**Claim:** "Nothing is silently lost / outbox-backed notifications."

**Code evidence:** `src/app/api/payment-webhook/[provider]/route.ts:106-142`: stage-2 delivery notifications on real rails (`http`/`simulator`) fire inside `after()` — a best-effort Next.js post-response hook, not an outbox row. A serverless function eviction after `updateTransferFromWebhook` but before `after()` completes silently drops both sender and recipient delivery confirmations with no retry path.

**Suggested fix:** Enqueue stage-2 delivery notifications as outbox rows inside the webhook handler transaction (same pattern as the mock rail's `mock.settle`), replacing the `after()` fire-and-forget.

---

### 11. `eight-corridors-any-direction` / `eight-corridors-metadata` / `eight-corridors-overview` — Canada structurally unreachable on default platform [NARROW]

**Claim:** "8 corridors. Any direction."

**Code evidence:** `src/lib/defaults.ts:18`: Canada (`CA`) is deliberately excluded from `DEFAULT_PARTNER_COUNTRIES` — "+1 NANP code shared with US; Canadian number can't be distinguished from US one." `src/lib/partner-currency.ts:7` maps `'1'` → `'US'`. A Canadian WhatsApp user on the default platform is auto-detected as USD. Additionally, `src/lib/types.ts:553-554` documents "destination is always IN in v1" — the product is 7 source countries → India, not 8 peer bidirectional corridors.

**Suggested fix:** Change landing page copy to "7 send corridors, paying out to India today — Canada and additional destinations available via white-label configuration." Update OpenGraph description accordingly.

---

### 12. `partner-api-idempotency-claim` — Crash-replay upsert can mutate existing transfer [NARROW]

**Claim:** "A retry never duplicates a transfer."

**Code evidence:** `src/db/repos/transfer-repo.ts:125-128`: `store.saveTransfer()` uses `onConflictDoUpdate` (upsert). The crash-replay path in `partner-api-service.ts:255-260` falls through to `createTransfer` with the reserved ID. A retry carrying a different request body (different amount, different beneficiary) silently overwrites the live transfer row rather than returning the original — last-write-wins, not idempotent replay.

**Suggested fix:** On crash-replay, compare the incoming request body against the stored idempotency record; if they differ, return 409 Conflict rather than overwriting. Change `saveTransfer` to a plain INSERT for new mints, reserve the upsert path for explicit update operations.

---

### 13. `partner-rate-limit-120rpm` — Fixed-window boundary burst allows ~240 req in 2 seconds [NARROW]

**Claim:** "120 requests/minute rate limit."

**Code evidence:** `src/lib/partner-rate-limit.ts:21-22`: window key is `ratelimit:{partnerId}:{Math.floor(Date.now() / 60_000)}` — a fixed wall-clock minute, not a rolling window. A partner can fire 120 requests in the last milliseconds of minute N and 120 more at the start of minute N+1, achieving ~240 in under 2 seconds. `Retry-After: 60` is hardcoded, not computed from the window boundary.

**Suggested fix:** Switch to a sliding-window rate limiter (Upstash's built-in `Ratelimit` class supports this). If staying with fixed windows, qualify the docs to "up to 120 requests per wall-clock minute; bursts at minute boundaries may allow up to 240 requests in a short interval."

---

### 14. `kyc-persona-ours-mode` — Persona selected by env var, not by kycMode [NARROW]

**Claim:** "Ours mode uses a hosted Persona flow."

**Code evidence:** `src/lib/providers/kyc-provider.ts:53-77`: `getKycProvider()` selects `PersonaKycProvider` when `env.personaApiKey` is set, then falls back to `MockKycProvider` (which returns a link to the admin dashboard). The `ours` kycMode value does NOT directly select Persona. Additionally, `partner-config.ts:49-52`: `requireKycBeforeSend` must be opt-in even within `ours` mode; the default partner has no KYC gate.

**Suggested fix:** In `getKycProvider()`, assert that `env.personaApiKey` is present when `kycMode === 'ours'` and throw a boot-time error if not (similar to `boot-assert.ts` pattern). Qualify docs: "ours mode requires a Persona API key to be configured; without it, the KYC flow degrades to a mock."

---

### 15. `no-app-to-install` — Repeat sends also available via web portal, not WhatsApp-only [NARROW]

**Claim:** "The entire send flow happens in a WhatsApp chat."

**Code evidence:** `src/app/account/chat/page.tsx` and `src/lib/tools.ts:53-66` (`WEB_TOOL_ALLOWLIST`): repeat transfers and payment link generation are available through the web account portal at `/account/chat` without WhatsApp. New-recipient sends require WhatsApp (correctly blocked on web), but the blanket "entire send flow" framing is too broad.

**Suggested fix:** Qualify to "first-time sends start in WhatsApp chat; returning customers can also repeat a past send from their web account."

---

### 16. `demonstration-status-honest-note` — Persona KYC conditionally LIVE, not always simulated [NARROW]

**Claim (src/app/about/page.tsx:220-222):** "Production identity-verification vendor ... simulated today."

**Code evidence:** `src/lib/providers/kyc-provider.ts:68-76`: `getKycProvider()` instantiates a real `PersonaKycProvider` whenever `env.personaApiKey` is set. If `PERSONA_API_KEY` is present in the Vercel environment, the about-page statement would be factually false — there is no code guard preventing divergence between the env state and the page disclosure.

**Suggested fix:** Either add a runtime check that renders a dynamic disclosure (simulated vs. live) based on whether the Persona key is configured, or move the honest-status note to be configuration-driven rather than hardcoded text.

---

### 17. `licensed-partners-keep-funds-partner-section` — Dashboard not autonomously self-service [NARROW]

**Claim (src/app/page.tsx:500-504):** "Self-service dashboard."

**Code evidence:** Partners access the same `/admin-dashboard` as internal staff, scoped via `src/lib/staff-scope.ts`. There is no standalone partner portal. Partners must be provisioned as staff accounts by the platform — no autonomous onboarding or self-service signup path exists.

**Suggested fix:** Change copy to "full-featured partner dashboard" or "partner-scoped dashboard" — remove "self-service" unless a self-provisioning flow is built.

---

### 18. `never-holds-footer-disclaimer` — Rate lock breaks for legacy non-USD drafts [NARROW]

**Claim (src/app/page.tsx:771-775):** "Exchange rates are indicative and locked when you confirm a transfer."

**Code evidence:** `src/lib/transfer-create.ts:153-158`: for legacy non-USD drafts lacking `feeSource`/`totalChargeSource`, `quoteOverrideFromDraft` returns `undefined` and `createTransfer` re-quotes at live FX at pay time. The rate the customer saw when confirming may differ from what is locked on the ledger.

**Suggested fix:** Ensure all drafts carry `feeSource` and `totalChargeSource` before the rate-lock claim can be made unconditionally, or qualify footer: "locked for transfers confirmed in the chat; indicative for legacy flows."

---

### 19. `sanctions-step4-about` — "Before it's ever created" is factually wrong for blocked transfers [NARROW]

(Already covered in the high-risk sanctions cluster above — included here for completeness in the medium-risk group as the sub-claim is narrowly scoped to the about page Step 4 text.)

---

## NARROWS — LOWER RISK (Informational, Disclosure Quality)

### 20. `fee-schedule-first-free-then-flat` — "$1.99 flat" omits debit ($2.99) and credit ($2.99 + 3%) fees [NARROW]

**Claim (src/app/page.tsx:437-439):** "First transfer free, then a flat $1.99 per bank transfer."

The claim names "bank transfer" explicitly, so it is literally true for that method. But `RateCalculator.tsx:86` shows "Fee: $0 on your first transfer, then $1.99" with no disclosure of debit ($2.99) or credit ($2.99 + 3%) paths — a consumer selecting debit or credit card on the same page would not be informed of the higher fee before entering their details.

**Suggested fix:** Add a funding-method selector to the rate calculator that dynamically shows the applicable fee, or add a footnote: "Bank transfer fee; debit card $2.99; credit card $2.99 + 3% processing fee."

---

### 21. `partner-never-receives-money-step3` — "Enter recipient's payout details" skipped on re-opened links [NARROW]

**Claim (src/app/about/page.tsx:137):** "Enter the recipient's payout details."

`src/app/pay/[transferId]/pay-form.tsx:89-91`: `needsBankDetails=false` skips this step for re-opened or scheduled transfers. Also: for b2c funding, the customer pays SmartRemit's PSP seam, not the licensed partner directly — the partner receives a signed settlement instruction, not the funds.

**Suggested fix:** Change Step 3 copy to "confirm the recipient's payout details (pre-filled for repeat sends)."

---

### 22. `encryption-beneficiaries-docs` — Beneficiary name and phone stored in cleartext [NARROW]

**Claim:** "Payout details encrypted at rest" (docs).

`src/db/schema.ts:345,350`: beneficiary `name` and `recipient_phone` are plaintext. Only `payout_destination_enc` (the account number/UPI handle) is encrypted.

**Suggested fix:** Qualify docs to "beneficiary payout account number encrypted at rest; name and phone stored in standard columns."

---

### 23. `delivery-marked-when-rail-confirms` / `rate-locked-about-step5` — Mock provider bypasses signed loop entirely [NARROW]

**Claim (about page):** Signed instruction → signed callback → marked delivered / "rate locked until delivery confirmed."

The about page narrative describes the `http`/`simulator` rail flow but omits that the system-wide default is `MockPaymentProvider`, which self-advances to `delivered` via an internal outbox timer with no signed external confirmation.

**Suggested fix:** The about page's own "Honest Status Note" already qualifies this — ensure the Step 5 description references that note, or add an inline qualifier: "for partners on the live integration path."

---

## Appendix: File-to-Claim Index (most-cited files)

| File | Claims touching it |
|---|---|
| `src/lib/providers/funding-provider.ts:83-85` | non-custodial-design, never-holds-funds-hero, non-custodial-about-hero, smartremit-non-custodial-claim, non-custodial-page-badge |
| `src/lib/providers/sanctions-provider.ts:40-42` | sanctions-always-on-trust-band, sanctions-structurally-impossible-off, sanctions-screening-always-on, sanctions-not-delegable-docs |
| `src/lib/compliance.ts:36-38` | sanctions-structurally-impossible-off, sanctions-screening-always-on, sanctions-screening-claim |
| `src/lib/fx.ts:78-80` | fee-schedule-about-step2 (MISMATCH) |
| `src/lib/outbox-worker.ts:166-172` | hmac-signed-settlement-fail-closed, hmac-signed-docs |
| `src/lib/draft-store.ts:6` | never-holds-funds-showcase, rate-locked-at-confirm |
| `src/app/api/payment-webhook/[provider]/route.ts:106-142` | durable-idempotent-about, paid-out-webhook-triggers-delivery-notice-docs |
| `src/lib/defaults.ts:18` | eight-corridors-any-direction, eight-corridors-overview |
| `src/db/repos/customer-repo.ts` | encryption-at-rest-pii, encryption-aes256-gcm-about |
| `src/lib/audit-log-store.ts` / `src/lib/settlement.ts` | full-audit-trail-trust-band, full-audit-trail-about |

---

*Generated by claims-audit loop · 2026-06-28 · Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>*
