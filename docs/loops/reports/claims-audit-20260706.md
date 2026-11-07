# Claims-vs-Code Audit — 2026-07-06

## Executive Summary

55 public-facing claims were audited against the live codebase; 10 are outright mismatches (code directly contradicts the claim), 43 are narrow (true in the primary path but overstated or unqualified), 1 is fully supported, and 1 is unverifiable. The single highest-risk finding is that the public trust badge "Sanctions screening on every transfer" runs exclusively against a 3-entry hardcoded mock watchlist (`['john doe', 'jane roe', 'test blocked']`) with no real OFAC/SDN integration — any bad actor whose name is not one of those three placeholder strings passes through unimpeded.

---

## Results by Status

| Status | Count |
|--------|-------|
| mismatch | 10 |
| narrow | 43 |
| supported | 1 |
| unverifiable | 1 |

---

## HIGH-RISK: Mismatches

These claims are directly contradicted by code and must be corrected before the product is considered production-ready.

---

### 1. "Licensed-partner settled" (trust band badge)
**Source:** `src/app/page.tsx:271`

**What the code shows:**
- The `partners` table has no `isLicensed`, `licenseNumber`, or `licenseStatus` column — only `status: 'active' | 'suspended'`.
- `wizardCreatePartnerAction` sets `status: 'active'` immediately with zero licensing check.
- The partner application `isLicensed` field is excluded from the `REQUIRED` array and stored only as optional free-text JSONB — never propagated to the `partners` table.
- `beginSettlement()` routes purely on `providerType` with no licensing verification.
- `ensureDefaultPartner()` seeds a default partner with `status: 'active'` and no licensing data; it can settle transfers immediately.
- `src/app/about/page.tsx:259` renders `[Placeholder: licensing & regulatory disclosures]` confirming no real disclosures exist.

**Suggested fix:** Either (a) add an `isLicensed` column and gate `beginSettlement()` on it, or (b) replace the badge with a legally accurate statement (e.g., "Partner-settled — licensing requirements applied at onboarding").

---

### 2. "Sanctions screening on every transfer" (trust band badge)
**Source:** `src/app/page.tsx`, trust band

**What the code shows:**
- The structural seam is real: `screenTransfer()` is called unconditionally in `createTransfer()` at `src/lib/transfer-create.ts:166`.
- However, `getSanctionsScreener()` at `src/lib/providers/sanctions-provider.ts:40-41` always returns `MockSanctionsScreener`, which performs a case-insensitive exact match against `['john doe', 'jane roe', 'test blocked']` (`compliance-config.ts:6`, commented "clearly fake names for the prototype").
- `listSource` is `'mock-watchlist'`; the class is described as "P5 stand-in". No real OFAC/SDN, EU Consolidated Sanctions List, or any regulatory watchlist is wired in.

**Suggested fix:** Remove the badge until a real provider (ComplyAdvantage, Sanctions.io, or direct OFAC/SDN) replaces `MockSanctionsScreener`. The architectural seam exists and is ready; only the implementation is missing.

---

### 3. "Full audit trail" (trust band badge)
**Source:** `src/app/page.tsx`, trust band

**What the code shows:**
Critical money and compliance events are not written to `audit_events`:
- Transfer creation (`createTransfer()`) — no audit insert.
- Payment/settlement (`beginSettlement()`) — outbox rows only, no `audit_events` write.
- Compliance release (`releaseTransferAction()`) — zero audit write. A staff decision on flagged money is unlogged.
- Compliance rejection (`rejectTransferAction()`) — same gap.
- Transfer cancellation (`cancelTransferAction()`, `cancelTransfer()`) — no audit write.
- Refund approvals/dismissals — no audit writes.
- KYC decisions — stored in ephemeral Redis hashes (`kyc_audit:{phone}`); `kyc-case-store.ts:15` explicitly marks durable export as "Phase-5 concern."

Only staff team management, PII reveals (one path: `revealDestinationAction`), API key usage, and AI copilot invocations write to `audit_events`.

