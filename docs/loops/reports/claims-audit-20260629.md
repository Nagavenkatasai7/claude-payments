# Claims-vs-Code Audit — Morning Report

**Date:** 2026-06-29
**Repo:** Nagavenkatasai7/claude-payments (SmartRemit)
**Auditor:** Loop — read-only, no code or copy changed

---

## Summary

| Metric | Count |
|---|---|
| Total claims audited | 39 |
| Supported (code fully backs claim) | 0 |
| Narrow (claim true but overstated or partially enforced) | 38 |
| Mismatch (claim contradicted by code) | 1 |

**No claim audited was found to be fully supported without qualification.** Every claim either overstates enforcement quality (mock vs. real), elides a conditional guard, or describes future/design intent as present operational reality. One claim (C04) is a direct code contradiction and is HIGH RISK for a money-services company.

---

## HIGH-RISK — Mismatch

### C04 — "Licensed-partner settled" / "Partners are the licensed money transmitters"

**Claim text (src/app/page.tsx:269, 772):**
> "Licensed-partner settled" and "Partners are the licensed money transmitters and settle all funds on their own rails."

**Code evidence:**
The `partners` table (`src/db/schema.ts:32-50`) has only a `status` column (`'active' | 'suspended'`). There is no `isLicensed`, `licenceNumber`, or equivalent field. The `isLicensed` string in `PartnerApplicationDetails` (`src/lib/types.ts:617`) is an optional free-text field in the pre-onboarding application form and is **never read** by settlement, transfer-creation, or any runtime gate. The partner wizard action (`src/app/admin-dashboard/partners/actions.ts:381`) provisions new partners directly to `status: 'active'` with no check that any licensing assertion was made. The only runtime guard is `partner.status !== 'active'` — which enforces the partner is "active" but says nothing about being licensed. A platform admin can make any entity an active, settlement-capable partner without any licensing verification in the code path.

**Suggested fix (narrow the copy):**
Replace "Partners are the licensed money transmitters" with "Partners are contractually required to be licensed money transmitters; SmartRemit does not verify licensure in software." Alternatively, add a `licenceVerified: boolean` gate in the partner-activation code path and re-gate `settlement.instruct` dispatch on it.

---

## HIGH-RISK — Narrow (material risk for a regulated money product)

These claims are not direct contradictions but carry regulatory or reputational risk because they imply real compliance capabilities the code does not deliver.

### C05 / C10 / C20 / C26 / C32 / claim-sanctions-not-delegable — "Sanctions screening on every transfer" / "Structurally impossible to switch off"

**Claim text (src/app/page.tsx:362-364 and related):**
> "Sanctions screening runs on every transfer and is impossible to switch off." / "Screening always runs on our side."

**Code evidence:**
`screenTransfer()` is unconditionally called inside `createTransfer()` at `src/lib/transfer-create.ts:166` and cannot be bypassed by any configuration flag. The structural guarantee is real. However:

1. The actual screener is `MockSanctionsScreener` (`src/lib/providers/sanctions-provider.ts:26-43`) matching against `WATCHLIST = ['john doe', 'jane roe', 'test blocked']` (`src/lib/compliance-config.ts:6`) — three placeholder names explicitly described in code comments as "clearly fake names for the prototype." There is no OFAC SDN, FinCEN, or commercial AML feed wired.
2. Sender screening silently no-ops when `senderName` is `undefined` (`src/lib/compliance.ts:36-38` defaults `senderHit` to `{ matched: false }`). Partner API callers who omit `sender.name` bypass sender-side screening entirely.
3. The `screener` parameter of `screenTransfer()` is injectable (`src/lib/compliance.ts:26`), making "structurally impossible" an overstatement — the guarantee rests on call-site convention, not language-level enforcement.
4. In the partner API path, `createTransfer` persists a blocked transfer row before surfacing the block to the caller — the claim "a match stops the transfer before it's ever created" is false for that path.

**Suggested fix (narrow the copy):**
State that "every transfer is routed through the SmartRemit sanctions check process using a built-in reference rule set (not a live commercial AML feed)." Add a note that a real OFAC/SDN integration is on the roadmap and that sender screening requires the sender legal name to be supplied. Separately, make `senderName` a required field in `CreateTransferInput` or add an explicit guard.

---

