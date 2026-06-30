# Claims-vs-Code Audit — Morning Report
**Date:** 2026-06-30  
**Auditor:** Claude Opus 4.8 (1M context), automated loop  
**Scope:** All public-facing and partner-facing copy vs. enforcing code paths

---

## Summary

| Category | Count |
|---|---|
| Total claims audited | 37 |
| Supported (code provably delivers) | 3 |
| Narrow (claim is directionally true but overstated) | 32 |
| Mismatch (claim is factually false or structurally unenforceable) | 2 |

---

## HIGH-RISK MISMATCHES

These two findings describe public-facing claims that are **factually false** or **meaningfully misleading** for a licensed money-transmission product.

---

### MISMATCH 1 — "8 corridors, any direction" (`8-corridors-any-direction`)

**Claim text (src/app/page.tsx:33–42 COUNTRIES chip array + landing copy):**
> Eight corridor tiles shown in both directions; Canada displayed as an equal routing destination.

**Code evidence:**
- `src/lib/defaults.ts:18`: `DEFAULT_PARTNER_COUNTRIES = ['US', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']` — Canada (`CA`) is **excluded** with an explicit comment: "Canada shares the +1 NANP code with the US … CAD would be unreachable by phone detection."
- `src/lib/types.ts:462–463`: `CountryCode` includes `'CA'` but `defaults.ts:18` removes it from the operational set.
- `src/lib/defaults.ts:6`: `DEFAULT_DESTINATION_COUNTRY = 'IN'` — unknown destinations silently fall back to India.
- `src/lib/tools.ts:809–813`: unknown destination falls back to `'IN'`, so a Canadian sender reaching the default bot is silently treated as a US→India sender.
- CLAUDE.md explicitly states the launched corridor is "US→India (multi-corridor capable)" — i.e., multi-corridor is a roadmap item, not a live reality.

**Risk:** A customer in Canada taps the Canada tile on the landing page, sends a WhatsApp message, and is silently routed to India. This is a factual mismatch on a public-facing claim for a licensed money product. Regulators and customers can reasonably rely on the tile as a service representation.

**Suggested fix (narrow the copy):** Remove the Canada tile from the live landing page UI, or add an explicit "coming soon" label. Alternatively, fix the code: add a routing fallback that correctly identifies Canadian senders and routes CAD→INR through a supported corridor when that corridor is live. Do not display Canada as an active corridor until the +1 NANP detection problem is solved.

---

### MISMATCH 2 — "Full audit trail: KYC decisions, blocked attempts, PII reveals" (`about-kyc-audit-log`)

**Claim text (about page):**
> Every KYC decision, blocked attempt, and sensitive-data reveal is recorded in an append-only, per-partner audit log.

**Code evidence:**

1. **KYC decisions — two of three paths are unaudited:**
   - `reviewKycAction` (src/app/admin-dashboard/customers/actions.ts:53): writes to a Redis hash (`kyc_audit:<phone>`) via `getKycCaseStore().review()` — Redis, not Postgres; no TTL guard; no append-only guarantee at the storage layer.
   - `markCustomerVerifiedAction` (actions.ts:20–43): calls `cs.saveCustomer()` with **zero** audit write. Staff can approve KYC with no record.
   - `markCustomerRejectedAction` (actions.ts:159–182): calls `cs.saveCustomer()` with **zero** audit write. Staff can reject KYC with no record.

2. **Blocked sanctions attempts — NOT in the audit log:**
   - `recordBlockedAttempt()` (src/lib/transfer-create.ts:284): writes a `status='blocked'` row to the **transfers** ledger, not to `audit_events`.
   - Call site in tools.ts:2366–2390 wraps it in `try/catch` with only `console.warn` on failure — even the ledger write can silently fail.

3. **PII reveals — correctly audited (only `payout_destination` field):**
   - `revealDestinationAction` (src/app/admin-dashboard/actions.ts:199–206): writes `{ action: 'pii.reveal', field: 'payout_destination' }` to Postgres `audit_events`. This is the only path that matches the claim.

**Risk:** Two staff server actions can approve or reject KYC with no audit trail. A regulator auditing who approved a KYC decision for a suspicious customer would find no record. This is a significant compliance deficiency for a money-transmission platform.