**Suggested fix:** Either narrow the badge to "Audit trail for staff access and PII reveals" or add `audit_events` writes to all transfer lifecycle and compliance decision paths.

---

### 4. "Every step signed, screened, and audited" (hero section)
**Source:** `src/app/page.tsx`, hero paragraph

**What the code shows:**
- **Screened** — materially false: runs the mock screener described in finding #2 above.
- **Signed** — partially true but conditional: outgoing settlement instruction signature (`x-signature`) is only added when `signingSecret` is non-empty (`outbox-worker.ts:170-172`). An unconfigured `http`-type partner receives unsigned instructions.
- **Audited** — narrow: `audit_events` covers only the limited set described in finding #3.

**Suggested fix:** Suppress this claim until the mock screener is replaced and the signing/audit gaps are closed, or replace "screened" with "compliance-checked" qualified by the mock status disclosure.

---

### 5. "8 corridors. Any direction." (corridors section h2)
**Source:** `src/app/page.tsx:388`

**What the code shows:**
- Landing page shows 8 countries; agent system prompt (`prompt.ts:27`) tells customers "10 countries"; the default partner migration (`drizzle/0006_default_partner_any_to_any.sql`) configures only 7 countries (CA excluded).
- Canada appears as a clickable corridor tile but is structurally excluded from the default partner's operating countries; Canadian +1 numbers are mapped to US (`partner-currency.ts:7`), so CAD is never a valid send currency.
- HK and MX are in the agent prompt as supported destinations but absent from `VALID_COUNTRY_CODES` in `tools.ts:826-828`; unknown codes silently fall back to India.
- The product simultaneously advertises 8 and 10 corridors to different audiences.

**Suggested fix:** Reconcile the count to a single accurate number; remove Canada from the tile display or implement NANP disambiguation; add HK and MX to `VALID_COUNTRY_CODES` or remove them from the agent prompt.

---

### 6. "Send and receive between all of these" (corridors subheading)
**Source:** `src/app/page.tsx:391`

**What the code shows:**
Canada is explicitly excluded at every enforcement layer:
- `src/lib/defaults.ts:18` — `DEFAULT_PARTNER_COUNTRIES` omits CA with comment "deliberately EXCLUDED."
- `drizzle/0006_default_partner_any_to_any.sql` — production migration excludes CA.
- `partner-currency.ts:7` — calling code '1' maps to 'US', not 'CA'.
- `allowedSendCurrencies()` never returns CAD for the default partner.

A Canadian user tapping the Canada tile would be detected as a US sender and quoted in USD.

**Suggested fix:** Remove the Canada tile from the corridor display, or implement a solution for the NANP calling code ambiguity and re-enable the corridor.

---

### 7. "PII stays encrypted at rest, and every reveal is written to the audit log" (ops dashboard section)
**Source:** `src/app/page.tsx`, section 02 showcase copy

**What the code shows:**
- Encryption at rest is real and correct (AES-256-GCM).
- "Every reveal" is provably false: only `revealDestinationAction` writes a `pii.reveal` audit event (`actions.ts:199-206`). All other decrypt paths are unaudited:
  - `getCustomer()` decrypts fullName, DOB, address, govIdNumber on every agent and dashboard read.
  - Customer settings page decrypts email.
  - Agent repeat-send tool path calls `getTransferDecrypted`.
  - B2B customer receipt page calls `getTransferDecrypted`.
  - `listRecipients` decrypts all saved payout destinations.
  - B2B settlement instruction build calls `getSellerDecrypted`.

**Suggested fix:** Change copy to "PII stays encrypted at rest; destination reveals are audit-logged" — or add `pii.reveal` writes to the other decrypt paths.

---

### 8. "[Placeholder: licensing & regulatory disclosures]" (about page footer)
**Source:** `src/app/about/page.tsx:259`

**What the code shows:**
The literal placeholder string is rendered in the public footer. No FinCEN/NMLS identifiers, license numbers, or real regulatory disclosures exist anywhere in the codebase. The same placeholder appears in `src/app/about/page 3.tsx:259` (iCloud duplicate).

