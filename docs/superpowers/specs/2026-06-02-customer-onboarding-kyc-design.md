# Customer Onboarding · Identity · KYC/AML · Auth — Design Spec

**Date:** 2026-06-02
**Status:** Draft for approval
**Reframe:** SmartRemit is now a **real production application** (not a prototype). Every standard
below is industry-grade and cited so we build to it **once** and don't keep reworking.

This spec is decomposed into **phases**; each phase ships through the normal spec→plan→TDD→CI/CD
pipeline. The detailed task breakdown for **Phase 1** lives in the companion plan doc.

---

## 1. Goal & locked decisions

Build a regulator-defensible customer onboarding subsystem: a **persistent customer account +
login**, **WhatsApp phone OTP**, **Persona KYC (IAL2)**, a **hard verify-before-send AML gate**,
**field-encrypted PII with data minimization**, and a **partner + platform compliance review queue**.

Locked from the brainstorm (do not re-litigate without explicit input):
- **Real app, industry standard.** Production-grade architecture + security now.
- **Persona = KYC vendor.** Real Inquiry → hosted-flow handoff → webhook integration (activated by
  user-provisioned keys). Keep the provider interface vendor-agnostic.
- **Identity: phone is the spine.** The account attaches to the existing phone-keyed `Customer`;
  the US phone = WhatsApp number; OTP re-confirms.
- **Persistent customer login** (foundation for future tracking/receipts/insights).
- **Hard verify-before-send gate, EVERYONE** (incl. existing/grandfathered → must onboard);
  **human review only** (no auto-approve). The 3-day T0 observation window + $500/day cap **survive
  post-verification** → T1 (so "KYC doesn't lift the cap during observation" still holds; what
  changed: unverified customers can no longer send at all).
- **Review = partner-admins (own customers) + platform staff (all)**, scope-gated, audit-logged.
- **Data minimization:** Persona holds raw ID/selfie/full-SSN; we store only tokens + last-4,
  field-encrypted.

---

## 2. Honest scope: this is a program, not a slice

The research makes clear a real onboarding subsystem spans identity, AML, security, and privacy
law. We split the **code we build to standard now** from **what you must provision** (legal /
vendor / operational), and we phase the code.

### What needs YOUR provisioning to ACTIVATE (we build the real integration; it goes live when these exist)
| Item | Why | Blocks |
|---|---|---|
| **Persona account + API key + webhook secret + an IAL2 inquiry template (version-pinned)** | the KYC vendor | Phase 2 going live (Phase 2 code + sandbox build now) |
| **Meta Business Verification + an approved `AUTHENTICATION` OTP template** | WhatsApp policy forbids free-form OTP | OTP delivery going live (Phase 1 code + dev-mode build now) |
| **A KMS (AWS/GCP KMS or Marketplace HSM) for envelope encryption keys** | GLBA field-level encryption | hardening the encryption from app-key → KMS (Phase 1 builds the seam) |
| **US money-transmitter license(s) + a banking/IMPS partner** | to actually move money | real money movement (separate Lane C program; out of THIS spec) |
| **Named BSA/AML Compliance Officer, written AML program + GLBA Information Security Program, IRP, annual pen-test, DPAs with Persona/Upstash/Vercel/Meta** | GLBA 16 CFR 314.4 + FinCEN 31 CFR 1022.210 | regulatory go-live (we build the *technical* controls; these are org/legal deliverables) |

### Phase decomposition (each its own spec-aligned PR)
- **Phase 1 — Auth + OTP + crypto core** (no external vendor needed to build): Argon2id, customer
  auth domain, `__Host-` AAL2 sessions, WhatsApp OTP engine + AUTHENTICATION-template wiring,
  field-level envelope-encryption module (app-key now, KMS seam).
- **Phase 2 — Persona KYC integration**: real Inquiry/hosted-flow/webhook + the onboarding portal +
  the Persona status→WhatsApp state machine.
- **Phase 3 — Verify-before-send AML gate**: hard gate in the agent/tools/tier-rules; the
  "everyone must onboard" migration; grandfathered → must-onboard.
- **Phase 4 — Compliance review & case management**: case state machine, code-enforced
  maker-checker, tenant-scoped reviewer RBAC + platform override/QA, append-only durable audit log,
  risk profile + EDD + re-KYC cadence.
- **Phase 5 — GLBA/privacy operationalization**: retention/disposal (crypto-shred) cron, CCPA
  rights endpoints, data inventory, monitoring — plus the non-code program deliverables above.

This spec covers all phases at design level; **Phase 1 is fully task-broken-down in the plan.**

---