**Suggested fix (fix the code):** Add `createAuditRepo(getDb()).record(...)` calls inside both `markCustomerVerifiedAction` and `markCustomerRejectedAction` before the `saveCustomer` call. Move the blocked-attempt record to `audit_events` (in addition to, or instead of, the ledger row). The Redis KYC audit trail should be migrated to Postgres or exported durably; until then the copy claim should say "KYC decisions in the most recent 30 days are logged; long-term durable audit is in progress."

---

## NARROW FINDINGS (32)

Narrow findings describe claims that are architecturally or directionally true but contain qualifications a reasonable reader — especially a regulator or compliance officer — would consider material omissions. Listed most-significant first within this tier.

---

### N1 — "Non-custodial: SmartRemit never holds funds" (multiple surfaces)
**IDs:** `non-custodial-never-holds`, `non-custodial-by-design-hero`, `og-meta-8-corridors-non-custodial`, `funds-never-touch-us`, `about-partner-pay-page-never-receives`, `about-non-custodial-not-bank-not-mto`

**Claim text:** "Non-custodial by design. SmartRemit never holds, receives, or disburses customer money."

**Code evidence:**
- The architectural intent is genuine and widely commented: `settlement.ts:27`, `http-payment-provider.ts:16–21`, `payment-provider.ts:29`, `partner-rail/route.ts:19`.
- **Gap A (flagged path):** `src/app/api/pay/[transferId]/route.ts:125–146` — for compliance-flagged transfers, `captureFunding()` IS called before the hold. When a real PSP is wired, sender funds would sit at the PSP during manual review under SmartRemit's instruction.
- **Gap B (b2c funding seam):** `src/lib/providers/funding-provider.ts:83` always returns `MockFundingProvider`. The seam is explicitly designed to accept a real PSP (`funding-provider.ts:8–9` comment). When wired, SmartRemit's infrastructure would capture from the sender before instructing the partner — making "never holds funds" materially false on the b2c path.
- **Gap C (mock-only today):** Both the funding and settlement provider seams are currently mock-only, so the claim is vacuously true — no real money moves at all.

**Suggested fix (narrow the copy):** Add a qualifier: "SmartRemit's architecture ensures funds move through licensed partner rails, not through SmartRemit accounts. Fund capture and disbursement are executed by partners acting as licensed money transmitters." The current blanket statement will become false the moment a real PSP is plugged into the funding seam.

---

### N2 — "Every step signed" / "HMAC-signed settlement instruction" (multiple surfaces)
**IDs:** `signed-instruction-verified-callback`, `about-signed-settlement-instruction`, `about-hmac-signed-fail-closed`, `docs-webhook-fail-closed-401`

**Claim text:** "Cryptographically signs a settlement instruction … partner's rail signs a confirmation back."

**Code evidence:**
- **Outbound signature is conditional:** `outbox-worker.ts:170` and `http-payment-provider.ts:159` both use `...(signingSecret ? { 'x-signature': signBody(rawBody, signingSecret) } : {})`. A partner without a configured `signingSecret` receives an **unsigned** settlement instruction with no error raised.
- **No enforcement gate:** `settlement.ts` only checks `webhookDriven` (providerType), not the presence of `signingSecret`. An unconfigured partner can be activated and receive unsigned instructions.
- **Inbound side is correctly enforced:** `payment-webhook/[provider]/route.ts:78–83` is fail-closed (empty secret or empty signature → 401). The `/mock` URL carve-out is a structural bypass, though the mock handler is a no-op.
- `providerType: 'simulator'` auto-provisions a `signingSecret` (actions.ts:211,410); `providerType: 'http'` does not enforce one.

**Suggested fix (fix the code):** Add a startup/activation validation that rejects `providerType: 'http'` partner provisioning unless `signingSecret` is non-empty. Or replace the conditional spread with an assertion that throws if the secret is missing. The inbound-only half ("verified fail-closed") is already correct and can be kept as-is.

---

### N3 — "Every step audited" (hero copy and about page)
**IDs:** `full-audit-trail`, `licensed-partner-settled-hero-copy`, `pii-encrypted-at-rest-audited`, `about-encryption-aes256-gcm-masked-audited`

**Claim text:** "Every step audited. Full audit trail of every action."