### C06 / C29 — "Full audit trail" / "Append-only per-partner audit log"

**Claim text:**
> "Full audit trail" / "Every sensitive reveal, KYC decision, and blocked attempt is written to an append-only, per-partner audit log."

**Code evidence:**
The `audit_events` Postgres table exists and is populated for: staff team mutations, payout-destination PII reveals, partner API calls, and outbox-worker ticket triage. However:

1. The highest-risk money operations — `cancelTransferAction`, `releaseTransferAction`, `rejectTransferAction`, `issueRefundAction`, `approveRefundAction`, `dismissRefundAction`, `retryRefundAction` (`src/app/admin-dashboard/actions.ts:55-182`) — write **zero** `audit_events` rows. No record of who released or cancelled a held transfer is written to the durable audit log.
2. Partner configuration mutations (`updatePartnerAction` and siblings) are not audit-logged.
3. The canonical KYC review path (`reviewKycAction`) logs to a **Redis hash** (`kyc_audit:{phone}`) via `kyc-case-store.ts:36-46`, not the durable Postgres `audit_events` table. Code comment (line 15) explicitly calls durable export "a Phase-5 concern."
4. The legacy `markCustomerVerifiedAction` (`src/app/admin-dashboard/customers/actions.ts:20-43`) bypasses both audit mechanisms entirely.
5. Blocked attempts land in the transfers ledger (not `audit_events`).

**Suggested fix (narrow the copy):**
Replace "Full audit trail" with "Audit trail covering staff account changes, PII reveals, and partner API calls." Add `audit_events` writes to transfer lifecycle actions (release, cancel, reject, refund) as a prerequisite before restoring the "full" characterization.

---

### C05-mock / C02-screening — Mock sanctions screener presented as compliance

**Already covered above under C05/C10/C20/C26/C32; consolidated here to flag for compliance counsel.**

A customer or regulator reading "screened" or "sanctions screening on every transfer" on the landing page would reasonably infer a real OFAC or commercial AML feed. The code runs a 3-name toy list. This is the most material compliance misrepresentation in the codebase.

---

## MEDIUM-RISK — Narrow (money-product accuracy)

### C18 / C12 — "Clear, flat fee" — false for credit card

**Claim text (src/app/page.tsx:437-439):**
> "$1.99 per bank transfer. No hidden fees. Clear, flat fee."

**Code evidence:**
`src/lib/fx.ts:79` sets credit-card fee as `round2(2.99 + 0.03 * amountUsd)` — a $2.99 base **plus 3% of the send amount**. A $500 credit-card transfer costs $17.99 in fees, not $1.99. Only bank transfer ($1.99) and debit card ($2.99) are genuinely flat. The $1.99 figure and "flat fee" language are inaccurate for credit-card users.

**Suggested fix (narrow the copy):**
Add disclosure: "Bank transfer: $1.99 flat. Debit card: $2.99 flat. Credit card: $2.99 + 3% of send amount." Remove "flat fee" unless scoped to bank transfers only.

---

### C21 / C35 / settlement-instruction-signing-claim — "Cryptographically signed" settlement instructions are conditional

**Claim text:**
> "SmartRemit signs an instruction to your rail." / "Settlement instructions: HMAC-SHA256 hex in x-signature."

**Code evidence:**
Both `src/lib/outbox-worker.ts:170` and `src/lib/providers/http-payment-provider.ts:159` guard signing with:
```
...(signingSecret ? { 'x-signature': signBody(rawBody, signingSecret) } : {})
```
If a partner has no `signingSecret` configured, the instruction is POSTed **with no signature and no error**. For `simulator`-type partners, signing is auto-provisioned (`src/app/admin-dashboard/partners/actions.ts:211`). For `http`-type partners (live integrations), it is optional. Inbound callbacks are correctly fail-closed (`payment-webhook-verify.ts:18`). Retries are bounded to 8 attempts, not open-ended "until your rail acks 2xx."

**Suggested fix (narrow the copy):**
State "settlement instructions are HMAC-SHA256 signed when a signing secret is configured; the hosted simulator rail enforces this by default." Make `signingSecret` required (not optional) in the `http`-type partner provisioning wizard, or add a runtime guard that rejects dispatch of unsigned instructions.

---

### C11 / C39 — "8 corridors, any direction" — Canada cannot send on default tenant