**Suggested fix:** Replace with real regulatory disclosures, a legal explanation of SmartRemit's non-transmitter status, or at minimum a clear statement that the platform is pre-licensing and not yet available to consumers.

---

### 9. "Multi-corridor — sends from US, Canada, UK, UAE, Singapore, Australia, New Zealand; pay out to India today" (platform overview)
**Source:** `docs/SMARTREMIT-PLATFORM-OVERVIEW.md`, section 1 bullet

**What the code shows:**
- Source countries understated: `types.ts:511-512` defines 10 source countries (adds IN, HK, MX); `prompt.ts:27` instructs the agent to present 10-country any-direction service.
- Payout destinations claim is materially false: 8 validated payout destinations exist in `VALID_COUNTRY_CODES` (`tools.ts:826-828`), not only India. US→UK, SG→AU, etc. are actively handled.
- HK/MX misrouting: agent prompt says they're supported destinations; `VALID_COUNTRY_CODES` excludes them; unknown codes silently route to India — a live money-routing defect.
- Internal docs (`types.ts:604`, `wizard.tsx:179`) still reflect the obsolete India-only architecture.

**Suggested fix:** Update the overview to reflect the current any-to-any implementation; fix the HK/MX misrouting by either adding them to `VALID_COUNTRY_CODES` or removing them from the agent prompt.

---

### 10. "~140 automated test files / ~1,665 tests" (platform overview)
**Source:** `docs/SMARTREMIT-PLATFORM-OVERVIEW.md`, section 1 stack summary

**What the code shows:**
- Actual file count (excluding `tests/e2e/**` per `vitest.config.ts`): **168 Vitest files**, not ~140.
- Actual test-case count: approximately **2,089 test cases**, not ~1,665.
- `CLAUDE.md:14` states an even older figure ("~120 test files / ~1,270 tests").
- Both dimensions are understated by ~20-25%.

**Suggested fix:** Update the overview and CLAUDE.md to reflect ~168 Vitest files and ~2,000+ test cases. This is low security risk but reflects documentation drift.

---

## MEDIUM-RISK: Narrow Claims

These claims are true in the primary path (usually the WhatsApp consumer flow) but are overstated, missing qualifications, or fail on secondary paths. Each entry lists the claim, the gap, and the recommended qualification.