**Code evidence:**
- Core money-path actions — `cancel`, `release`, `reject`, `issue refund`, `approve refund`, `dismiss refund`, `retry refund` (src/app/admin-dashboard/actions.ts:55–182) — call into `dashboard-ops.ts` functions that write **no** `audit_events` row.
- Partner configuration mutations (src/app/admin-dashboard/partners/actions.ts) have no audit calls.
- Transfer creation (`transfer-create.ts`) and settlement (`settlement.ts`) write no `audit_events` row.
- Customer PII fields (`fullName`, DOB, residential address, govId) are decrypted by default in `customer-repo.ts:57–61` and rendered on every admin page load with no audit event and no reveal toggle.
- The `pii.reveal` audit write covers only `payout_destination` reveals via `revealDestinationAction`.

**Suggested fix (fix the code):** Add `audit_events` writes to the cancel/release/reject/refund staff actions. Add them to `beginSettlement` and `createTransfer` for the core money path. Add a reveal toggle (and corresponding audit row) to the customer detail page for KYC PII fields. Until these are in place, narrow the copy: "Staff payout-destination reveals and API key mutations are audited. Full audit coverage of money-path actions is in progress."

---

### N4 — "Sanctions screening on every transfer, structurally impossible to turn off"
**IDs:** `sanctions-every-transfer-trust-band`, `sanctions-structurally-impossible-off`, `about-sanctions-every-transfer-cannot-switch-off`, `sanctions-screening-always-runs`, `docs-sanctions-every-mint-regardless-kyc`

**Claim text:** "Sanctions screening on every transfer. Cannot be switched off."

**Code evidence:**
- `screenTransfer()` call at `transfer-create.ts:166` is unconditional — correctly enforced for **recipient** screening.
- **Sender screening gap:** `compliance.ts:36–38` only screens the sender when `input.senderName` is truthy. `src/lib/cron-run.ts:75–87` never passes `senderName` to `createTransfer`, so every scheduled (cron) transfer fires without sender sanctions screening.
- **Mock watchlist:** `getSanctionsScreener()` at `sanctions-provider.ts:40–42` unconditionally returns `MockSanctionsScreener` backed by `WATCHLIST = ['john doe', 'jane roe', 'test blocked']` (compliance-config.ts:6). No live OFAC/SDN feed exists in the codebase.
- **Blocked transfers are created, not prevented:** `createTransfer` saves the blocked row with `status='blocked'` (transfer-create.ts:209,232). The claim that blocking happens "before the transfer is ever created" is inaccurate.
- **Partner REST API returns 422 for blocked; pay-page returns 400** — the "422" response code is not universal.

**Suggested fix (narrow the copy):** "Recipient sanctions screening runs on every transfer mint with no bypass toggle. Sender screening runs on all interactive paths; scheduled sends are screened on recipient only. The current screener uses a prototype watchlist; a live OFAC/SDN feed integration is planned." Also note the `listSource: 'mock-watchlist'` return value — any real compliance review would flag this immediately.

---

### N5 — "Outbox guarantees no silent loss, no duplicate on crash-replay"
**IDs:** `about-outbox-no-silent-loss-no-duplicate`

**Claim text:** "Durable outbox ensures no message or instruction is silently lost. Crash-safe with no duplicate transfers."

**Code evidence:**
- **Flagged-compliance WhatsApp notification bypasses outbox:** `src/app/api/pay/[transferId]/route.ts:136–139` — after status flip, stage-1 message is sent via direct `await sendText(...)` with no outbox row. A crash after the DB write silently drops the customer notification.
- **Delivery notifications bypass outbox:** `payment-webhook/[provider]/route.ts:106–142` — sender "delivered" message and recipient notification are fired via `after()` direct `sendText`/`sendTemplate`, not outbox rows. A function kill silently drops these.
- **No-duplicate guarantee is solid** for the cleared path (claim-first idempotency at `aux-repos.ts:292`).
- Retry ceiling is `MAX_ATTEMPTS = 8` (~1 hour total); after that instructions are dead-lettered, requiring manual ops resurrection.

**Suggested fix (fix the code):** Move the flagged-path stage-1 WhatsApp send and the webhook-triggered delivery notifications into outbox rows (using the existing `msg.send` or `msg.template` outbox types). Until then narrow the copy: "Cleared-transfer instructions and settlement effects are durable via the outbox. Compliance-hold and delivery notifications use a best-effort path and may not be retried on crash."