**Claim text (src/app/page.tsx:33, metadata at page.tsx:23):**
> "8 corridors. Any direction." / "Non-custodial remittance infrastructure across 8 corridors."

**Code evidence:**
`DEFAULT_PARTNER_COUNTRIES` in `src/lib/defaults.ts:18` is `['US','GB','AE','SG','AU','NZ','IN']` — 7 entries, not 8. Canada (`CA`) is excluded because `CALLING_CODE_TO_COUNTRY` maps `'1'` to `'US'` (NANP ambiguity), so a Canadian +1 number would be detected and served as US/USD. `drizzle/0006_default_partner_any_to_any.sql` seeds only these 7. Also, "8 corridors" conflates "8 country codes" with corridors — 8 any-direction countries implies up to 56 corridors (8×7).

**Suggested fix (narrow the copy):**
Change to "7 send corridors, 8 receive destinations on the default tenant" or "8 supported countries" and note Canada is receive-only unless a white-label partner opts it in.

---

### claim-beneficiaries-payout-encrypted — Beneficiary name and phone stored in cleartext

**Claim text (partner API docs):**
> "Payout details encrypted at rest."

**Code evidence:**
`createBeneficiaryRepo().createBeneficiary()` at `src/db/repos/aux-repos.ts:102` correctly encrypts `payoutDestinationEnc` (AES-256-GCM). However, the same `beneficiaries` table (`src/db/schema.ts:344-351`) stores `name` (line 345) and `recipient_phone` (line 350) as **plaintext `text` columns** with no encryption. The `transfers` table encrypts the equivalent field as `recipientLegalNameEnc`; the `beneficiaries` table does not apply the same treatment.

**Suggested fix (fix the code):**
Encrypt `beneficiaries.name` and `beneficiaries.recipient_phone` at the repo write layer, mirroring the `transfers` table's `recipientLegalNameEnc` treatment. Add a migration to encrypt existing rows.

---

### partner-rate-limit-claim — "120 req/min" is a window cap, not a sliding-window guarantee

**Claim text (admin dashboard docs):**
> "120 requests/minute per partner."

**Code evidence:**
`src/lib/partner-rate-limit.ts:13` uses a Redis INCR+EXPIRE fixed calendar-minute window (`Math.floor(Date.now() / 60_000)`). A partner can send 120 requests in the last second of minute N and 120 more in the first second of minute N+1 — 240 requests in ~2 seconds with no 429 issued. `Retry-After: 60` can be off by up to 59 seconds.

**Suggested fix (narrow the copy or fix the code):**
State "up to 120 requests per calendar-minute window" rather than "per minute." For a true 120 req/min sliding-window guarantee, replace with Upstash Redis rate limiter (sliding window algorithm).

---

## LOWER-RISK — Narrow (architecture accurate, readiness overstated)

The following claims are architecturally real but describe the **intended production design** rather than a deployed live-money system. The funding-capture seam (`getFundingProvider()` returns `MockFundingProvider` unconditionally, `src/lib/providers/funding-provider.ts:83-85`) and the mock payment rail (`getPaymentProvider()` defaults to `MockPaymentProvider`, `src/lib/providers/payment-provider.ts:115-135`) mean that **no real money moves in the current deployment**.