| # | Claim (abbreviated) | Source | Primary Gap |
|---|---------------------|--------|-------------|
| 1 | "SmartRemit never holds, receives, or disburses customer money" (footer) | `page.tsx` footer | B2C card/bank_transfer path has a `captureFunding()` seam that would route funds through SmartRemit's merchant account when a real PSP is connected. Currently vacuously true because the funding provider is mock-only. |
| 2 | "Non-custodial by design" (trust badge) | `page.tsx` trust band | Same B2C funding gap as above; the non-custodial property for B2B ach_pull/bank_pull is structurally enforced, but the consumer card path is enforced only by absence of a real PSP. |
| 3 | "sanctions screening is structurally impossible to switch off, in every KYC mode" | `page.tsx` section 04 | KYC-mode toggle enforcement is real. Gap 1: scheduled/cron transfers call `createTransfer()` without a `senderName`; `compliance.ts:36-38` returns `{matched: false}` when absent — so cron-path senders are never screened. Gap 2: mock watchlist has no real regulatory effect. |
| 4 | "The agent locks the live mid-market rate and holds it for you. It never holds your funds." | `page.tsx` section 01 | Rate lock is real for the WhatsApp approve-button → pay-page flow. Gaps: approval card says "~10 min" but draft TTL is 30 min; legacy non-USD drafts silently fall back to live re-quote; cron/explicit-args path never locks a rate. |
| 5 | "No markup baked into the rate — your first transfer is free, then a flat $1.99 per bank transfer." | `page.tsx` calculator section | True for consumer WhatsApp path. B2B cross-border bill payment uses `wouldBeFeeUsd()` (presentation helper, never returns $0) as the authoritative fee, bypassing the first-transfer-free logic entirely. |
| 6 | "Exchange rates are indicative and locked when you confirm a transfer." (footer) | `page.tsx` footer | Accurate for one-time B2C transfers. Scheduled/recurring transfers re-fetch live FX at each cron execution — the rate is not locked at schedule-confirmation time. |
| 7 | "8 corridors, non-custodial, live mid-market FX" (OG metadata) | `page.tsx` OG description | "8 corridors" is non-standard (should be "8 country endpoints"); agent prompt tells live customers "10 supported countries." Non-custodial and FX sub-claims are well-supported. |
| 8 | "Branded bot, hosted pay page, signed settlement webhooks, REST API, self-service dashboard" | `page.tsx` partner section | "Signed" is conditional on `signingSecret` being configured per-partner (no enforcement for http-type rails). "Self-service" requires SmartRemit to provision the initial staff account; partners cannot self-onboard. |
| 9 | "SmartRemit is non-custodial technology infrastructure — not a bank and not a money transmitter." | `about/page.tsx` hero | B2C card path has unconstrained `captureFunding()` seam. No real licensed partner currently operates any rail (all mocked). "Not a money transmitter" is a legal characterization, not code-enforceable. |
| 10 | "your first transfer is free, then it's a low flat fee" | `about/page.tsx` Step 2 | First-transfer-free enforcement is correct. Credit card fee is `$2.99 + 3% × amount` — explicitly not flat. On a $2,999 transfer, credit card fee reaches ~$92.96. Copy says "flat" without payment-method qualification. |
| 11 | "The rate you approve is the rate that's used; there's no hidden markup baked into it." | `about/page.tsx` Step 2 | True for consumer flow. Partner REST API `/quote` returns a rate at T1; `/transactions` mints at a live re-quote at T2 — no draft, no stored quote override. Rate can differ on ECB daily fix days. |
| 12 | "SmartRemit never receives or holds your money — the partner's rail processes the payment." | `about/page.tsx` Step 3 | Only true for B2B ach_pull/bank_pull. For B2C bank_transfer (the context of Step 3), SmartRemit's PSP captures from the sender first; the partner only handles disbursement. Entire flow is mocked today. |
| 13 | "A sanctions screen runs on every transfer and cannot be switched off. A match stops the transfer before it's ever created." | `about/page.tsx` Step 4 | "Cannot be switched off" is real. "Before it's ever created" is false for the partner API and pay-page finalize paths — those save a Transfer row with `status='blocked'`, so the row does exist. Only the WhatsApp chat path blocks before insertion. |
| 14 | "SmartRemit sends the licensed partner a cryptographically signed settlement instruction." | `about/page.tsx` Step 5 | Signing is conditional on `signingSecret` being configured. For http-type partners without it, instructions are sent unsigned with no error. |
| 15 | "You and your recipient both get a WhatsApp message when the money is on its way." | `about/page.tsx` Step 6 | Recipient notification fires at delivery (money arrived), not dispatch (on its way). Silently skipped when `recipientPhone` is empty string (schema default). Partner API flows can omit recipient phone. |
| 16 | "Screening runs on every transfer and is structurally impossible to switch off. (In today's demonstration it runs against a built-in reference rule set.)" | `about/page.tsx` Trust & compliance | Recipient screening is unconditional. Sender screening silently skips when `senderName` is undefined — partner API callers can omit sender name; B2C delegated-mode customers may lack `fullName`. CLAUDE.md invariant "KYC may be delegated; sanctions may not" is violated on the partner API path in delegated mode. |
| 17 | "The regulated money-transmitter partner holds the license and operates the rails." | `about/page.tsx` Trust & compliance | Architecturally intended but not true today. All active providers are `MockPaymentProvider` or SmartRemit's own `/api/partner-rail` (simulator). No real licensed partner has a live rail. Page's own disclaimer ("simulated today") qualifies it, but the pillar makes an unqualified present-tense assertion. |
| 18 | "Payout destinations, recipient legal names, customer data and integration secrets are AES-256-GCM encrypted at rest and masked in dashboards; staff reveals are audited." | `about/page.tsx` Trust & compliance | Encryption correct for all named fields. Customer PII (fullName, DOB, address) is NOT masked in dashboards — decrypted by default on every read, displayed in plaintext to any staff. No audit event is written for customer PII reads (no reveal mechanism exists for them). |
| 19 | "Every external effect is a transactional outbox row with automatic retry — nothing is silently lost, and crash-replays never duplicate a transfer." | `about/page.tsx` Trust & compliance | Core outbox pattern is well-implemented. Gaps: (1) outbox rows stranded in `status='processing'` after a Vercel function kill have no rescue path; (2) legacy chat-tool and cron transfer mints have no claim-first idempotency; (3) button-tap path uses consume-first rather than claim-first. |
| 20 | "KYC decisions, blocked attempts and sensitive-data reveals are written to an append-only, per-partner audit log." | `about/page.tsx` Trust & compliance | PII reveals (one path) land in Postgres `audit_events`. KYC decisions use Redis per-phone hashes (non-durable; two of three KYC mutation actions write no audit at all). Blocked attempts go to the transfers table, not `audit_events`. "Append-only" has no DB-level enforcement. |
| 21 | "Instructions out and callbacks in are HMAC-signed and verified fail-closed." | `about/page.tsx` For partners | Outbound signing conditional on `signingSecret` (missing → unsigned, no error). Mock provider inbound bypass: unsigned POSTs to `/api/payment-webhook/mock` bypass HMAC gate for non-webhook-driven rails. Shared WhatsApp endpoint warns and proceeds when `META_APP_SECRET` is unset. |
| 22 | "SmartRemit is a working demonstration... Actual fund movement, the production identity-verification vendor, a commercial sanctions feed, and a live payout rail are simulated today." | `about/page.tsx` demo status note | Mostly accurate. Gap: KYC vendor simulation is default behavior (PERSONA_API_KEY absent), not a code guarantee — if the env var is set in Vercel, real Persona runs while the page still says it's simulated. |
| 23 | "White-label, non-custodial remittance infrastructure... SmartRemit orchestrates... and never holds funds." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` intro | Settlement and B2B funding paths are non-custodial by code. B2C card/bank_transfer funding path has no production implementation; the non-custodial claim for that path is maintained by absence of a real PSP. |
| 24 | "Non-custodial by design — SmartRemit never touches, holds, or routes money." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` bullet | Settlement side: fully enforced. B2B ach_pull/bank_pull: structurally enforced. B2C card: the `captureFunding()` seam exists and could route funds through SmartRemit's merchant account — not code-prevented. |
| 25 | "Compliance is built in, not bolted on — sanctions screening always runs." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` bullet | Structural call-site is genuine. However, what always runs is a mock screener with 3 placeholder names. Sender screening silently drops when name is absent (cron path, partner API). |
| 26 | "Production-grade reliability — every external effect is durable and retried; nothing is silently lost." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` bullet | Core cleared-path is robust. Gaps: flagged-transfer WhatsApp notification is a direct `sendText()` call (not outbox); webhook-delivered stage-2 notifications use `after()` (best-effort, not outbox). Both can be silently lost. |
| 27 | "WhatsApp notifications to both sender and recipient when money is delivered." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` bullet | Recipient notification silently skipped when `recipientPhone` is empty (schema default). For HTTP/simulator rail, delivery notifications live in `after()` (best-effort), not the durable outbox. |
| 28 | "Live FX, transparent fees, a locked quote, and a one-tap secure payment link." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` bullet | Live FX (5-min staleness, static fallback on outage), transparent fees, and locked quote are real. "One-tap" is materially overstated: all flows require OTP request + 6-digit code entry minimum; cold-start adds bank-details form. |
| 29 | "In both modes, sanctions screening always runs — it is structurally impossible to toggle off." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 5 | Structural enforcement confirmed. What runs is the mock screener; sender screening conditional on name being provided. Public copy implies OFAC compliance; code delivers 3 fake names. |
| 30 | "T0: capped at $500/transfer and $500/day." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | Correct for WhatsApp and pay-page paths. Partner REST API (`POST /api/partner/v1/transactions`) has no `evaluateCap` call and no `DailyVolumeStore` — caps are completely absent on that path. T0 customers can exceed caps via the API. |
| 31 | "T1: capped at $2,999/transfer and $2,999/day." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | Same enforcement gap as T0: caps are absent on the partner API path and the B2B cross-border bill payment path. |
| 32 | "Velocity limit — more than 5 transfers/day flags a customer for review." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | "Flags for review" enforcement only applies on the consumer pay route. Partner API confirm path (`POST /api/partner/v1/transactions/:id/confirm`) checks only `complianceStatus==='blocked'` and settles normally — velocity-flagged transfers bypass the `in_review` hold. Threshold of 5 is also partner-configurable. |
| 33 | "Large-amount flag — transfers at/above a configurable threshold (approx. $1,000) are flagged for review." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | Flagging at exactly $1,000 (not "approx.") is correctly enforced. "Configurable" is misleading: `updatePartnerAction` does not include `corridorCompliance`; no admin UI exposes the threshold; `CORRIDOR_DEFAULTS` is empty at ship; overrides require direct DB writes. |
| 34 | "EDD — the Travel Rule: Triggered when a customer's rolling-month volume reaches approx. $3,000." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | $3,000 EDD trigger is real and correctly implemented. However, "Travel Rule" is a separate, dormant concept in code (`types.ts:90` marks Tier 2 as dormant). EDD only collects source-of-funds and occupation; Travel Rule fields (relationship, purpose, recipient legal name) are not gated by the $3,000 threshold. |
| 35 | "Verification is human-approved only... A late or out-of-order webhook can never override a human decision." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | `kycStatus` can only be written by humans — that invariant holds. "A late webhook can never override" fails for the `markCustomerVerifiedAction` path, which sets `kycStatus:'verified'` without setting `kycReviewState:'approved'`, leaving the `HUMAN_TERMINAL` guard dormant. A subsequent Persona watchlist webhook then re-queues the already-approved customer. |
| 36 | "Sensitive fields... are encrypted with AES-256-GCM envelope encryption." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | Encryption mechanism is correct for all named fields. Gap: customer phone numbers (PK of the `customers` table, FK in nearly every other table) are stored in plaintext — PII under CCPA/GLBA, not encrypted. Recipient display names in `transfers` and `schedules` tables are also plaintext. |
| 37 | "Crypto-shred deletion — dropping the ciphertext destroys the only copy of its key, making the value permanently unrecoverable." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | DEK-in-blob mechanism is sound for the live DB layer. Gaps: (1) `FIELD_ENCRYPTION_KEY` is never rotated — Neon PITR/WAL backups of deleted rows remain decryptable; (2) Redis conversation histories store PII in plaintext (30d TTL); (3) no erasure code path exists for customer PII tables (`customers`, `transfers`, `beneficiaries`, `recipients`). |
| 38 | "Bank details are never collected in chat (WhatsApp policy + PII)." | `docs/SYSTEM-ARCHITECTURE.md` section 4.2 | Primary new-recipient flow correctly routes bank details to the pay page. "Never" is not structurally enforced: `create_transfer` and `create_schedule` tools both accept `payout_destination` from the model with no server-side check that the value came from an encrypted record. A model deviation or adversarial prompt can successfully route chat-sourced bank details with no server-side rejection. |
| 39 | "fee tiers (first transfer free, then $1.99)" | `docs/SYSTEM-ARCHITECTURE.md` section 4.2 | First-transfer-free: correctly enforced. "$1.99" is accurate for bank_transfer (the default). Debit card is $2.99; credit card is $2.99 + 3% of amount. Partner API hardcodes `transferCount=1`, making first-transfer-free unavailable on that path. |
| 40 | "Sanctions screening runs on every transfer, in every KYC mode, for every partner. There is no flag anywhere that disables it." | `docs/SYSTEM-ARCHITECTURE.md` section 1 invariants | Structurally confirmed — no disable flag exists. Sender screening silently skips when name is absent (cron path never provides one). Recipient screening always runs. The screener itself is a mock. |
| 41 | "Best-rate routing — you can compete for volume by pushing wholesale FX rates." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 2 | Mechanism is real. Critical restriction: `tools.ts:890` gates best-rate routing on `partner.id === DEFAULT_PARTNER_ID`. White-label customers are permanently pinned to their own partner and never participate. Partners can only compete for the platform's shared unattributed customer base. |
| 42 | "'ours' mode uses a hosted Persona flow." | `docs/SMARTREMIT-PLATFORM-OVERVIEW.md` section 7 | Conditionally true when `PERSONA_API_KEY` is set. Provider selection is credential-driven, not mode-driven. `kycMode` only controls the send gate; a production instance with 'ours' mode but no API key silently falls back to `MockKycProvider`. |
| 43 | Rate lock duration and scheduled-transfer rate behavior | `page.tsx` footer; `about/page.tsx` Step 2 | Approval card says "Rate locked ~10 min" but draft TTL is 30 minutes (`draft-store.ts:6 DRAFT_TTL_SECONDS=1800`). Scheduled/recurring transfers use live FX at each cron execution — no rate lock at schedule-confirmation time. These are not separate audit entries but a cross-cutting qualification needed on all rate-lock copy. |

