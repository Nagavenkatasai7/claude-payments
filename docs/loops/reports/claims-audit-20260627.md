# Claims-vs-Code Audit — Morning Report
**Date:** 2026-06-27
**Auditor:** Claude Opus 4.8 (1M context) via loop agent
**Scope:** All marketing, docs, and metadata claims in the SmartRemit codebase audited against production code

---

## Summary

| Metric | Count |
|---|---|
| Total claims audited | 30 |
| Supported | 1 |
| Narrow (true but requires qualification) | 28 |
| Mismatch (materially false) | 1 |

**Risk distribution:** 1 HIGH-RISK mismatch · 9 HIGH-RISK narrows (regulatory/consumer-protection exposure) · 19 MEDIUM/LOW narrows

---

## HIGH-RISK MISMATCH (fix required before next regulatory review)

### `fee-schedule-2` — "flat fee" claim is materially false for credit card payments

**Claim text (src/app/about/page.tsx:134-135):**
> "Adds a clear, flat fee."

**Code evidence (`src/lib/fx.ts:64-88`):**
- `bank_transfer` fee: flat $1.99 — correct, flat
- `debit_card` fee: flat $2.99 — correct, flat
- `credit_card` fee: `round2(2.99 + 0.03 * amountUsd)` — **percentage-based**, not flat. A $500 credit-card transfer costs $17.99; a $1,000 transfer costs $32.99.
- `transferCount === 0` path: $0 (first transfer free) — correct
- Credit card is a real, surfaced option in the agent tool schema (`src/lib/tools.ts:259`)

**Suggested fix:** Narrow the copy on the about page to say "a flat fee for bank transfers" and add a disclosure that card payments carry an additional percentage fee, e.g.: "A flat $1.99 for bank transfers; card payments include a small percentage fee." Alternatively, change "flat fee" to "transparent fee" if the intent is to cover all payment methods with a single phrase.

---

## HIGH-RISK NARROWS (regulatory / consumer-protection exposure)

These narrows do not constitute outright falsehoods but are misleading enough to create regulatory or consumer-protection risk for a licensed money-transmission operation.

---

### `sanctions-1` through `sanctions-6` — "Sanctions screening on every transfer" is structurally true but backed by a mock watchlist

**Claim (representative, src/app/page.tsx:275):** "Every step signed, screened, and audited."

**Code evidence:**
- `screenTransfer()` is called unconditionally in `createTransfer()` (`src/lib/transfer-create.ts:166`). The `requiresKyc` flag has no effect on this call; `src/lib/kyc-gate.ts:13-16` explicitly says sanctions "runs in BOTH modes — it has no toggle anywhere."
- **However:** `getSanctionsScreener()` always returns `MockSanctionsScreener` (`src/lib/providers/sanctions-provider.ts:26-37`). The watchlist is `['john doe', 'jane roe', 'test blocked']` (`src/lib/compliance-config.ts:6`). A real OFAC/SDN name passes unless it matches one of these three strings exactly (case-insensitive).

**Suggested fix (copy):** Add a disclosure on any page claiming sanctions screening that the current production deployment uses a reference rule set and not a live OFAC/ComplyAdvantage feed. Example qualifier: "Sanctions screening runs on every transfer against our built-in reference list; production deployments are expected to wire a live regulatory feed via the pluggable SanctionsScreener interface." Until a real feed is wired, this claim risks regulatory exposure if relied upon for compliance purposes.

**Suggested fix (code):** Wire a real `SanctionsScreener` implementation (ComplyAdvantage, Sanctions.io, or similar) before any live-money corridor goes live. The `getSanctionsScreener()` provider seam in `src/lib/providers/sanctions-provider.ts` is already built for this swap.

---

### `audit-1` / `audit-2` — "Full audit trail" overstates coverage

**Claim (src/app/page.tsx:275):** "Full audit trail."