## 3. Industry-standard requirements (the durable reference — build to THIS)

### 3a. Identity proofing — NIST 800-63A **IAL2** (Persona)  *(MUST)*
- Evidence set: **1 SUPERIOR or 1 STRONG government ID + passive-liveness selfie + address
  confirmation**; **no KBV-only**. Liveness vendor must be **iBeta PAD Level 2 / ISO 30107-3**.
- **Persona architecture (server-driven hosted flow):** `POST /inquiries` (pinned
  `inquiry-template-version-id`, `reference-id` = our customer id, `Idempotency-Key`) →
  `generate-one-time-link` → send link over WhatsApp → customer completes capture **on Persona's
  domain (raw PII never touches us)** → **webhook is the source of truth** (never the redirect).
- **Webhook security (MUST):** `Persona-Signature` = `t=<ts>,v1=<hmac>`; HMAC-SHA-256 over the raw
  `"<ts>.<body>"`, constant-time compare, dual-secret rotation, **~5-min replay window**,
  idempotency log (events arrive >1× and out of order; order by `created-at`), CSRF-exempt route,
  return 2xx fast + async work.
- **Watchlist (MUST):** Persona Watchlist report inside the inquiry (OFAC + global sanctions + PEP,
  + adverse media SHOULD) with **continuous monitoring**; any `report/watchlist.matched` → hard
  hold → compliance queue.
- CIP data set persisted (per §4): name, DOB, residential street address, **polymorphic ID
  number** `{type: SSN|ITIN|PASSPORT|ALIEN_ID|OTHER_GOV_ID, value(never full), country}`; require 18+.

### 3b. Customer authentication — OWASP ASVS v5 + NIST 800-63B **AAL2**  *(MUST)*
| Control | Value |
|---|---|
| Password hash | **Argon2id m=19456, t=2, p=1**, 16-byte salt, store full PHC string (replaces the below-floor default-scrypt) |
| Pepper | HMAC pre-step, key in a Vercel secret (`PASSWORD_PEPPER`), **never** in Redis |
| Re-hash | lazy upgrade on next login when params < target |
| Password policy | min **8** (nudge 12+, strength meter), max ≥64, full UTF-8, **no composition rules, no rotation**, **HIBP k-anonymity** breach check on set/change/reset, no security questions |
| Session id | **256-bit** CSPRNG, opaque; Redis key = `sha256(id)` so a dump leaks nothing |
| Cookie | `__Host-sr_session; Secure; HttpOnly; SameSite=Lax; Path=/` (Lax, because the WhatsApp link→page nav is top-level cross-site) |
| Rotation | new id on login + on password change |
| Timeouts | **30-min idle / 12-h absolute** (AAL2) |
| Brute force | exp. backoff + CAPTCHA after 5 fails; hard cap **<100/account** (NIST SHALL); per-IP + per-phone limits; generic "Invalid login" |
| Reset | 256-bit token, hashed at rest, single-use, TTL 5–60 min, enumeration-safe, **revoke all sessions on reset**, no auto-login; current-pw required for in-session change |
| MFA / AAL2 | password **+** WhatsApp OTP on login; re-prompt the 2nd factor at the verify-before-send boundary; TOTP/WebAuthn on roadmap |

### 3c. WhatsApp phone OTP — NIST 800-63B + Meta policy  *(MUST)*
6-digit CSPRNG (`crypto.randomInt`, allow leading zeros); **5-min** server TTL (≤10 NIST ceiling);
single-use (consume on success, resend overwrites the one live code); **constant-time compare**;
store only a **hash** in Redis under an opaque key, **never log the code**; per-code ≤5 wrong
guesses then burn; ≤10 failed/number/day → temp lock; send throttle 1/30s + backoff, ≤5/hr ≤10/day
per number + per-IP caps + 8-country geo allow-list; enumeration-safe responses. **Delivery: a
Meta-approved `AUTHENTICATION` template only** (free-form OTP is forbidden even in-window) —
`COPY_CODE` button, `add_security_recommendation:true`, `code_expiration_minutes:5`, code passed in
**both** body + button params. Phone-OTP is a **RESTRICTED authenticator** (possession proof, NOT
the AML control); a **phone-number change = re-verification event**; SIM-swap/line-type signal
check before high-value actions (SHOULD).