---

## Supported Claims

Only one claim survived full adversarial review without qualification:

**"Create transfers over a Bearer-keyed API, pinned to your tenant, with idempotency keys so a retry never duplicates a transfer."**
(`src/app/about/page.tsx`, For partners section — REST API + idempotent transfers pillar)

Evidence:
- Bearer enforcement: `extractBearer` + SHA-256+pepper hash lookup with `revokedAt` null check and `sr_live_` prefix requirement (`api-key-repo.ts:49-61`).
- Tenant pinning: `partnerId: partner.id` passed explicitly into `createTransfer` (`partner-api-service.ts:301`).
- No-duplicate guarantee is three-layered: DB PK on `(partner_id, key)` (`schema.ts:435`) makes two different transfer IDs for the same (partner, key) structurally impossible; `INSERT … ON CONFLICT DO NOTHING` (`aux-repos.ts:296-308`) is atomic; `saveTransfer` uses `ON CONFLICT DO UPDATE` on transfer ID (`transfer-repo.ts:125-128`).
- The only edge case (key claimed before body validation, then retry with corrected body) still yields exactly one transfer per (partner, key) — not a duplicate.

---

## Unverifiable Claims

**"Once approved, money returns to the original payment method in 3-5 business days."**
(`docs/SYSTEM-ARCHITECTURE.md` section 5.2 — Funds capture & refunds)