**Code evidence:**
- `audit_events` table exists and is used for: PII reveals (`src/app/admin-dashboard/actions.ts:199-206`), partner API key actions (`src/lib/partner-api-service.ts:323, 392, 450`), staff team mutations (`src/lib/audit-log-store.ts:27-34`), AI copilot actions.
- **Critical gap:** Transfer creation via the WhatsApp agent path (`src/lib/transfer-create.ts`) writes no `audit_events` row. `beginSettlement()` (`src/lib/settlement.ts:34-72`) writes no audit row. Payment-webhook callbacks (`src/app/api/payment-webhook/[provider]/route.ts`) write no audit row. Sanctions screening (`src/lib/compliance.ts`) writes no audit row.
- Two KYC mutation actions — `markCustomerVerifiedAction` and `markCustomerRejectedAction` (`src/app/admin-dashboard/customers/actions.ts`) — write no audit entry anywhere.
- `rowToCustomer` (`src/db/repos/customer-repo.ts:57-65`) decrypts fullName, DOB, address, and govIdNumber unconditionally on every read with zero audit trail.

**Suggested fix (copy):** Replace "Full audit trail" with "Audit log for staff actions, API key operations, and PII reveals." Until money-path events (transfer create, settlement, webhook callbacks, sanctions blocks) are audit-logged, the "full" qualifier is inaccurate and would not survive a compliance audit.

**Suggested fix (code):** Add `createAuditRepo` calls in `createTransfer`, `beginSettlement`, and the payment-webhook handler for at minimum: transfer.created, transfer.blocked, payment.received, payment.settled events.

---

### `encryption-2` / `encryption-1` — "Customer data masked in dashboards; staff reveals are audited" — false for customer PII table

**Claim (src/app/page.tsx trust band):** "Encryption at rest … masked in dashboards; staff reveals are audited."

**Code evidence:**
- Payout destinations (transfer-level): masked by default in `rowToTransfer` (`src/db/repos/mappers.ts:136-140`, returns `****{last4}`); reveal gated on `requireStaff` and writes `pii.reveal` audit event. **This sub-claim is fully supported.**
- Customer identity PII (fullName, DOB, address, govIdNumber): `rowToCustomer` (`src/db/repos/customer-repo.ts:57-65`) decrypts ALL fields on every read, unconditionally. The repo comment at line 20-22 states "DECRYPTED BY DEFAULT on read." Admin customers and KYC pages display this PII in plain text with no masking and no audit trail.

**Suggested fix (copy):** Qualify the claim: "Payout destinations are masked and staff reveals are audited. Customer identity fields are encrypted at rest." Remove the implication that all customer data is masked in dashboards.

**Suggested fix (code):** Gate `rowToCustomer` PII decryption behind an opt-in flag (mirroring the `opts.decrypt` pattern in `rowToTransfer`) and add `pii.reveal` audit events for dashboard reads of fullName, DOB, address, and govIdNumber.

---

### `non-custodial-5` / `non-custodial-6` / `non-custodial-7` — "Partners are licensed money transmitters who move funds on their own rails" — no code gate, no live rails

**Claim (src/app/page.tsx:771-775; src/app/about/page.tsx:97):** "Partners are the licensed money transmitters and settle all funds on their own rails."

**Code evidence:**
- `getFundingProvider()` (`src/lib/providers/funding-provider.ts:83-85`) unconditionally returns `MockFundingProvider`. `MockFundingProvider.capture()` returns `{ fundingRef: 'mockfund-<id>' }` — no real PSP call occurs.
- `getPaymentProvider()` (`src/lib/providers/payment-provider.ts:115-135`) returns `MockPaymentProvider` for any partner without `providerType: 'http' | 'simulator'`; the default seeded partner has no real rail.
- The `isLicensed` / `licenseTypes` fields (`src/lib/types.ts:609-610`) are free-text self-attestation fields on the partner application form. They are never stored on the Partner domain object, never written to the partners DB table (`src/db/repos/partner-repo.ts`), and never checked by `beginSettlement()` or `getPaymentProvider()`. An unlicensed entity can be activated as a partner.

**Suggested fix (copy):** Add a qualifier: "When integrated with a licensed partner's production rails." The current codebase uses mock rails by default; no real licensed-partner rails are operational in the deployed product today. The claim should be forward-looking.

**Suggested fix (code):** Before activating an `http`-type partner, require that a staff member explicitly checks (and records) licensure. Store the license attestation on the partner DB row; add a boot-time or activation-time assertion that no `http`-type partner is active without a licensure record.

---

## MEDIUM-RISK NARROWS