### 3d. PII protection — GLBA Safeguards (16 CFR 314.4) + NIST 800-122 + CCPA  *(MUST)*
- **Data classification → controls** (drives everything):
  | Class | Examples | Treatment |
  |---|---|---|
  | C3 (restricted) | **full SSN/TIN, raw ID images, selfie/biometric, full card PAN** | **NEVER on our servers** — Persona/processor holds; we keep a token + last-4 |
  | C2 (sensitive) | full phone, bank acct/IFSC, recipient, address, DOB, ssn_last4, persona_inquiry_id | **field-level envelope encryption** (AES-256-GCM, KMS) + audit-log on read |
  | C1 (internal) | first name, transfer amounts, schedules, status | infra at-rest + TLS, access-scoped |
  | C0 | FX rate, country list | standard |
- **Field-level envelope encryption** (not Upstash-at-rest-only): AES-256-GCM; KMS master key wraps
  per-record data keys; only ciphertext + wrapped key stored. **Crypto-shred** (delete data key) =
  secure disposal. (A leaked `KV_REST_API_TOKEN` must yield only ciphertext — this is what keeps a
  leak out of the FTC 30-day-notification + CCPA $100–$750/consumer triggers.)
- **Retention:** max(BSA **5 yr**, Safeguards 2-yr disposal); **10 yr** for OFAC/sanctions records;
  transaction + CIP records 5 yr (default 6); other PII ≤2 yr post-last-use; OTP/session minutes–days.
  Audit log must be **durably persisted beyond Redis** (Redis is not a 5–10 yr system of record).
- **GLBA program (314.4):** Qualified Individual, written risk assessment, access controls +
  audit-log-on-PII-read, encryption in transit+at rest, MFA on staff access, secure disposal,
  monitoring, annual pen-test + 6-mo vuln scans, IRP + **30-day FTC breach-notification runbook**,
  annual board report, service-provider DPAs. (Build the *technical* controls; the rest are org
  deliverables flagged in §2.) Don't lean on the <5,000-consumer exemption.
- **CCPA/CPRA:** know/delete/correct (45+45 days), opt-out (15 bus. days), data-minimization in the
  privacy notice; rely on the GLBA carve-out for transaction data, govern marketing/analytics under
  CCPA.

### 3e. Onboarding UX — just-in-time KYC (Wise/Remitly/Felix)  *(MUST/SHOULD)*
- **Don't front-wall KYC.** Order: (1) account + WhatsApp OTP (in chat); (2) build the whole first
  transfer in chat (destination/amount/recipient — no PII/SSN/ID in the thread); (3) **KYC is the
  gate immediately before "send."** The built transfer is the conversion engine.
- **Sensitive capture only on a single-use, short-expiry secure web link** (our `/pay`-style
  pattern) → Persona hosted flow + card/bank entry. Back to chat with a templated status message.
- **Status state machine** drives the gate off **Persona webhooks** (not polling), one stable
  `reference-id`/customer, with a Persona-status → SmartRemit-state → WhatsApp-message mapping for
  every state; **always state a time expectation; never strand on "Pending."** New templates:
  `verification_needed / _in_progress / verified / verification_failed`.
- **<3-min KYC budget**, obsess over document upload (highest drop step); WCAG 2.2 AA on the secure
  pages with a review-confirm-before-send step; trust copy ("why + encrypted + ~2 min") beside each
  sensitive ask. Repeat sends skip straight to confirm (KYC is a one-time gate) — tell the user up
  front ("first transfer is a bit slower, then instant").

### 3f. Compliance review & case management — FFIEC + maker-checker  *(MUST)*
- **Code-enforced maker-checker / four-eyes** on the consequential transitions (approve-to-send,
  reject/off-board, sanctions/PEP override): **maker ≠ checker enforced at the data layer**;
  mandatory for High-risk/PEP/sanctions; single-reviewer clear allowed for clean Low-risk.
- **Case state machine:** `NEW → PENDING_REVIEW → NEEDS_INFO → IN_REVIEW → {APPROVED_TO_SEND |
  REJECTED | ESCALATED_EDD}`; `ESCALATED_EDD` requires **BSA Officer + four-eyes**. Auto-create on
  any Persona failure / AML / velocity / sanctions flag; round-robin assign within the owning
  partner; `NEEDS_INFO` pauses the SLA + pings the customer.
- **Tenant-scoped RBAC + platform override-on-all:** roles `PARTNER_REVIEWER`,
  `PARTNER_BSA_OFFICER`, `PLATFORM_REVIEWER`, `PLATFORM_BSA_OFFICER`, `PLATFORM_ADMIN`. Partner
  reviewers see only their own customers; **platform sees + overrides all** and holds **sole
  terminal/SAR authority**; platform **QA-samples** partner decisions (the FinCEN agent-monitoring +
  "ultimate responsibility" requirement). Raw-PII view gated behind a separate `view_raw_pii`
  permission, itself audit-logged. (Builds on our existing `canSee`/scoped-store + hardened actions.)
