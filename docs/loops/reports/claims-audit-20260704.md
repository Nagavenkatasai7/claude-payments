# Claims-vs-Code Audit — Morning Report
**Date:** 2026-07-04  
**Product:** SmartRemit (smartremit.ai)  
**Scope:** Public marketing copy, about page, docs, landing page, dashboard UI claims cross-referenced against the production codebase.  
**Model:** Claude Opus 4.8 (1M context)

---

## Executive Summary

| Metric | Count |
|---|---|
| Total claims audited | 28 |
| Supported (no gap found) | 0 |
| Narrow (claim true but overstated or conditionally false) | 24 |
| Mismatch (claim directly contradicted by code) | 4 |

**No claim passed without qualification.** Four mismatches carry direct regulatory or consumer-protection exposure. Twenty-four narrows involve real architectural gaps that are not disclosed by the public copy.

---

## HIGH-RISK MISMATCHES

### 1. `licensed-partners-settle` — MISMATCH

**Claim:** Settlement is performed exclusively through licensed money transmitters / licensed partners.

**Code evidence:**

- `src/db/schema.ts:32-50` — The `partners` table has no `licensed` boolean, `licenseNumber`, or any licensing column. `PartnerStatus` (defined at `src/lib/types.ts:543`) is only `'active' | 'suspended'`.
- `src/lib/settlement.ts:34-72` (`beginSettlement`) — checks transfer status and provider type; never checks partner licensing before committing settlement.
- `src/app/admin-dashboard/partners/actions.ts:362-393` (`wizardCreatePartnerAction`) — creates partners with `status: 'active'` immediately; no licensing gate.
- `src/lib/partner-api.ts:47-48` — API auth check tests only `partner.status !== 'active'`; licensing is irrelevant to API access.
- `src/app/partners/apply/[token]/actions.ts:67-71` — the application form collects `isLicensed` (free text, optional) into `partnerApplications.details` jsonb, but `isLicensed` is NOT in the `REQUIRED` array and never flows into the operative `partners` table.

**Risk:** Any unlicensed entity can be created as an active partner and have transfers settled through it. The "licensed" qualifier is a human-process intention with zero code enforcement backstop. For a money-services regulatory context this is a direct exposure: the claim implies a verified invariant.

**Suggested fix (copy):** Remove or qualify the "licensed" qualifier — e.g., "partners who hold the required money transmission licenses in their operating jurisdictions" — and add a note that licensing verification is an onboarding requirement reviewed by the SmartRemit team. **Better fix (code):** Add a `licensed` boolean column with a non-null default of `false`; gate `beginSettlement` to reject partners with `licensed = false`.

---

### 2. `fee-about-page-vague` — MISMATCH

**Claim:** (`src/app/about/page.tsx:134`) "adds a clear, flat fee."

**Code evidence:**

- `src/lib/fx.ts:86-106` — fee schedule has three cases:
  - `bank_transfer` / `ach_pull` / `bank_pull`: `$1.99` flat
  - `debit_card`: `$2.99` flat
  - `credit_card`: `round2(2.99 + 0.03 * amountUsd)` — base charge **plus 3% of the USD send amount**, making it neither flat nor low at larger amounts (e.g., $92.96 at the $2,999 maximum)
- The about page uses "flat fee" with no funding-method qualification; this directly contradicts the percentage-based credit card fee in the enforcing code.
- First-transfer-free (`fx.ts:83-84`) and live mid-market rate (`rate.ts:82`) sub-claims are correctly enforced.

**Risk:** Misrepresenting a variable, percentage-based fee as "flat" is a material consumer-disclosure issue. Regulators (CFPB, FinCEN, state money-transmission examiners) require accurate fee schedules in prepayment disclosure.

**Suggested fix (copy):** Change to "a clear, low fee — $0 on your first transfer, then $1.99 for bank transfers ($2.99 for card payments, plus a small percentage for credit cards)." Alternatively, link to the full fee schedule. **Fix (code — if copy cannot be changed):** Remove credit card as a funding method from the consumer path, or enforce a flat per-card fee.

---

### 3. `corridor-count-8` — MISMATCH

**Claim:** (`src/app/page.tsx` heading and OG metadata) "8 corridors."

**Code evidence:**