### `non-custodial-9` / `smartremit-licensed-partner-claim` / `signed-webhooks-1` / `signed-webhooks-2` — Outbound settlement instructions are not always signed

**Claim (docs/page.tsx:275; partner-facing copy):** "SmartRemit signs an instruction to your rail."

**Code evidence:**
- `src/lib/providers/http-payment-provider.ts:127` and `src/lib/outbox-worker.ts:169` both use: `...(signingSecret ? { 'x-signature': signBody(rawBody, signingSecret) } : {})`. An `http`-type partner configured without a `signingSecret` receives an unsigned POST with no error thrown.
- `simulator` partners always get signatures (auto-provisioned in `actions.ts:211`); `http` partners have no equivalent enforcement.
- Inbound callbacks ARE fail-closed (`payment-webhook-verify.ts:18`: empty secret or signature returns false).

**Suggested fix (copy):** Add "when a signing secret is configured" to any claim about signed instructions, or change to "cryptographically signed settlement instructions (requires signing secret configuration)."

**Suggested fix (code):** In the partner activation flow, require a non-empty `signingSecret` for `http`-type partners before they can be set to `active`. Add a validation in `http-payment-provider.ts` that throws if `signingSecret` is absent rather than silently omitting the header.

---

### `signed-webhooks-2` — Retry claim implies infinite retries; actual cap is 8

**Claim (docs page):** "Signed settlement instructions with exponential backoff until your rail acks 2xx."

**Code evidence:** `MAX_ATTEMPTS = 8` (`src/db/repos/outbox-repo.ts:33`). At attempt 8, the row transitions to `status='dead'` and an ops alert fires (`src/lib/outbox-worker.ts:364-369`). Retries cease; dead rows require manual ops intervention.

**Suggested fix (copy):** "...with exponential backoff (up to 8 attempts), then dead-lettered with an ops alert."

---

### `fx-rate-1` — "Live mid-market rate" can be up to 60 minutes stale or silently fall back to hardcoded 85

**Claim (src/app/page.tsx:434):** "`Today, 1 USD = {fmtRate(liveRate)} (live mid-market rate)`"

**Code evidence:**
- Page uses ISR with `export const revalidate = 3600` (`page.tsx:30`). The displayed rate can be up to ~60 minutes old.
- On Frankfurter failure, `src/lib/rate.ts:106` silently returns `FALLBACK_FX_RATES` (hardcoded, e.g., `FALLBACK_FX_RATE = 85` at `rate.ts:9`). The label still reads "live mid-market rate" even when showing a static placeholder.

**Suggested fix (copy):** Change to "Mid-market rate (updated hourly)" or add a footnote: "Rate shown is indicative and updated periodically; the exact rate is locked at time of transfer approval."

---

### `fx-rate-2` / `fx-rate-3` — Rate lock has gaps for legacy drafts and partner API

**Claim:** "The agent locks the live mid-market rate."

**Code evidence:**
- Rate lock works for the primary WhatsApp flow via `quoteOverrideFromDraft()` (`src/lib/transfer-create.ts:90-121`).
- Legacy non-USD drafts without `feeSource`/`totalChargeSource` fields: `quoteOverrideFromDraft` returns `undefined` (`transfer-create.ts:120`), triggering a live re-quote at mint time.
- Partner REST API path (`POST /api/partner/v1/transactions`, `src/lib/partner-api-service.ts:298-314`): calls `createTransfer` with no quote override — always mints at live FX.
- Draft TTL is 30 minutes (`draft-store.ts:6`), but the approval card says "~10 min" — inconsistent.

**Suggested fix (copy):** "The agent locks the mid-market rate for ~30 minutes in our WhatsApp flow." Qualify that the partner API does not inherit rate locking.

**Suggested fix (code):** Fix the card copy from "~10 min" to "~30 min" to match `DRAFT_TTL_SECONDS = 1800`. Consider adding quote locking to the partner API `createTransaction` endpoint.

---

### `fee-schedule-1` — "Flat $1.99 per bank transfer" omits card fees and partner rate spreads

**Claim (src/app/page.tsx:438-439):** "a flat $1.99 per bank transfer"

**Code evidence:**
- `src/lib/fx.ts:65-87`: debit card is $2.99; credit card is $2.99 + 3% of amount.
- `src/lib/partner-rates.ts`: `effectiveRateFor()` allows partner `marginBps` spread — white-label partners can embed a rate markup.