| ID | Claim summary | Gap |
|---|---|---|
| C01 | "Non-custodial, WhatsApp-native" badge | Architecture enforced; sender-side is mock-only — "non-custodial" holds today only because no real PSP exists |
| C02 | "Live FX → WhatsApp → hosted page → licensed partners settle → signed → screened → audited" | Flow exists; "screened" = mock watchlist; "licensed" = not code-enforced; "audited" = partial |
| C03 | "Non-custodial" (about page) | Settlement side enforced; B2C funding seam is mock-only stub |
| C07 | Rate-lock "holds it for you" | Lock is real (30 min draft TTL); agent hint says "~10 minutes"; legacy non-USD drafts re-quote live at mint |
| C08 | "Every reveal is written to the audit log" | Staff payout-destination reveal is audited; system-internal decrypts (settlement build, agent repeat, customer self-service) are not |
| C13 | "Rate you see is the rate you pay" | Mostly true; legacy non-USD drafts missing `feeSource`/`totalChargeSource` fall through to live re-quote at mint |
| C14 | "Never holds funds" | Settlement side enforced; b2c `captureFunding` seam is mock — "never" is true today by absence of real PSP, not by structural impossibility |
| C15 | "White-label kit" five features | All exist; "self-service dashboard" is a scoped view of platform dashboard, not a separate portal; branded bot requires BYO Meta credentials |
| C16 | "Lets people send money home" (metadata) | Architecture real; actual fund movement is simulated; about page discloses this at line 221 but metadata does not |
| C17 | "Licensed MTOs are the ones who actually move funds" | Structurally enforced for settlement; all rails are currently mock/simulator |
| C19 | "Users pay the licensed partner" | Settlement side enforced; sender-side funding capture is mock-only — no real PSP wired |
| C22 | "Both parties get a message when money is on its way" | Sender gets stage-1 "on its way" message unconditionally; recipient gets stage-2 "delivered" message only after partner rail confirms AND only if `recipientPhone` is populated |
| C23 | "Fail-closed HMAC verification" | True for inbound settlement callbacks with secret configured; outbound instructions are unsigned when `signingSecret` absent; shared `/api/whatsapp` route warns-and-proceeds when `META_APP_SECRET` unset |
| partner-api-idempotency-claim | "A replay never duplicates a transfer" | No duplicate row ever inserted (correct); but same key can mint different parameters if first attempt failed before minting — body-mismatch replay silently succeeds |
| C25 | "Only ever produce signed instructions" | True for http/simulator paths; mock self-advance (`MockPaymentProvider`) never produces any instruction |
| C27 | "AES-256-GCM + staff reveals audited" | Encryption is real; customer PII (fullName, DOB, address) decrypted by default on every read and displayed unmasked on admin customer detail page with no audit row |
| C28 | "Every external effect is an outbox row" | True for money-path effects; agent turns span Redis (`markSeen`) + Postgres (outbox) without atomic boundary — cross-store crash window can silently lose a turn |
| C30 | "What's real vs. simulated" (about page) | Accurate overall; KYC vendor (Persona) is conditionally live when `PERSONA_API_KEY` set, not categorically simulated as claimed |
| C31 | "Funds never touch SmartRemit" | True at settlement side; `captureFunding` seam in pay route will require re-evaluation when a real PSP is wired |
| C36 | "Unsigned callbacks are rejected with 401" | True for partner-facing URLs; `/api/payment-webhook/mock` skips verification when provider type is not webhook-driven |
| C37 | "Both parties notified on delivery" | Notifications sent inside Next.js `after()` — best-effort, not outbox-durable; crash after HTTP 200 silently loses both messages |

---

## Recommended Priority Actions

1. **[CRITICAL — fix code or remove claim]** Add a `licenceVerified` gate to partner activation (`C04`). Until then, remove "licensed" from all public-facing claims about partner status.
2. **[CRITICAL — narrow the copy]** Replace "sanctions screening" language with explicit disclosure that the current implementation uses a built-in prototype watchlist (3 names), not a real OFAC/SDN feed (`C05/C10/C20/C26/C32/claim-sanctions-not-delegable`).
3. **[HIGH — fix code]** Add `audit_events` writes to all transfer lifecycle actions (release, cancel, reject, refund, approve-refund) before claiming "full audit trail" (`C06/C29`).
4. **[HIGH — narrow the copy]** Disclose full fee schedule (bank $1.99 flat, debit $2.99 flat, credit $2.99 + 3%) and remove "flat fee" language (`C18/C12`).
5. **[HIGH — narrow the copy or fix code]** Make `signingSecret` required for `http`-type partners, or qualify "signed instructions" as "signed when a signing secret is configured" (`C21/C35/settlement-instruction-signing-claim`).
6. **[MEDIUM — fix code]** Encrypt `beneficiaries.name` and `beneficiaries.recipient_phone` to match the `transfers` table encryption posture (`claim-beneficiaries-payout-encrypted`).
7. **[MEDIUM — narrow the copy]** Correct "8 corridors, any direction" to reflect Canada's send-side exclusion on the default tenant (`C11/C39`).
8. **[LOWER — narrow the copy]** Qualify rate-limit claim as "per calendar-minute window" not "per minute" (`partner-rate-limit-claim`).

---

*This report is read-only. No code or marketing copy was modified. All evidence is traced to specific file paths and line numbers in the audited commit.*