- `src/lib/types.ts:511-512` — `CountryCode` union has **10** members, including `HK` and `MX`.
- `src/lib/prompt.ts:27` — live agent system prompt says "10 countries — US, Canada, UK, UAE, Singapore, Australia, New Zealand, India, Hong Kong, and Mexico."
- `src/lib/tools.ts:761` — `capture_corridor_request` tool description explicitly lists "the 10 supported" countries.
- `src/app/partners-action.ts:25` — `ALLOWED_CORRIDORS` server-side Set contains **10** entries.
- `src/app/page.tsx:45` — a comment in the same file reads "The 10 supported corridors + an 'Other' escape hatch."
- HK and MX are fully operational: FX rates in `src/lib/rate.ts:21-22`, payout formats in `src/lib/payout-format.ts:107,112`, phone-prefix routing in `src/lib/partner-currency.ts:7`.
- The landing page `COUNTRIES` array and the heading/OG meta still say "8."

**Risk:** Prospects and regulators reading the site see "8" while the actual product operates with 10. For a financial product, incorrect corridor disclosure affects regulatory filings and marketing material accuracy. Lower severity than #1 and #2 but still a hard factual error.

**Suggested fix (copy):** Update `page.tsx` heading, OG meta, and the COUNTRIES array to reflect 10 corridors. No code change needed — the runtime is already correct.

---

### 4. `corridor-send-receive-all` — MISMATCH

**Claim:** (`src/app/page.tsx:388-392`) "8 corridors. Any direction." and lists Canada.

**Code evidence:**

- `src/app/admin-dashboard/defaults.ts:18` — `DEFAULT_PARTNER_COUNTRIES` explicitly excludes `'CA'` with the comment "Canada is deliberately EXCLUDED: Canada shares the +1 NANP code with the US."
- `src/lib/partner-currency.ts:7` — `'1': 'US'` — any Canadian +1 number is auto-detected as a US/USD sender.
- `src/lib/tools.ts:826-828` (`VALID_COUNTRY_CODES`) — Canada IS included as a destination, so Canada works as a receive corridor.
- Canada is reachable as a destination but **cannot function as a source corridor** on the default platform.
- `src/lib/prompt.ts:27` — agent lists 10 countries, but `VALID_COUNTRY_CODES` only has 8, meaning HK and MX silently fall back to India as destinations.

**Risk:** "Any direction" implies full bidirectionality for every listed country. Canada is receive-only on the default platform. A customer in Canada attempting to send money receives a confusing non-functional experience. The HK/MX silent fallback is a secondary gap.

**Suggested fix (copy):** Qualify the direction claim — "Send from the US to 10 countries; select corridors support two-way transfers." **Code fix:** Either add a phone-number / country-code disambiguation for Canada, or remove Canada from the "any direction" marketing claim.

---

## NARROWS (24 findings)

All findings below represent claims that are true for the primary enforced path but contain documented code-level gaps not disclosed in the public copy. Listed by thematic cluster, highest operational risk first within each cluster.

---

### Custody / Non-Custodial Claims

#### `non-custodial-never-holds` — NARROW

**Claim:** SmartRemit never holds, receives, or disburses customer money.

**Gap:** Enforced for `ach_pull`/`bank_pull` (B2B partner-pulled flows) via `isPartnerPulled()` at `src/lib/funding-method.ts:12-14`. NOT enforced for `credit_card`/`debit_card`/`bank_transfer`: `src/app/api/pay/[transferId]/route.ts:126-133` calls `captureFunding()` for those methods. `src/lib/providers/funding-provider.ts:5-6` explicitly describes the seam as "a PSP/sponsor-bank integration (Plaid + processor, Stripe, …) that charges the SENDER." Today `getFundingProvider()` returns `MockFundingProvider` only, so no real money flows — but the architecture is built to plug in a real PSP which would make SmartRemit the merchant of record.

**Suggested fix:** Qualify the claim to the partner-pulled B2B rails, or add a structural guarantee that PSP settlement goes directly to the partner (not a SmartRemit merchant account) before wiring any real PSP.

---

#### `funds-never-touch-docs` / `funds-never-touch-rail` / `funds-never-touch-agent` — NARROW (three related claims)