**Suggested fix (copy):** The bank-transfer qualifier is already present, which limits direct consumer harm, but the page should disclose that other payment methods cost more. Add: "Debit: $2.99 · Credit: $2.99 + 3%". Also note that white-label partner rates may vary.

---

### `corridor-count-2` / `corridor-count-3` / `8-corridors-any-direction-metadata` — "8 corridors" / "any direction" is non-standard and overstated

**Claims:**
- OpenGraph description (`src/app/page.tsx:23`): "8 corridors"
- Metadata (`src/app/page.tsx:19`): "8 corridors — any direction"

**Code evidence:**
- `CountryCode` (`src/lib/types.ts:454-455`): 8 members, "any-to-any" comment.
- `src/lib/providers/payment-provider.ts:33-37` documents `destination: 'IN'` and `destinationCurrency: 'INR'` as the settlement interface contract; the field name `amountInr` is used pervasively.
- `src/lib/types.ts:545` contains a residual "destination is always IN in v1" comment.
- CLAUDE.md: "US→India (multi-corridor capable)" — acknowledging multi-corridor is a capability, not a live deployment.
- Standard remittance terminology: a corridor is a directional source→destination pair; 8 countries any-to-any = 56 corridors, not 8.

**Suggested fix (copy):** Change "8 corridors" to "8 supported countries" in the OG description. Change "8 corridors — any direction" to "8 countries supported" in metadata until live any-to-any settlement is operational. Add a disclaimer that specific corridors depend on partner configuration.

---

### `listed-countries-claim` — Two of eight country pills display abbreviated labels, not full names

**Claim:** Eight countries are "listed" with their names.

**Code evidence:** `src/app/page.tsx:409` renders `c.short` as the visible label. United States → "US"; United Kingdom → "UK". Six countries render their full names; two do not.

**Suggested fix (copy):** Use `c.name` for all pill labels, or remove the implicit claim that full names are shown. Minor issue but factually inaccurate for two entries.

---

### `kyc-1` — "Delegated mode makes our send-gate step aside" conflates kycMode with requireKycBeforeSend

**Claim (docs page):** Choosing delegated KYC mode causes SmartRemit's send-gate to step aside.

**Code evidence:** The send-gate is controlled exclusively by `requireKycBeforeSend === true` (`src/lib/partner-config.ts:62`), independently of `kycMode`. A delegated partner can still have the gate ON if `requireKycBeforeSend: true` is set. The `kycMode` field only controls which party runs identity verification; it does not toggle the send gate.

**Suggested fix (copy):** "In delegated mode, your platform handles identity verification. The send-gate (which holds transfers until identity is confirmed) is controlled separately via the `requireKycBeforeSend` setting and defaults to off."

---

### `REST API + idempotent transfers` / `idempotency-key-required-claim-first` — Idempotency has two gaps: 422→200 status flip and body-mismatch on crash replay

**Claim:** "A retry never duplicates a transfer."

**Code evidence (`src/lib/partner-api-service.ts:254-328`):**
1. Blocked transfer 422→200: first call returns 422 (compliance blocked); retry with same key returns 200 (fetches the blocked row and returns ok). HTTP status is non-idempotent.
2. Crash between `idem.claim()` and `store.saveTransfer()`: retry enters the claim-first branch, finds no transfer row, and mints using the retry's body (possibly different amount/beneficiary) under the original key. No canonical body snapshot is stored in `idempotency_keys` to detect or reject differing retry bodies.
3. Counter double-increment: `incrementTodayTransferCount` and `monthlyVolumeStore.addCents` (`transfer-create.ts:234-235`) are non-idempotent and double-count on crash-recovery replays, potentially triggering false EDD thresholds.

**Suggested fix (copy):** "Idempotent by key — safe to retry on network failure. Blocked transfers return 422 on first call; subsequent retries return 200 with the blocked transfer record."

**Suggested fix (code):** (a) Store a hash of the canonical request body in `idempotency_keys` and return 409 on body mismatch. (b) Guard `incrementTodayTransferCount` with a check that the transfer id being counted has not already been counted. (c) On the 422 path, return 422 consistently on all replays (or document the 422→200 inconsistency as intentional).