---

### N6 — "Licensed-partner settled" (trust band and hero copy)
**IDs:** `licensed-partner-settled-trust-band`, `licensed-partner-settled-hero-copy`, `partner-branded-bot-api-webhooks-dashboard`, `docs-footer-partners-are-licensed-mtos`

**Claim text:** "Licensed-partner settled. You keep the licence."

**Code evidence:**
- The non-custodial architecture is real: `http-payment-provider.ts:16–21` POSTs signed settlement instructions to the partner's rail; SmartRemit never captures funds on the payout side.
- **No license enforcement:** The partner application form (`partner-application-form.tsx:291`) collects `isLicensed` as a free-text string displayed only in the admin review UI. No DB schema constraint, no activation gate, and no settlement-path guard prevents an unlicensed entity from being provisioned and receiving settlement instructions.
- `getPaymentProvider()` (`payment-provider.ts:122`) switches on `providerType` with no check that the partner holds a license.
- Default rail is `MockPaymentProvider` — no licensed partner is wired by default.

**Suggested fix (narrow the copy or fix the code):** Either add a staff-confirmed `licenseVerified: boolean` field that must be true before a partner can be activated (code fix), or qualify the copy: "SmartRemit routes settlement through licensed money-transmitter partners. Partner licensing is validated during onboarding review; SmartRemit does not independently verify licenses at runtime."

---

### N7 — "Live mid-market rate, no markup" and "rate locked at confirm"
**IDs:** `live-mid-market-rate-no-markup`, `live-rate-display`, `rate-locked-at-confirm`, `agent-locks-rate-never-holds-funds`, `about-rate-locked-no-hidden-markup`

**Claim text (src/app/page.tsx:434–438):** "Live mid-market rate. No markup. Rate locked at confirmation."

**Code evidence:**
- `getFxRates()` fetches Frankfurter mid-market rates with no adjustment — correct for the default path.
- **ISR caching:** `src/app/page.tsx:30` sets `export const revalidate = 3600`. The displayed rate can be up to 60 minutes stale at render time; the page comments "Rate refreshes hourly."
- **Fallback rate:** On Frankfurter failure, `rate.ts:9,141` substitutes `FALLBACK_FX_RATE = 85` and the UI still labels it "(live mid-market rate)" with no staleness or fallback disclosure.
- **`marginBps` field:** `src/db/schema.ts:236` supports `marginBps` in `[-10000, 10000]` bps with no DB constraint blocking positive values. The routing filter at `partner-rates.ts:79` is the only guard; it is not enforced at the DB or repo layer.
- **Rate lock:** Solid for the approve-card → draft → mint path. **Not locked** for the legacy `create_transfer` explicit-args path (cron/scheduled transfers, tools.ts:1254–1286) which always re-quotes at current rates.
- The approval card displays "Rate locked ~10 min" but the draft TTL is 30 minutes (`draft-store.ts:6: DRAFT_TTL_SECONDS = 1800`).

**Suggested fix (narrow the copy):** For the landing rate display: add a "last updated X minutes ago" indicator and a visible disclosure on fallback. For the rate-lock: add a UI note that scheduled/recurring transfers re-quote at send time. For marginBps: add a DB `CHECK (margin_bps = 0)` or a schema-level constraint if the platform intends to never mark up.

---

### N8 — "First transfer free, then $1.99 flat fee"
**IDs:** `fee-first-free-then-flat-199`, `about-fee-first-free-flat`

**Claim text:** "First transfer free, then $1.99 per transfer."

**Code evidence:**
- First-free is correctly enforced: `fx.ts:65` sets `feeUsd = 0` when `transferCount === 0`.
- `bank_transfer` and `ach_pull` are $1.99 — accurate.
- **`debit_card` is $2.99; `credit_card` is $2.99 + 3% of amount** (`fx.ts:79`) — the credit card path is explicitly amount-dependent and not flat.
- The partner REST API always passes `transferCount=1` and `bank_transfer` to the quote (`partner-api-service.ts:175`), permanently excluding the first-free benefit from the API path.
- The consumer agent prompt (`prompt.ts:36`) hardcodes `bank_transfer`, so the chatbot always shows $1.99.