**Common gap across all three:** The non-custodial guarantee on the settlement side (signed instruction POST to partner's `settlementUrl`) is architecturally sound. However:

1. Outbound instruction signing is conditional: `src/lib/outbox-worker.ts:170-172` — `...(signingSecret ? { 'x-signature': signBody(...) } : {})`. An unconfigured `signingSecret` causes unsigned instructions to be dispatched silently with no error.
2. Default partner mode (`mock`) bypasses the entire signed-instruction loop.
3. The consumer card/bank_transfer funding-capture seam (`src/lib/providers/funding-provider.ts:83-85`) is mock-only; a real PSP would put SmartRemit in the money path for those flows.

**Suggested fix:** Add a boot-time or partner-creation guard that requires `signingSecret` to be non-empty for any `http`-type partner. Qualify copy to note that real fund movement is executed by the partner rail.

---

#### `not-a-bank-not-transmitter` — NARROW

**Claim:** Not a bank and not a money transmitter.

**Gap:** The non-custodial architecture is genuine and pervasively enforced. However: (1) sender-side funding is mock-only — "licensed partners actually move the funds" on the sender side is not yet backed by real code; (2) "not a money transmitter" is a regulatory determination, not a software assertion — a regulator could classify the entity differently regardless of technical architecture.

**Suggested fix:** Qualify as "designed to operate as infrastructure, not as a money transmitter — confirm your specific regulatory obligations with licensed legal counsel."

---

### Sanctions Screening Claims

#### `sanctions-always-runs` / `sanctions-every-transfer-trust-band` / `sanctions-structurally-impossible-off` / `sanctions-cannot-switch-off-about` / `sanctions-reference-ruleset-not-commercial` — NARROW (five related claims)

**Common structural gaps:**

1. **Recipient screening is unconditional** (confirmed): `src/lib/compliance.ts:35` calls `screener.screen()` on `recipientName` with no guard.
2. **Sender screening is conditional**: `src/lib/compliance.ts:36-38` — `input.senderName ? ... : { matched: false }`. When `senderName` is absent, the sender is not screened at all. This is reachable via:
   - `src/app/api/cron-run.ts:75-87` — scheduled-transfer path never passes `senderName` (comment "sanctions still run" is misleading: only recipient runs)
   - Partner API omitting `sender.name` (`src/lib/partner-api-service.ts:304`)
   - `src/lib/pay-finalize.ts:168` — resolves to `customer.fullName` which is `null` for pre-KYC customers when `requireKycBeforeSend` is false
3. **Backing screener is a prototype mock**: `src/lib/providers/sanctions-provider.ts:26-37` — `getSanctionsScreener()` always returns `MockSanctionsScreener`; `src/lib/compliance-config.ts:6` — `WATCHLIST = ['john doe', 'jane roe', 'test blocked']`. Hits carry `listSource: 'mock-watchlist'`. No real OFAC/SDN feed is wired.
4. **Blocked transfers DO create DB rows** (about page says "stopped before it's ever created"): `src/lib/transfer-create.ts:232` — blocked row is saved before returning.
5. **No real-time human routing**: flagged-in-review transfers generate no immediate ops alert; only `reconcile.ts:86-97` fires after 24 hours of `STALE_REVIEW_HOURS` inactivity.

**Suggested fix:** (a) Fetch and pass `owner.fullName` in the cron path (`cron-run.ts`); (b) add a fail-closed guard in the consumer finalize path matching the B2B guard at `b2b-pay-finalize.ts:171-174`; (c) qualify all public statements with "built-in reference watchlist — commercial OFAC/AML screening activates in production deployment."

---

#### `compliance-screening-422-claim` — NARROW

**Gap:** The partner REST API correctly returns 422 for blocked transfers (`src/lib/partner-api-service.ts:325-327`). However, the pay-page handler (`/api/pay/[transferId]/route.ts:73-75,403-409`) returns **400**, not 422, for a blocked transfer. The "returns 422" assertion is not universal — it belongs only to the partner REST API endpoint. Additionally, `recordBlockedAttempt` in the chat tool's quote-first path (`tools.ts:2806-2832`) is wrapped in a try/catch that swallows failures with `console.warn`.

**Suggested fix:** Normalize the blocked-transfer response to 422 across both the pay route and the partner API, or qualify the claim to "partner API returns 422."

---

### Fee and Rate Claims

#### `fee-first-transfer-free-and-flat-199` — NARROW

**Claim:** First transfer free, then $1.99 flat fee for bank transfers.

**Gap:** The claim is code-enforced for bank transfers. However, `src/app/landing/RateCalculator.tsx:86` — rendered in the same calculator section — says "Fee: $0 on your first transfer, then $1.99" **without the "bank transfer" qualifier**. The full schedule enforced by `fx.ts` includes `debit_card = $2.99` and `credit_card = $2.99 + 3%` of amount. Users reading the calculator reasonably conclude all subsequent transfers cost $1.99.

**Suggested fix:** Update `RateCalculator.tsx:86` to add the "for bank transfers" qualifier and mention that card payments have higher fees, or link to the full fee schedule.

---

#### `no-rate-markup` — NARROW

**Claim:** No rate markup — live mid-market rate.

**Gap:** True for normal operation. Two edge cases:

1. `src/lib/rate.ts:9` — `FALLBACK_FX_RATE = 85` is hardcoded and used during Frankfurter downtime. No UI signal is shown when the fallback is active.
2. `export const revalidate = 3600` (`page.tsx:30`) — landing page rate can be up to 1 hour stale; transfer quoting uses a 5-minute cache (`CACHE_TTL_MS = 300_000`). The "live rate" shown in the calculator may not match the rate quoted at confirmation.

**Suggested fix:** Add a staleness indicator when the fallback rate is active. Reduce landing page `revalidate` to match the 5-minute cache, or add a "rate may be up to X minutes old" disclosure.

---

#### `rate-locked-on-confirm` / `rate-approved-is-rate-used` / `funds-never-touch-agent` (rate-lock sub-claim) — NARROW (three related claims)

**Common gap:** Rate locking is real and enforced for current drafts via `quoteOverrideFromDraft` (`src/lib/transfer-create.ts:90-121`). Gaps:

1. `quoteOverrideFromDraft` returns `undefined` for legacy non-USD drafts lacking `feeSource`/`totalChargeSource` — causing a live re-quote at mint, not the approved rate.
2. The approve card says "Rate locked ~10 min." (`tools.ts:187`) but `DRAFT_TTL_SECONDS = 1800` (`draft-store.ts:6`) = **30 minutes**. Customer-stated window is 3x shorter than actual.
3. The explicit-args branch of `createTransferTool` (`tools.ts:1267-1358`) — cron and cold-start paths — calls `createTransfer` with no quote override; rate is fetched live at mint with no prior lock.
4. `RateCalculator.tsx:95` says "updated hourly" — inconsistent with the 5-minute cache.

**Suggested fix:** (a) Update approve card to say "Rate locked ~30 min" (matching actual TTL); (b) add a guard that rejects/reloads drafts where `feeSource` is absent for the current agent version; (c) align `RateCalculator.tsx` staleness copy with the actual cache TTL.

---

### Encryption and Audit Claims

#### `encryption-aes256gcm-at-rest` — NARROW

**Claim:** AES-256-GCM encryption at rest; PII masked in dashboards; staff reveals are audited.

**Encryption:** Correct and enforced for all named categories (`mappers.ts:91`, `customer-repo.ts:105-109`, `integrations-repo.ts:59-69`).

**Masking gap:** Transfer payout destinations are masked by default (`****<last4>`). However, `src/db/repos/customer-repo.ts:57-69` — `rowToCustomer()` always decrypts with no `decrypt` flag. The customer detail page (`admin-dashboard/customers/[phone]/page.tsx:92-95`) renders `customer.fullName`, `dateOfBirth`, and `residentialAddress` in plain text to any authenticated staff member without masking.

**Audit gap:** `revealDestinationAction` (`admin-dashboard/actions.ts:191-212`) writes `pii.reveal` to `audit_events` for payout destinations only. No audit event exists for customer PII reads (fullName, DOB, address). Every visit to `/admin-dashboard/customers/{phone}` exposes these fields with zero audit trail.

**Suggested fix:** Add a `decrypt` flag to `rowToCustomer()`; mask PII fields in the customer list/detail views by default; add `pii.reveal` audit events for customer PII access — or minimally for `fullName`, `dateOfBirth`, and `residentialAddress`.

---

#### `pii-encrypted-ops-dashboard` — NARROW

**Claim:** Every reveal is audited.

**Gap:** Five unaudited decrypt paths confirmed:

1. `src/lib/sender-names.ts:35` (`resolveSenderNames`) — decrypts customer full legal names from KYC for the transaction detail page; no audit event. The page comment acknowledges "Masked reads only — the audited reveal path is never invoked here" yet the full name is still surfaced.
2. `src/lib/outbox-worker.ts:152` — decrypts full payout destination to build the settlement instruction; no audit event.
3. `src/lib/outbox-worker.ts:231` — decrypts full payout destination for refund/reverse instruction; no audit event.
4. `src/lib/aux-repos.ts:74` (`listRecipients`) — always decrypts full payout destinations from saved-recipient book; called in the AI agent and customer account page; no audit event.
5. `tools.ts:2970` — calls `getTransferDecrypted` to hydrate a repeat-transfer payout destination for the agent; no audit event.

**Suggested fix:** Qualify to "staff UI reveals of payout destinations are audited" — or add audit events to the settlement worker and agent decrypt paths (noting these are system reads, not staff reveals, so a different audit action type may be appropriate).

---

### Settlement and Delivery Claims

#### `delivery-signed-callback` / `settlement-hmac-signed-fail-closed` — NARROW (two related claims)

**Claim:** Instructions out are HMAC-signed; callbacks in are verified fail-closed.

**Inbound:** Fully enforced. `src/lib/providers/payment-webhook-verify.ts:18` returns `false` if key or signature is empty. Called at all three webhook entry points.

**Outbound gap:** All three outbound signing sites (`outbox-worker.ts:170-172`, `http-payment-provider.ts:197-200`, `outbox-worker.ts:200-204`) use `...(signingSecret ? { 'x-signature': ... } : {})`. An empty `signingSecret` causes an **unsigned** instruction to be dispatched to the partner rail with no error thrown and no delivery failure. The claim "instructions out are HMAC-signed" overstates — signing is conditional on operator configuration.

**Suggested fix:** Add validation at partner creation/activation time that rejects `http`-type partners with an empty `signingSecret`, or add a warn/error in the outbox worker when an instruction is dispatched unsigned.

---

#### `delivery-wa-both-parties` — NARROW

**Claim:** Both sender and recipient are notified via WhatsApp when the money is on its way.

**Gap:**

1. Stage 1 (`settlement.ts:48-51`) notifies **the sender only** when payment is received. The recipient is notified only at Stage 2 (delivery), not "on its way."
2. Recipient notification is conditional on `recipientPhone` being non-empty. `src/db/schema.ts:78` sets `recipientPhone .notNull().default('')` — transfers without a stored recipient phone produce no recipient notification.

**Suggested fix:** Qualify to "the sender is notified when the transfer is initiated; both sender and recipient are notified on delivery, when a recipient phone number is on file."

---

### Operational Claims

#### `full-audit-trail` — NARROW

**Claim:** Full audit trail.

**Gap:** The `audit_events` table (Postgres, append-only) is written for staff team mutations, PII reveals, partner API-key actions, ops retry/dismiss, B2B invoice lifecycle, and AI copilot events. However, the three most operationally significant event types write **zero** audit entries:

- `src/lib/transfer-create.ts` — no calls to `createAuditRepo` on transfer mint
- `src/lib/settlement.ts` (`beginSettlement`) — no calls to `createAuditRepo` on settlement commit
- `src/lib/pay-finalize.ts` — no calls to `createAuditRepo` on pay finalization

KYC case events are written to Redis (`kyc_audit:{phone}` in `kyc-case-store.ts:36-46`), not Postgres, and the display page explicitly downgrades them to "non-critical UI."

**Suggested fix:** Either scope the claim ("audit trail for staff actions and partner API access") or add `audit_events` writes to the transfer mint, settlement commit, and finalize paths before asserting "full."

---

#### `partner-api-rate-limit-120rpm` — NARROW

**Claim:** Partner API is rate-limited to 120 requests/minute.

**Gap:** `src/lib/partner-rate-limit.ts:13` — `DEFAULT_LIMIT_PER_MIN = 120`. All 8 `/api/partner/v1/*` routes call `guardPartner` first. However, the implementation (`partner-rate-limit.ts`) uses a **fixed window** (key: `ratelimit:${partnerId}:${Math.floor(Date.now()/60_000)}`). A partner can send 120 requests at second 59 of window N and 120 more at second 0 of window N+1 — 240 requests within ~2 seconds — achieving a 2x burst of the stated limit at every minute boundary. The `Retry-After` header is hardcoded to `60` regardless of remaining window time.

**Suggested fix:** Replace with a sliding-window implementation (e.g., Upstash `ZADD`/`ZCOUNT` pattern already used elsewhere) and compute `Retry-After` dynamically from the oldest token in the window.

---

#### `claim-idempotency-key-required` — NARROW

**Claim:** Idempotency key is required; duplicate mints are prevented via claim-first insert.

**Gap:** The header-required guard and `INSERT … ON CONFLICT DO NOTHING` are correctly implemented. However:

1. The replay branch (`src/lib/partner-api-service.ts:258-259`) returns `ok(200, …)` for any found transfer, **including compliance-blocked ones**, while the original mint path (`lines 325-326`) returns `err(422, …)` for the same blocked transfer. First call returns 422; retry with identical key returns 200. HTTP status is not idempotent for the blocked-compliance case.
2. Concurrent window: two simultaneous requests both passing the null-check before either `saveTransfer` completes both fall through to `createTransfer`; `saveTransfer`'s `onConflictDoUpdate` lets the second overwrite the first with a different FX snapshot while velocity counters are incremented twice.

**Suggested fix:** In the replay branch, check `transfer.status === 'blocked'` and return the appropriate 422 response to match the original call. Add a select-for-update or advisory lock around the claim-check and insert to close the concurrent race window.

---

#### `simulation-disclosure` — NARROW

**Claim:** (`src/app/about/page.tsx:221`) "A note on where we are today" — AI conversation, live FX quoting, signed instruction loop, durable processing, and WhatsApp notifications are real; fund movement and sanctions screening are simulated.

**Gap:** The disclosure is accurate for five of six "real" components and all three simulated components. The single gap: KYC vendor status is runtime-conditional. `src/lib/providers/kyc-provider.ts:53-77` returns `PersonaKycProvider` when `env.personaApiKey` is non-empty; the mock is only the else branch. `src/lib/boot-assert.ts:11-20` — `PERSONA_API_KEY` is NOT in `REQUIRED_PRODUCTION_VARS`. If the env var is set in production, a real identity-verification vendor is live without any code change — the "simulated today" language for KYC vendor becomes inaccurate without updating the disclosure.

**Suggested fix:** Either add a boot-time check that logs/alerts when `PERSONA_API_KEY` is present (signaling the disclosure must be updated), or make the disclosure conditional on env configuration rather than a static text statement.

---

## Findings Matrix

| ID | Status | Risk Area | Severity |
|---|---|---|---|
| `licensed-partners-settle` | MISMATCH | Regulatory / Partner onboarding | Critical |
| `fee-about-page-vague` | MISMATCH | Consumer disclosure / Fee schedule | Critical |
| `corridor-count-8` | MISMATCH | Marketing accuracy / Regulatory filing | High |
| `corridor-send-receive-all` | MISMATCH | Corridor claims / Consumer UX | High |
| `non-custodial-never-holds` | NARROW | Custody architecture | High |
| `sanctions-always-runs` (cron path) | NARROW | AML/Compliance | High |
| `sanctions-every-transfer-trust-band` | NARROW | AML/Compliance | High |
| `sanctions-structurally-impossible-off` | NARROW | AML/Compliance | High |
| `sanctions-cannot-switch-off-about` | NARROW | AML/Compliance | High |
| `sanctions-reference-ruleset-not-commercial` | NARROW | AML/Compliance | High |
| `encryption-aes256gcm-at-rest` | NARROW | Data protection / GLBA | High |
| `pii-encrypted-ops-dashboard` | NARROW | Data protection / audit | High |
| `full-audit-trail` | NARROW | Compliance traceability | High |
| `funds-never-touch-docs` | NARROW | Custody / PSP seam | Medium |
| `funds-never-touch-rail` | NARROW | Custody / PSP seam | Medium |
| `funds-never-touch-agent` | NARROW | Custody + Rate lock | Medium |
| `not-a-bank-not-transmitter` | NARROW | Regulatory classification | Medium |
| `compliance-screening-422-claim` | NARROW | API contract | Medium |
| `settlement-hmac-signed-fail-closed` | NARROW | Settlement integrity | Medium |
| `delivery-signed-callback` | NARROW | Settlement signing | Medium |
| `delivery-wa-both-parties` | NARROW | Customer communication | Medium |
| `fee-first-transfer-free-and-flat-199` | NARROW | Consumer disclosure | Medium |
| `no-rate-markup` | NARROW | Rate accuracy | Low |
| `rate-locked-on-confirm` | NARROW | Rate-lock integrity | Low |
| `rate-approved-is-rate-used` | NARROW | Rate-lock integrity | Low |
| `partner-api-rate-limit-120rpm` | NARROW | API security / abuse prevention | Low |
| `claim-idempotency-key-required` | NARROW | API correctness | Low |
| `simulation-disclosure` | NARROW | Honest status / disclosure | Low |

---

*Report generated by claims-audit loop. This report is READ-ONLY — no production code or marketing copy was modified. All file references are relative to the repository root.*
