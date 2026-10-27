# Claims-vs-Code Audit — 2026-07-07

**Repo:** Nagavenkatasai7/claude-payments
**Branch audited:** main
**Claims extracted:** 65
**Mismatches (HIGH RISK):** 7
**Narrow:** 54
**Supported:** 3
**Unverifiable:** 1

---

## HIGH RISK — Mismatches

### 1. `eight-corridors-any-direction` — `src/app/page.tsx`

**Claim:** "8 corridors. Any direction."

**Evidence:** Canada appears in the landing page carousel but `src/lib/defaults.ts:18` explicitly excludes it (`CA` deliberately excluded — NANP ambiguity). India is coded as a destination-only endpoint: `src/lib/compliance-config.ts:41-42` states `if (sourceCountry === 'IN') return GLOBAL_DEFAULTS` with the comment "IN is the payout side; it is never a corridor source." Two of the eight displayed countries are structurally non-functional as sources.

**Suggested fix:** Remove Canada and India from the bidirectional corridor carousel, or add inline asterisks. The header copy should read "US → India today, more corridors coming" (matching CLAUDE.md's own framing of the product as "US→India (multi-corridor capable)").

---

### 2. `send-receive-all-listed-countries` — `src/app/page.tsx`

**Claim:** "Send and receive between all of these — tap a country to start the chat."

**Evidence:** Canada is the second country tile displayed, yet `src/lib/defaults.ts:18` deliberately excludes `CA` with comment "CAD would be unreachable by phone detection." `src/lib/partner-currency.ts:7` maps calling code `+1` to `US` only; a Canadian number is resolved as a US sender. Tapping the Canada tile routes to the default partner where Canada is unsupported.

**Suggested fix:** Remove Canada from the public-facing carousel for the default platform, or add a tooltip clarifying white-label partner configuration is required for CAD corridors.

---

### 3. `meta-description-8-corridors` — `src/app/page.tsx`

**Claim:** "Non-custodial remittance infrastructure across 8 corridors." (OpenGraph / meta description)

**Evidence:** The same source file (`page.tsx:45`) has a comment "10 supported corridors + Other"; `PARTNER_CORRIDORS` (lines 47–59) lists HK and MX in addition to the 8 displayed. `src/lib/types.ts:512` defines `CountryCode` with 10 entries. `src/lib/defaults.ts:18` shows `DEFAULT_PARTNER_COUNTRIES` includes HK and MX (9 entries). The metadata saying "8" is stale relative to the rest of the codebase.

**Suggested fix:** Update `page.tsx` meta description to "10 corridors" or align the UI carousel to show all 10.

---

### 4. `about-pillar-full-audit-trail` — `src/app/about/page.tsx`

**Claim:** "Full audit trail: KYC decisions, blocked attempts and sensitive-data reveals are written to an append-only, per-partner audit log."

**Evidence:**
1. `markCustomerVerifiedAction` and `markCustomerRejectedAction` (`src/app/admin-dashboard/customers/actions.ts:20,159`) — both active UI buttons on the customer detail page — write NO audit entry to any store.
2. All partner management mutations (`src/app/admin-dashboard/partners/actions.ts`, 443 lines) have zero audit calls.
3. `reviewKycAction` routes through `kyc-case-store.review()` which writes only to a Redis hash (`kyc_audit:{phone}`), not the durable Postgres `audit_events` table. The module comments "Durable-beyond-Redis export of the audit log is a Phase-5 concern."
4. Blocked attempts are stored in the `transfers` ledger (not `audit_events`).

**Suggested fix:** Add `audit_events` writes to `markCustomerVerifiedAction` and `markCustomerRejectedAction`. Migrate `kyc-case-store` audit writes to Postgres. Change claim to "KYC review decisions and payout-destination reveals are audited" until partner management actions are instrumented.

---

### 5. `about-pillar-self-service-dashboard-scope` — `src/app/about/page.tsx`

**Claim:** "Self-service dashboard: Transactions, stuck-money recovery, compliance and KYC review, analytics, rates, team and API keys — scoped to your tenant."

**Evidence:** Four of the eight listed features are inaccessible to partner-scoped staff:
- **Stuck-money recovery (Ops):** `/admin-dashboard/ops/page.tsx:42` — `if (scope.kind !== 'platform') redirect('/admin-dashboard')`. Platform-only, explicitly commented.
- **Rates:** `/admin-dashboard/rates/page.tsx:59-61` — `if (scope.kind !== 'platform') redirect('/admin-dashboard')`. Comment: "partner-scoped staffer must never see a rival's rates."
- **Team:** `/admin-dashboard/team/page.tsx:143` — `await requirePlatformAdmin()`.
- **API keys:** `/admin-dashboard/api-keys/page.tsx:27` — `await requirePlatformAdmin()`.

**Suggested fix:** Remove "stuck-money recovery," "rates," "team," and "API keys" from the partner-facing feature list on the about page, or qualify that these are platform-admin features. Partner team management is available as a sub-tab on `/admin-dashboard/partners/[id]/`.

---

### 6. `docs-what-is-real-vs-simulated` — `docs/SMARTREMIT-PLATFORM-OVERVIEW.md`

**Claim:** "Real, production-grade: the AI conversation, live FX, sanctions/compliance screening, the signed instruction → signed callback loop (HMAC both ways, fail-closed)..."

**Evidence:**
1. **Sanctions screening is explicitly a mock.** `src/lib/providers/sanctions-provider.ts:40-42`: `getSanctionsScreener()` always returns `MockSanctionsScreener`. The watchlist is `['john doe', 'jane roe', 'test blocked']` (`src/lib/compliance-config.ts:6`), described in-source as "Mock sanctions/watchlist — clearly fake names for the prototype." There is no integration with OFAC SDN, ComplyAdvantage, Sanctions.io, or any real feed.
2. **Outbound HMAC signing is conditional, not fail-closed.** `src/lib/outbox-worker.ts:170-172`: `...(signingSecret ? { 'x-signature': signBody(...) } : {})`. An unconfigured `signingSecret` sends the instruction unsigned with no sending-side rejection.

**Suggested fix:** Move sanctions screening from the "real, production-grade" list to the simulated list. Add "outbound instruction signing is conditional on partner `signingSecret` configuration" as a qualification to the HMAC claim.

---

### 7. `docs-otp-argon2id-pwned-password-check` — `docs/SYSTEM-ARCHITECTURE.md`

**Claim:** "Customer auth (AAL2): Argon2id + pepper passwords, pwned-password check, enumeration-safe login/reset, two-factor binding: sessions minted only by OTP verify consuming a single-use pending-auth token whose phone comes from the token, never the form"

**Evidence:** `src/app/account/actions.ts:192-215` contains the comment "Password-only login (owner decision 2026-06-12): the OTP second factor was removed from LOGIN." For any verified account, `loginAction` calls `auth.createSession(phone)` and sets the cookie directly after password verification — no OTP step, no pending-auth token. The pending-auth + OTP flow exists only for the register flow (first-time phone binding). The system is AAL1 for login, not AAL2.

**Suggested fix:** Update the architecture doc to describe login as "AAL1 (password only) with phone number binding enforced at registration (AAL2 for account creation)." Either restore OTP to the login path or correct the docs before sharing with regulators or partners in due diligence.

---

## Narrow — Needs Qualification

The following 54 claims are directionally accurate but overstate coverage, use absolute language that the code cannot fully guarantee, or have documented exception paths. Each needs a qualifying phrase before it can be used in partner contracts, regulatory filings, or due-diligence materials.

### Consumer / Landing Page (`src/app/page.tsx`)

| ID | Claim | Key qualification needed |
|----|-------|--------------------------|
| `non-custodial-badge` | Non-custodial remittance infrastructure | True for B2B partner-pulled flows and settlement side; for B2C card/bank_transfer the `FundingProvider.capture()` seam is designed for a real PSP that could create a custody window |
| `licensed-partner-settles-hero` | Every step signed, screened, and audited | Signing is conditional on `signingSecret` config; "audited" covers staff actions and PII reveals, not the core money path |
| `non-custodial-by-design` | Non-custodial by design | Code comment at `pay/[transferId]/route.ts:136` says "Funds captured above; hold for manual review" on the flagged-compliance path; `releaseTransfer()` never calls `beginSettlement()` for HTTP partners |
| `licensed-partner-settled-trust-band` | Licensed-partner settled | "Licensed" is not code-enforced; any active partner (no license gate) can receive settlement instructions |
| `sanctions-every-transfer-trust-band` | Sanctions screening on every transfer | Recipient screening is unconditional; sender screening silently skips when `senderName` is undefined on the B2C partner API path |
| `full-audit-trail-trust-band` | Full audit trail | `audit_events` covers staff actions and PII reveals; money path transitions (creation, paid flip, delivery) are NOT in the audit log |
| `agent-never-holds-funds` | Locks the live mid-market rate and holds it for you | Lock window is 30 min (code) but UI says "~10 min"; legacy non-USD drafts without `feeSource`/`totalChargeSource` fall back to a live re-quote |
| `pii-encrypted-at-rest-ops-showcase` | Every reveal is written to the audit log | Only transfer payout-destination reveals are audited (`pii.reveal`); customer fullName, DOB, address, govId are decrypted on every admin page load with no audit entry |
| `settlement-instruction-funds-never-touch` | Signs an instruction to your rail | Signing is conditional on `signingSecret`; mock provider (the default) uses a state-machine simulation with no signed instruction |
| `sanctions-structurally-impossible-switch-off` | Structurally impossible to switch off, in every KYC mode | True for invocation; sender-side screening is not fail-closed on the B2C partner API path when `senderName` is omitted |
| `agent-never-holds-funds` | Locks the live mid-market rate | Rate is locked for one-time transfers via approve-card + pay-link; scheduled/cron transfers re-quote live at execution time |
| `partner-offering-branded-bot-pay-page-webhooks-api-dashboard` | Self-service dashboard | Partner onboarding requires SmartRemit admin provisioning; no self-signup path exists in code; signed webhooks conditional on `signingSecret` |
| `footer-never-holds-receives-disburses` | Never holds, receives, or disburses | "Never receives" is unverifiable for production — entire B2C sender-side funding layer is `MockFundingProvider`; rate locking has code-documented exceptions |

### About Page (`src/app/about/page.tsx`)

| ID | Claim | Key qualification needed |
|----|-------|--------------------------|
| `about-not-bank-not-mtt` | We never hold your money | Settlement side is code-enforced; inbound funding custody depends on PSP configuration (currently mock-only) |
| `about-step2-locked-rate-no-hidden-markup` | A clear, flat fee | Credit card fee is `$2.99 + 3% of amount` — not flat; the "flat fee" claim is false for credit card users |
| `about-step3-never-receives-holds` | Pay the licensed partner | Customer pays a PSP intermediary, not the licensed partner directly; partner receives a signed settlement instruction |
| `about-step4-sanctions-cannot-be-switched-off` | Stops the transfer before it's ever created | Blocked transfers ARE persisted as DB rows (status='blocked') — this is correct audit practice but contradicts the claim wording |
| `about-step5-cryptographically-signed-instruction` | Cryptographically signed settlement instruction | Outbound signing conditional on `signingSecret`; mock rail (default sandbox) uses a pure state machine with no signed instruction |
| `about-step6-whatsapp-notification-both-parties` | Both get a WhatsApp message when money is on its way | Stage 1 (settlement) only notifies sender; recipient notification fires at Stage 2 (delivery) and only if `recipientPhone` is on file |
| `about-step6-track-repeat-refund-same-chat` | Request a refund from the same chat | Refund request only flags for ops review (no automatic money movement); recall disputes have no recovery guarantee |
| `about-pillar-non-custodial-signed-instructions-only` | Only ever produce signed instructions | B2C card/bank_transfer path has a `captureFunding()` seam designed for PSP integration; currently mock-only |
| `about-pillar-licensed-partners-move-money` | Licensed partners move the money (present tense) | All active rails are SmartRemit's own mock or simulator; no live licensed-partner rail connected; page discloses this in a separate lower section |
| `about-pillar-aes256gcm-encrypted-at-rest` | Customer data masked in dashboards; staff reveals are audited | Customer fullName, DOB, residential address rendered in full on admin page with no audit entry; only payout-destination reveals are audited |
| `about-pillar-outbox-nothing-silently-lost` | Nothing is silently lost | "Delivered" status WhatsApp notifications run in best-effort `after()` with no outbox enqueue; a serverless crash permanently drops delivery confirmations |
| `about-pillar-hmac-signed-webhooks-fail-closed` | Instructions out and callbacks in are HMAC-signed fail-closed | Outbound signing is conditional on `signingSecret`; mock provider callback path bypasses HMAC verification |
| `rest-api-idempotent-transfers` | Retry never duplicates a transfer | Transfer row deduplication is correct; but Redis daily-velocity `INCR` is not covered by idempotency logic — concurrent first-request race inflates compliance counters |
| `about-honest-status-fund-movement-simulated` | Production identity-verification vendor... simulated today | KYC and live-rail exclusions depend on runtime env vars and DB config — code supports real Persona KYC; whether it's active in production is unverifiable |
| `branded-whatsapp-agent-pay-page` | Branded pay page | Partners with HTTPS logo URLs (back-compat path) get their logo blocked by enforced CSP `img-src 'self' data: blob:`; broken-image icon shown instead of text fallback |
| `sanctions-always-on` | Sanctions always on in every mode | Sender-side screening fails open when `fullName` is null for delegated-partner consumers; scheduled-transfer (cron) path never passes `senderName` |

### Docs (`docs/SMARTREMIT-PLATFORM-OVERVIEW.md`, `docs/SYSTEM-ARCHITECTURE.md`)

| ID | Claim | Key qualification needed |
|----|-------|--------------------------|
| `docs-non-custodial-never-touches-holds-routes` | Never touches, holds, or routes money | B2C `captureFunding()` seam exists; absolute "never" only holds while `MockFundingProvider` is the sole implementation |
| `docs-no-app-to-install` | Entire send flow happens in a WhatsApp chat | Web account portal, B2B checkout, and partner REST API are additional send channels outside WhatsApp |
| `docs-multi-corridor-us-canada-uk-uae-sg-au-nz-india` | Sends from US, Canada, UK, UAE, SG, AU, NZ | Canada excluded from `DEFAULT_PARTNER_COUNTRIES`; HK and MX omitted from claim but operational in defaults |
| `docs-sanctions-always-on-in-both-kyc-modes` | Structurally impossible to toggle off | Cron/scheduled-transfer path (`cron-run.ts:75-87`) never passes `senderName`; sender screening silently skips on every scheduled transfer |
| `docs-live-fx-locked-quote-one-tap-pay-link` | One-tap secure payment link | Pay page always requires OTP verification + bank details for first-time recipients — minimum 3–5 user interactions |
| `docs-whatsapp-notifications-both-sender-and-recipient` | Notifications to both sender and recipient | Recipient notification conditional on `recipientPhone` being non-empty; partner API path makes it optional; delivery notification runs in best-effort `after()` |
| `docs-self-service-portal-history-receipts-repeat-refund` | Self-service portal for repeat sends and refunds | "Repeat" from portal requires AI chat widget (no UI shortcut button); "refunds" only flags for human-ops review, never moves money |
| `docs-t0-caps-500-transfer-500-day` | T0 capped at $500/transfer and $500/day | Partner REST API path (`partner-api-service.ts`) calls `createTransfer` without `evaluateCap` — T0 caps not enforced on programmatic partner API |
| `docs-t1-caps-2999-transfer-2999-day` | T1 capped at $2,999/transfer and $2,999/day | Same gap: partner REST API bypasses `evaluateCap` entirely |
| `velocity-limit-claim` | More than 5 transfers/day flags for review | Per-partner `corridorCompliance.velocityLimit` overrides the default; fixed-epoch-minute Redis bucket allows burst of 10 on minute boundary |
| `large-amount-flag-review` | Transfers at/above ~$1,000 flagged for review | `confirmTransaction` in `partner-api-service.ts:373` checks `complianceStatus === 'blocked'` but NOT `'flagged'`; a partner can confirm a $1,000+ flagged transfer directly to settlement |
| `docs-edd-trigger-3000-rolling-month` | Rolling-month volume reaches ~$3,000 | Counter key uses `easternMonth(Date.now())` — calendar-month reset, NOT a trailing 30-day sliding window; month-boundary bypass possible |
| `field-encryption-claim` | AES-256-GCM encrypted at rest | True for Postgres; `draft-store.ts:16` writes full `Draft` (including `recipientLegalName` and `payoutDestination`) as plain JSON to Redis with 30-min TTL |
| `docs-kyc-human-approved-only-strict-invariant` | Only a human operator can set a customer to verified or rejected | `markCustomerVerifiedAction` / `markCustomerRejectedAction` bypass `kyc-case-store.review()` and do NOT set `kycReviewState` to a terminal value, leaving the Persona-webhook terminal guard unapplied |
| `docs-kyc-modes-ours-persona-delegated` | "ours" mode uses Persona; "delegated" mode lets partner run KYC | `kycMode` is a display label only; all actual gate/provider logic pivots on `requireKycBeforeSend` and Persona API key presence — a partner in "ours" mode with `requireKycBeforeSend=false` has no KYC gate |
| `docs-fx-locked-at-quote-never-re-prices` | FX locked at quote time; never silently re-prices | Scheduled/cron transfers re-quote live at execution time with no customer pre-approval of a specific rate |
| `docs-reconciliation-stuck-paid-15min-re-instruct` | Paid-but-not-settled > 15 min (re-instructed once) | Re-instruction only fires for `providerType === 'http' \|\| 'simulator'`; mock-rail partners receive only an ops alert |
| `docs-per-ip-rate-limits-fail-open` | Fail-open: a limiter outage never blocks payments | `checkPartnerRateLimit` (partner REST API) has no fail-open semantics — Redis outage propagates as 500, not pass-through; pay-page step-up OTP has no dedicated per-IP limit |
| `docs-partner-api-endpoints` | POST /transactions/:id/confirm — flip to paid + signed instruction | Signed `settlement.instruct` outbox row only produced for `http`/`simulator` providers; mock/sandbox provider uses `mock.settle` instead — no signed instruction |
| `rate-limit-120-per-min-partner` | Rate limit 120 req/min/partner | Fixed epoch-minute window allows burst of up to 240 requests straddling a minute boundary; sliding-window guarantee not provided |
| `docs-bot-bank-details-never-in-chat` | Bank details are never collected in chat | True and structurally enforced for the approve-card flow; `create_transfer` and `create_schedule` tool schemas expose `payout_destination` as an optional parameter with only prompt-level prohibition |
| `claim-delivery-guarantee-heartbeat` | Delivery guarantee via GitHub Actions heartbeat every 5 minutes | `CRON_SECRET` missing from GitHub Actions secrets silently causes every heartbeat to return 401 with no code-level guard; GitHub scheduled workflows are documented as best-effort |
| `docs-claim-first-crash-replay-no-duplicate` | Crash-replay re-mints same transfer rather than a duplicate | True for partner API and pay-page finalization paths; WhatsApp conversational approve-button tap (`tools.ts:1165`) consumes the draft BEFORE minting — inverting the safe order |
| `docs-best-rate-routing-customer-sees-better-rate` | Customer only ever sees the better rate; routing is internal | Best-rate routing gated exclusively to default-tenant (`partner.id !== DEFAULT_PARTNER_ID` returns null); white-label partner customers are pinned to their partner with no multi-partner competition |
| `docs-404-never-403-tenant-isolation` | Every partner-scoped query filtered by partnerId | Behavioral isolation is correct; several paths (`getTransaction` in `partner-api-service.ts`, `scoped-store.ts getTransfer/listCustomers/listSchedules`) do unscoped DB fetch + application-layer ownership check, not SQL-level WHERE filtering |
| `about-pillar-hmac-signed-webhooks-fail-closed` (duplicate) | Signed settlement webhooks | (See above; outbound conditional on `signingSecret`) |
| `docs-what-is-real-vs-simulated` (sanctions sub-claim) | Sanctions/compliance screening | (Covered in Mismatch #6 above) |

---

## Supported

Three claims survived adversarial tracing with no material qualifications needed:

| ID | Claim | Key evidence |
|----|-------|--------------|
| `smartremit-fee-claim-v1` | No markup baked into the rate; first transfer free; flat $1.99 per bank transfer | `getFxRates()` returns raw Frankfurter mid-market with zero spread; `fx.ts:82-83` sets `feeUsd=0` when `transferCount===0`; flat $1.99 bank_transfer hard-coded at `fx.ts:88` |
| `security-headers-claim` | HSTS 2y preload, nosniff, X-Frame DENY, Referrer-Policy, Permissions-Policy, enforced CSP | `next.config.ts:6-43` applies headers unconditionally via `source: '/:path*'`; no env-var bypass, no vercel.json override; CSP is enforced (not report-only) |
| `boot-assert-production-claim` | Production refuses to boot if money-grade secrets are missing | `instrumentation.ts register()` runs before first request; gates on `VERCEL_ENV=production && NODE_ENV=production`; shape validation mirrors exactly what `field-crypto.ts` accepts |

---

## Unverifiable

| ID | Claim | Reason |
|----|-------|--------|
| `docs-refund-3-5-business-days` | "Once approved, money returns to the original payment method in 3-5 business days" | The refund path delegates entirely to `MockFundingProvider` (the only implementation); 3-5 business day timing is a card-network convention that no application-layer code can enforce or verify. Becomes verifiable only when a real PSP is integrated. |

---

## Summary by Source

| Source | Total | Mismatch | Narrow | Supported | Unverifiable |
|--------|-------|----------|--------|-----------|--------------|
| `src/app/page.tsx` | 17 | 3 | 13 | 1 | 0 |
| `src/app/about/page.tsx` | 18 | 2 | 15 | 1 | 0 |
| `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` | 20 | 1 | 19 | 0 | 0 |
| `docs/SYSTEM-ARCHITECTURE.md` | 10 | 1 | 7 | 1 | 1 |
| **Total** | **65** | **7** | **54** | **3** | **1** |

---

## Top Priorities for Remediation

Based on regulatory risk to a money-services business:

1. **[CRITICAL] `docs-otp-argon2id-pwned-password-check`** — Architecture doc claims AAL2; login is AAL1 since 2026-06-12 code change. Correct docs before any regulator or partner due-diligence review.
2. **[CRITICAL] `docs-what-is-real-vs-simulated`** — Calling `MockSanctionsScreener` (watchlist: "john doe", "jane roe", "test blocked") "production-grade compliance screening" is a material falsehood for a regulated financial platform.
3. **[HIGH] `about-pillar-full-audit-trail` / `full-audit-trail-trust-band`** — Active KYC approve/reject UI paths leave no audit record. Add `audit_events` writes to `markCustomerVerifiedAction` and `markCustomerRejectedAction`.
4. **[HIGH] `large-amount-flag-review`** — Partner REST API `confirmTransaction` missing `complianceStatus === 'flagged'` check allows a $1,000+ flagged transfer to bypass the manual review hold and settle directly.
5. **[HIGH] `about-pillar-self-service-dashboard-scope`** — Four of eight listed features (ops, rates, team, API keys) are platform-admin only. Misrepresents the partner dashboard offering.
6. **[HIGH] `docs-edd-trigger-3000-rolling-month`** — "Rolling-month" is a calendar-month reset (Eastern time), not a trailing 30-day window. Month-boundary bypass can double the effective EDD threshold.
7. **[HIGH] `eight-corridors-any-direction` / `send-receive-all-listed-countries`** — Canada listed as available but structurally excluded. India displayed as bidirectional but coded as destination-only.

---

*Generated by claims-vs-code-audit workflow (session 20260707). Read-only — does not modify code or copy. Do not merge this PR without reviewing and acting on the HIGH RISK mismatches.*