**Suggested fix (narrow the copy):** "First transfer free, then from $1.99 per bank transfer. Card fees vary." Or disclose the full fee schedule. Also fix the partner API to use the real `transferCount` so first-free applies to API-originated transfers.

---

### N9 — "PII encrypted at rest; staff reveals are audited"
**IDs:** `pii-encrypted-at-rest-audited`, `about-encryption-aes256-gcm-masked-audited`

**Claim text:** "AES-256-GCM encryption at rest. Masked in dashboards. Staff reveals are audited."

**Code evidence:**
- Encryption is genuine and comprehensive for transfer and customer PII fields.
- **Customer PII decrypted by default:** `customer-repo.ts:rowToCustomer` (lines 57–61) decrypts `fullName`, `dateOfBirth`, `residentialAddress`, `govIdNumber` on every row fetch with no masking option and no reveal toggle. The admin customer detail page renders all four fields in plain text on every page load.
- No `pii.reveal` audit event is written for customer KYC PII field access — only for `revealDestinationAction` (payout destination).
- `listCustomers()` decrypts all customer PII for every row returned.

**Suggested fix (fix the code):** Apply the same masking-by-default + explicit-reveal pattern used for `payout_destination` to customer KYC fields (`fullName`, DOB, address, govId). Add a reveal toggle to the customer detail page and write a `pii.reveal` audit event for each field exposed.

---

### N10 — "Beneficiary payout destinations encrypted at rest — no plaintext path"
**ID:** `beneficiary-encryption-at-rest`

**Claim text:** "All payout destinations stored AES-256-GCM encrypted, no plaintext path."

**Code evidence:**
- `aux-repos.ts:102`: `payoutDestinationEnc: b.payoutDestination ? encryptField(b.payoutDestination, provider) : ''` — the conditional ternary means a falsy `payoutDestination` bypasses `encryptField` and stores an **empty string in plaintext** (technically empty, not a real destination).
- **Exploitable bypass:** An API caller sending an unrecognised country code (e.g. `"XX"`) causes `BANK_FIELDS_BY_COUNTRY["XX"] ?? []` → `[]`, `validatePayoutFields` returns `{ ok: true, payoutDestination: '' }`, and the ternary stores `''` unencrypted. The response also echoes `payout_destination: ''` back to the caller.

**Suggested fix (fix the code):** (a) Validate the country code against the `CountryCode` enum before calling `validatePayoutFields`, returning a 400 for unknown codes. (b) Remove the conditional in the repo and always call `encryptField` — an empty string is a valid input; treat it as such rather than skipping encryption.

---

### N11 — "Delivery notification to both parties"
**ID:** `about-delivery-notification-both-parties`

**Claim text:** "Both you and your recipient receive a WhatsApp message when the money is on its way."

**Code evidence:**
- Recipient notification is guarded by `if (transfer.recipientPhone)` in both `outbox-worker.ts:123` and `payment-webhook/[provider]/route.ts:123`. `recipient_phone` defaults to `''` (falsy) in the schema.
- The recipient notification fires only at **delivery** (stage-2), not "on its way" (stage-1). The sender's stage-1 "on its way" message fires at settlement.

**Suggested fix (narrow the copy):** "You'll receive a WhatsApp message when your transfer is sent, and again when it's delivered. If your recipient's WhatsApp number is on file, they'll also receive a delivery notification."

---

### N12 — "Partner API: idempotency never duplicates"
**ID:** `partner-api-idempotency-claim`

**Claim text:** "Idempotency-Key header prevents duplicate transfers — same key always yields the same result."

**Code evidence:**
- The one-row-per-key DB guarantee is real (PK on `(partner_id, key)`).
- **No request-body fingerprint stored:** `aux-repos.ts:292–304` schema has only `partner_id`, `key`, `transfer_id`, `created_at` — no body hash.
- **Crash-replay with mutated body:** If a request claims a key but `createTransfer` throws (e.g. `QuoteError`), the key exists with no transfer. A retry with the same key but a different body (corrected amount) mints a different transfer under the same idempotency key.
- **Concurrent race:** `saveTransfer` at `transfer-repo.ts:99–128` is an upsert (`onConflictDoUpdate`), not a guard-insert. Concurrent requests with the same key but different bodies can overwrite each other's outcome.