The "3-5 business days" timeline appears as a string constant in `payment.ts`, `tools.ts`, `receipt/page.tsx`, and `prompt.ts`, but no code enforces or monitors any timing. The only refund implementation is `MockFundingProvider`, which completes instantly with a deterministic stub ref. There is no real PSP integration, and no alert or sweep path watches for a refund exceeding any time window. This is an external-PSP operational SLA that the codebase cannot verify.

---

## Methodology

This audit compared 55 public-facing claims extracted from `src/app/page.tsx`, `src/app/about/page.tsx`, `docs/SMARTREMIT-PLATFORM-OVERVIEW.md`, and `docs/SYSTEM-ARCHITECTURE.md` against the live codebase in `/home/user/claude-payments`. For each claim, the relevant code paths were traced end-to-end (not just the primary happy path) across all ingress routes: WhatsApp chat agent, hosted pay page, partner REST API, B2B finalization, and the cron/scheduled-transfer runner. Claims were graded:

- **mismatch** — code directly contradicts the claim in a way that is currently observable (not hypothetical).
- **narrow** — claim is true on the primary path but fails or is unqualified on at least one secondary production path.
- **supported** — claim holds across all examined code paths with no material gaps.
- **unverifiable** — claim depends on external operational SLAs that cannot be confirmed or denied from code alone.

No code or marketing copy was modified. This report is read-only analysis.