---

### `durable-1` / `smartremit-production-grade-claim` — "Every external effect is a transactional outbox row" has two exceptions

**Claim (src/app/about/page.tsx Durable pillar; CLAUDE.md):** "Every external effect (WhatsApp sends, settlement instructions, rail callbacks, agent turns, ops alerts) is an outbox row written transactionally with the state change implying it."

**Code evidence:**
1. Compliance-flagged transfer path (`src/app/api/pay/[transferId]/route.ts:139`): `sendText()` is called **directly** (not via outbox) for the stage-1 "payment received, under review" WhatsApp message. If the Meta API call fails, the customer receives no message and there is no retry.
2. Stage-2 "delivered" notifications for http/simulator rails (`src/app/api/payment-webhook/[provider]/route.ts:106-142`): fired inside `after()` (best-effort Vercel), not via outbox. A function kill after the 200 ACK loses these notifications with no retry.
3. Agent reply deduplication: `outbox-worker.ts:330` sends the agent reply with no dedupe key; a retry of an `agent.turn` row that survived past agent execution but before `markDone` will double-send the reply.

**Suggested fix (copy):** Qualify to "money-critical effects (settlement instructions, payment status changes) use our durable outbox; notification delivery is best-effort in some paths."

**Suggested fix (code):** Move `sendText` in the compliance-flagged path into an outbox enqueue call with a dedupe key. Move stage-2 delivery notifications from `after()` into outbox rows.

---

### `delivery-2` — Recipient WhatsApp notification is conditional; fires at delivery, not "on its way"

**Claim:** "Both [sender and recipient] get a WhatsApp message."

**Code evidence:**
- Recipient notification is gated on `if (updated.recipientPhone)` / `if (stage2.transfer.recipientPhone)` (`src/app/api/payment-webhook/[provider]/route.ts:123-137`). `recipientPhone` is `.notNull().default('')` (`schema.ts:78`); when no phone is collected, the recipient receives nothing.
- Sender gets Stage 1 ("on its way") at `paid`; recipient gets Stage 2 ("delivered") at `delivered`. The claim implies both are notified at the same time.

**Suggested fix (copy):** "The sender gets a WhatsApp confirmation immediately; the recipient gets a delivery notification when their bank reports funds received (if a recipient phone number is on file)."

---

### `non-custodial-4` / `delivery-1` / `delivery-3` — Mock rail bypasses signed instruction loop entirely

**Claim:** Settlement loop: "SmartRemit signs an instruction → partner rail executes → signed callback confirms."

**Code evidence:** For `providerType === 'mock'`, `settlement.ts:59-67` enqueues `mock.settle` which self-advances status with no external party, no outbound signing, and no inbound webhook verification. The mock rail is a real selectable providerType, not just a test fixture.

**Suggested fix (copy):** "For production-integrated partners (http/simulator), SmartRemit signs..." — qualify that sandbox/demo partners use a local mock that does not exercise the signed instruction loop.

---

### `partner-rate-limit-claim` — `Retry-After: 60` header is always 60s, not actual remaining window time

**Claim:** "429 + Retry-After beyond the limit."

**Code evidence:** `partner-api.ts:42` hardcodes `Retry-After: 60`. The actual window reset is `60 - (Date.now() % 60_000) / 1000` seconds, which can be under 1 second. A well-behaved RFC 7231 client could wait up to 59 seconds longer than necessary.

**Suggested fix (code):** Compute `Math.ceil(60 - (Date.now() % 60_000) / 1000)` and use it for the `Retry-After` header value.

---

### `licensed-partner-1` / `licensed-partner-2` — "Licensed-partner settled" / license enforcement is pure self-attestation

**Claim (src/app/page.tsx:269):** "Licensed-partner settled."

**Code evidence:**
- `isLicensed` / `licenseTypes` fields are optional free-text on the application form (`src/lib/types.ts:609-610`).
- These fields are never stored on the Partner domain object, never written to the `partners` DB table, and never checked by `getPaymentProvider()` or `beginSettlement()`.
- An unlicensed entity can be provisioned as an `active` partner with a real settlement rail.

**Suggested fix (copy):** "Settled by licensed money-transmitter partners" is defensible only if the onboarding process includes out-of-band license verification. Add a footnote: "Partner licensure is verified during onboarding."