**Suggested fix (fix the code or narrow the copy):** Store a HMAC of the canonical request body at claim time and compare on retry, returning 422 if bodies differ. Or narrow the docs: "The same Idempotency-Key with the same request body will never mint a duplicate transfer. Retrying with a different body after a partial failure is undefined behavior and may produce a different transfer."

---

### N13 — "Settlement retries automatically until your rail acks 2xx"
**ID:** `docs-settlement-automatic-retry-backoff`

**Claim text:** "Settlement instructions retry automatically with exponential backoff until your rail acks 2xx."

**Code evidence:**
- `outbox-repo.ts:97–108`: genuine exponential backoff (`2^attempts` seconds, capped at 3600s). ✓
- **Hard ceiling:** `MAX_ATTEMPTS = 8` (outbox-worker.ts:33). At 8 attempts the row transitions to `'dead'` and an ops alert fires. **No further automatic retries.**
- Manual resurrection requires an operator to call `retryDead` (outbox-repo.ts:146).

**Suggested fix (narrow the copy):** "Settlement instructions retry automatically with exponential backoff for up to 8 attempts (~1 hour window). After that, an ops alert fires and manual intervention is required."

---

### N14 — "Repeat/track/refund from the same chat or web account"
**ID:** `about-track-repeat-refund-from-chat`

**Claim text:** "Track status, repeat a past send, and request a refund — all from the same chat or your web account."

**Code evidence:**
- `repeatTransferTool` (tools.ts:2558–2564): when EDD is required AND the channel is `web`, the tool returns an error instructing the customer to use WhatsApp. Repeat-from-web is structurally blocked for amounts triggering EDD.

**Suggested fix (narrow the copy):** Add a qualifier: "Repeat a past send from web — some higher-value transfers may require completing extra verification in WhatsApp."

---

### N15 — "Sender screening on every transfer"
**ID:** `sanctions-screening-always-runs` (also covered in N4 above for completeness)

The cron path never passes `senderName` — sender is unscreened on all scheduled transfers. See N4 for full detail and fix.

---

### N16 — "Rate limit: 120 req/min with accurate Retry-After"
**ID:** `partner-rate-limit-120rpm`

**Claim text:** "120 requests per minute per partner; Retry-After header indicates when to retry."

**Code evidence:**
- `partner-rate-limit.ts:13`: `DEFAULT_LIMIT_PER_MIN = 120` — correct.
- `partner-api.ts:39–43`: `'Retry-After': '60'` is **hardcoded**, not computed from the remaining window time. A partner that hits the limit at second 59 of a minute is told to wait 60 s when they need ~1 s.

**Suggested fix (fix the code):** Compute `Retry-After` from the remaining milliseconds in the current 60-second bucket: `Math.ceil((60000 - (Date.now() % 60000)) / 1000)`.

---

### N17 — "Partner base URL: https://smartremit.ai/api/partner/v1"
**ID:** `docs-partner-api-base-url`

**Claim text (docs/page.tsx:76):** "Base URL: `https://smartremit.ai/api/partner/v1`"

**Code evidence:**
- The `/api/partner/v1` path is enforced by Next.js file layout.
- `smartremit.ai` is hardcoded in docs; `src/lib/env.ts:90` derives `appBaseUrl` from `APP_BASE_URL` or `VERCEL_PROJECT_PRODUCTION_URL` at runtime. On preview deployments the real URL differs.

**Suggested fix (narrow the copy):** Derive the base URL from the same env var in docs generation, or add a note: "Replace `smartremit.ai` with your deployment's base URL in non-production environments."

---

### N18 — "About page: honest demo status"
**ID:** `about-honest-status-demo-note`

**Claim text:** "All components — fund movement, sanctions feed, KYC vendor — are simulated today."

**Code evidence:**
- Fund movement and sanctions feed: confirmed mock-only by hardcoded code paths.
- **KYC vendor (Persona) is NOT structurally mocked:** `getKycProvider()` (`kyc-provider.ts:53–78`) instantiates the real `PersonaKycProvider` when `PERSONA_API_KEY` is non-empty. No hard-mock override exists. Setting the env var to a live key activates real KYC with no code change.

**Suggested fix (narrow the copy):** "Fund movement and sanctions screening use simulation today. The production KYC identity-verification integration (Persona) is activated by environment configuration and may be live in production deployments."

---