- **Append-only, reason-bearing audit log** (actor+role+tenant, before→after, UTC, mandatory
  "why"), no edit/delete, durable beyond Redis, **5 yr / 10 yr (sanctions)**, exportable.
- **Risk profile** per customer (rating + factors + timestamp), recomputed on triggers; **EDD** for
  High/PEP/sanctions (source-of-funds + BSA-Officer four-eyes); **re-KYC cadence** High 12mo /
  Med 2–3yr / Low 3–5yr + event triggers (sanctions update, PII change, velocity, 30–90-day window)
  via the existing `/api/cron`.

---

## 4. Data model (additive, optional, lazy-fill → no blocking migration; values field-encrypted)

New on `Customer` (encrypted C2 unless noted):
- Auth: `email?` (verified), `passwordHash?` (PHC string, C1 — it's already a hash), `passwordUpdatedAt?`.
- Phone verification: `phoneVerifiedAt?`.
- KYC: `kycInquiryId?` (Persona, C2), `kycRiskRating?` ('low'|'medium'|'high'), `kycReviewState?`
  (the case state), `idDocType?`, `idLast4?`, `ssnLast4?`, `kycApprovedBy?`, `kycApprovedAt?`,
  `nextReviewDue?`. (`kycStatus` already exists — extend its lifecycle.)
- The full SSN/ID/selfie are **never stored** (Persona holds them).

New stores/modules: `customer-auth-store` (sessions, hashed-key), `otp-store`, `field-crypto`
(envelope encryption), `kyc-case-store` (review cases + audit), `risk-profile`. The append-only
audit log gets a durable export path (object storage) for 5–10yr retention.

---

## 5. Phase 1 — what we build first (detail in the plan doc)

Lowest external dependency, highest foundational value; everything here is buildable now (OTP
delivery runs in dev-mode-log until your Meta `AUTHENTICATION` template is approved):

1. **`field-crypto`** — AES-256-GCM envelope encryption module with a clean KMS seam (app-managed
   master key from a Vercel secret now; `EncryptionKeyProvider` interface so AWS/GCP KMS drops in).
   Crypto-shred delete. Encrypt the C2 fields we already store + the new ones.
2. **Argon2id** — replace `password.ts` scrypt with Argon2id (m=19456,t=2,p=1) + pepper + PHC
   format + lazy-rehash-on-login; keep `verifyPassword` back-compatible with existing scrypt hashes
   during migration (detect by PHC prefix). Applies to staff too (shared module).
3. **Customer auth domain** — `customer-auth-store` (register/login/logout/reset, `__Host-sr_session`
   256-bit sessions hashed in Redis, rotation, 30m/12h timeouts), HIBP breach check, brute-force
   throttle/lockout (reuse the velocity pattern), enumeration-safe + generic errors, account attaches
   to the existing `Customer` by phone.
4. **WhatsApp OTP engine** — `otp-store` (CSPRNG 6-digit, hashed, 5-min TTL, single-use, attempt +
   send throttles, constant-time) + an `AUTHENTICATION`-template builder + `sendTemplate` extension
   (body+button param) with a dev-mode fallback (log code) until Meta approves the template.
5. **AAL2 login** — password + OTP step on customer login.

All TDD'd. No bot-flow or send-gate change yet (that's Phase 3), so existing behavior is unchanged
until the gate lands.

---

## 6. Testing & rollout
- **TDD every task** (pure crypto/auth/otp logic is highly testable; UI pages per repo convention).
- Mirror the existing harness (fakeRedis, vi.mock for next/headers/navigation, mocked WhatsApp).
- Sentinel-guarded migration only where a backfill is needed (most fields lazy-fill → none for
  Phase 1; the "everyone must onboard" state change is a Phase 3 migration with grandfathering).
- CI/CD ship on "deploy"; `curl /api/cron` post-merge if a phase adds a sentinel migration.

## 7. Open provisioning items + flagged decisions (for your call)
- **Persona account** — do you have/will you create one (sandbox first)? Phase 2 builds against it.
- **Meta Business Verification** — needed for the OTP `AUTHENTICATION` template (the long pole;
  start now). Phase 1 ships with dev-mode OTP until approved.
- **KMS** — AWS KMS, GCP KMS, or a Vercel-Marketplace HSM? Phase 1 builds the seam with an app key;
  pick the KMS for the hardening step.
- **BSA Officer + AML/GLBA program docs + pen-test + DPAs** — org/legal deliverables we can't write
  in code; flagged so they're tracked toward go-live.