**Suggested fix (code):** Store a `licenseVerifiedAt` timestamp on the partner DB row. Block activation of `http`-type partners without a license verification record.

---

## LOW-RISK NARROWS

### `pill-badge-claim` — SUPPORTED

**Claim (src/app/page.tsx:223-224):** Non-custodial remittance infrastructure pill badge with green dot and exact text.
**Code evidence:** Verified 1:1 match. No issues.

---

### `encryption-3` — Beneficiary name and phone are NOT encrypted alongside payout destination

**Claim:** "Payout details encrypted at rest."

**Code evidence:** `src/db/repos/aux-repos.ts:101` encrypts `payoutDestination` (account number). But `name` (`aux-repos.ts:98`, `schema.ts:345`) and `recipientPhone` (`aux-repos.ts:103`, `schema.ts:350`) are stored in plaintext.

**Suggested fix (copy):** "Account numbers encrypted at rest" (scope-narrowed). Or encrypt `name` and `recipientPhone` via `sealOptional` to match the stated "payout details" scope.

---

### `best-rate-1` — Best-rate routing is only for default-tenant platform customers

**Claim (docs page):** "Best-rate routing for eligible platform transfers."

**Code evidence:** `src/lib/tools.ts:793-819` (`selectRouteForQuote`): hard tenant gate — `if (!ctx.routeSelector || partner.id !== DEFAULT_PARTNER_ID) return null`. White-label customers are never routed.

**Suggested fix (copy):** Minor — the "platform transfers" qualifier is present and aligns with the code. No change strictly needed, but clarifying that white-label tenants are explicitly excluded would prevent partner confusion.

---

## Fixes Ranked by Risk

| Priority | ID(s) | Risk | Action |
|---|---|---|---|
| P0 | `fee-schedule-2` | Consumer protection / UDAP | Fix copy: "flat fee" → qualify by payment method |
| P0 | `sanctions-1`–`sanctions-6` | Regulatory / AML | Wire real sanctions feed; add mock disclosure |
| P0 | `audit-1`, `audit-2` | Compliance audit failure | Remove "full"; add audit rows on money-path events |
| P1 | `encryption-2`, `encryption-1` | Privacy / PII exposure | Gate customer PII reads behind opt-in; add audit |
| P1 | `non-custodial-5`–`7`, `licensed-partner-1`/`2` | MTL compliance | Add license gate to partner activation |
| P1 | `non-custodial-9`, `signed-webhooks-1`/`2`, `smartremit-licensed-partner-claim` | Security / signing gap | Enforce signingSecret for http-type partners |
| P2 | `REST API + idempotent`, `idempotency-key-required-claim-first` | Partner API correctness | Store body snapshot; fix 422→200; fix counter dedup |
| P2 | `durable-1`, `smartremit-production-grade-claim` | Reliability | Move two notification paths into outbox |
| P2 | `fx-rate-1`, `fx-rate-2`, `fx-rate-3` | Consumer trust | Fix rate copy; fix draft TTL copy; fix fallback label |
| P3 | `delivery-2`, `delivery-3` | Customer comms accuracy | Qualify recipient notification conditionality |
| P3 | `signed-webhooks-2` | Docs accuracy | Fix retry copy: "up to 8 attempts" |
| P3 | `partner-rate-limit-claim` | API usability | Compute accurate Retry-After header value |
| P3 | `corridor-count-2`/`3`, `8-corridors-any-direction-metadata` | Marketing accuracy | "8 countries", not "8 corridors" |
| P3 | `kyc-1` | Partner docs accuracy | Clarify kycMode vs requireKycBeforeSend |
| P3 | `fee-schedule-1` | Consumer transparency | Disclose card fees alongside bank-transfer fee |
| P4 | `licensed-partner-1`/`2` copy | Marketing accuracy | Add "verified during onboarding" qualifier |
| P4 | `listed-countries-claim` | Minor copy | Render full name for US and UK pills |
| P4 | `best-rate-1` | Minor docs | Note white-label exclusion explicitly |
| P4 | `encryption-3` | Minor scope | Narrow copy or encrypt name+phone |

---

*This report is read-only. No code or marketing copy was modified. All file references are to the production codebase at the time of audit (2026-06-27).*

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