### N19 — Remaining narrow findings (same-family, no additional code gaps)

The following verdicts share the same root cause as findings above and require no separate fix beyond what is already listed:

| ID | Root cause |
|---|---|
| `non-custodial-by-design-hero` | Same as N1 (mock-only funding seam, flagged-path capture) |
| `og-meta-8-corridors-non-custodial` | Combined: N1 (custody) + MISMATCH 1 (8 corridors) |
| `funds-never-touch-us` | Same as N1 |
| `about-partner-pay-page-never-receives` | Same as N1 |
| `about-non-custodial-not-bank-not-mto` | Same as N1; about page's own disclosure partially mitigates |
| `licensed-partner-settled-hero-copy` | Same as N6 (no license enforcement) + N3 (audit gaps) |
| `about-fee-first-free-flat` | Same as N8 |
| `about-rate-locked-no-hidden-markup` | Same as N7 |
| `about-sanctions-every-transfer-cannot-switch-off` | Same as N4 |
| `docs-sanctions-every-mint-regardless-kyc` | Same as N4 (422 vs 400 on pay-page) |
| `docs-funds-never-touch-smartremit` | Same as N1 + N2 (signed instruction side is solid) |
| `about-hmac-signed-fail-closed` | Same as N2 |
| `docs-webhook-fail-closed-401` | Same as N2 (mock carve-out) |
| `partner-branded-bot-api-webhooks-dashboard` | Same as N6 ("you keep the licence" unenforced) |
| `docs-footer-partners-are-licensed-mtos` | Same as N6 |
| `about-encryption-aes256-gcm-masked-audited` | Same as N9 (customer PII not masked) |
| `about-kyc-audit-log` (narrow sub-claim) | Same as MISMATCH 2 |

---

## SUPPORTED CLAIMS (3)

These claims are provably and unconditionally enforced by the code with no material qualifications.

| ID | Claim | Enforcing location |
|---|---|---|
| `claim-sanctions-mock-only` | "Sanctions screening uses a prototype mock list (not a live OFAC feed)" | `sanctions-provider.ts:40–42` (unconditional mock); `compliance-config.ts:6` (three fake names); no real screener seam callable from any production path |
| `fetch-one-transfer-404-outside-scope` | "GET /api/partner/v1/transactions/:id returns 404 for transfers outside the requesting partner's scope" | `partner-api-service.ts:353–361` (scope check); `partner/v1/transactions/[id]/route.ts:10` (partnerId from auth, not request-controllable); `transfer-repo.ts:162` (partnerId not null) |
| `mint-transfer-idempotency-key-required` | "POST /api/partner/v1/transactions requires Idempotency-Key header; missing header returns 400" | `partner-api-service.ts:246` (first guard, before any claim logic); `.trim()` at route.ts:10 makes whitespace-only keys also fail |

---

## Priority Fix Queue

Ordered by regulatory/customer risk for a licensed money-transmission product:

1. **[MISMATCH 2 — KYC audit log]** Add `audit_events` writes to `markCustomerVerifiedAction` and `markCustomerRejectedAction`. (Compliance requirement.)
2. **[MISMATCH 1 — Canada corridor]** Remove Canada tile from live landing page or add "coming soon" label. (Consumer protection.)
3. **[N3 — Money-path audit gaps]** Add `audit_events` writes to cancel/release/refund staff actions and to `beginSettlement`. (Compliance requirement.)
4. **[N9 — Customer PII masking]** Apply mask-by-default + reveal-toggle to `fullName`, DOB, address, govId on the admin customer detail page. (Data protection.)
5. **[N5 — Outbox durability gaps]** Move flagged-path and delivery-notification WhatsApp sends into outbox rows. (Reliability.)
6. **[N2 — Unsigned settlement instructions]** Enforce `signingSecret` presence before `providerType: 'http'` partner can be activated. (Security.)
7. **[N4 — Mock sanctions screener]** Integrate a real OFAC/SDN feed via the `SanctionsScreener` interface; update copy to disclose current state. (Compliance.)
8. **[N1 — Funding capture seam]** Add architectural guard that prevents a real PSP being wired in without explicit non-custodial review. (Regulatory risk on b2c.)

---

*Report generated by automated claims-audit loop. Not a legal or regulatory opinion. All line references verified against commit `54b3e37` (2026-06-30).*
