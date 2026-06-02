# Onboarding Provisioning Checklist — what YOU provide before/while we build Phase 2

Companion to `docs/superpowers/specs/2026-06-02-customer-onboarding-kyc-design.md`. These are the
external accounts / secrets that ACTIVATE the code we build (the code is done or buildable against
mocks; these make it live). Verify exact dashboard steps in the current Meta/Persona UIs.

---

## 0. Vercel env vars to add now (Phase 1 activation)

| Var | Value / how to generate | Notes |
|---|---|---|
| `FIELD_ENCRYPTION_KEY` | `openssl rand -hex 32` (64 hex chars = 32 bytes) | master key for field-crypto. **Different value per environment.** A real KMS replaces this later. |
| `PASSWORD_PEPPER` | `openssl rand -hex 32` | HMAC pepper for Argon2id. **Set ONCE before any customer registers; never rotate** without a forced-reset migration. |
| `OTP_DEV_MODE` | `true` in Preview/dev, **`false` in Production** (once the Meta template is approved) | dev-mode logs a masked line + skips the live send so the portal works before the template exists. |
| `WHATSAPP_AUTH_TEMPLATE` | the approved template name (default `verification_code`) | the OTP delivery template (below). |
| `META_APP_SECRET` | from Meta App → Settings → Basic → App Secret | (already a standing TODO) — verifies the inbound webhook signature. |

Set via Vercel CLI (`vercel env add <NAME> production`) or the dashboard. After adding prod vars,
a redeploy activates them.

---

## 1. Meta WhatsApp **AUTHENTICATION** template (makes OTP delivery live)

WhatsApp **forbids sending OTPs as free-form text** — they must go via an approved
`AUTHENTICATION`-category template. This is the long pole; start it now.

### Prerequisites
- **Meta Business Verification** of the Business Portfolio (`1420039710147462`) — auth templates are
  restricted to verified businesses. (Our test number is `+1 555-629-8293`, WABA `1423798669516574`.)
- A WhatsApp Business Account in good standing.

### Create it — WhatsApp Manager (easiest)
Meta Business Suite → **WhatsApp Manager → Message Templates → Create template**:
- **Category:** Authentication
- **Name:** `verification_code` (must match `WHATSAPP_AUTH_TEMPLATE`)
- **Language:** English (`en`) — matches our existing approved `transfer_delivered`
- **Body:** the fixed authentication body (you can't free-edit it): *"{{1}} is your verification code."*
  - ✅ enable **"Add security recommendation"** → appends *"For your security, do not share this code."*
- **Footer / expiry:** set **code expiration = 5 minutes** (renders *"This code expires in 5 minutes."* — must equal our server TTL).
- **Button:** add the required **OTP button**, type **Copy code** (`COPY_CODE`). (Not one-tap/zero-tap — those need a native app; we're web.)

### Or create it via the Business Management API (equivalent)
```jsonc
POST https://graph.facebook.com/v21.0/<WABA_ID>/message_templates
Authorization: Bearer <SYSTEM_USER_TOKEN>
{
  "name": "verification_code",
  "language": "en",
  "category": "AUTHENTICATION",
  "components": [
    { "type": "BODY", "add_security_recommendation": true },
    { "type": "FOOTER", "code_expiration_minutes": 5 },
    { "type": "BUTTONS", "buttons": [ { "type": "OTP", "otp_type": "COPY_CODE" } ] }
  ]
}
```
Our code already sends it correctly (the code is passed in **both** the body param and the
copy-code button param — `lib/whatsapp.ts sendOtpCode` + `authenticationTemplateParams`).

### After approval
Set `WHATSAPP_AUTH_TEMPLATE=verification_code` and `OTP_DEV_MODE=false` in Production → real OTPs flow.
Approval is usually fast for auth templates, but allow up to ~24h.

---

## 2. **Persona** sandbox (unblocks Phase 2 — real KYC, NIST IAL2)

We build the integration server-side: **create inquiry → one-time link → WhatsApp handoff → webhook
decides**. Raw ID/selfie/SSN stay on Persona; we store only `inquiry_id` + decision + last-4.

### Steps
1. **Sign up / request access** at withpersona.com → you'll get a **Sandbox** environment.
2. **Build an Inquiry Template** (Dashboard → Inquiry Templates) configured for **IAL2**:
   - **Government ID** (document verification),
   - **Selfie + Liveness** (passive; require iBeta PAD Level 2),
   - **Database / SSN verification** (the CIP non-documentary leg),
   - a **Watchlist report** (OFAC + global sanctions + PEP; enable continuous monitoring).
   - Publish it and **copy the template VERSION id** (`itmplv_…`) — we pin the version so the flow can't change under us.
3. **API key:** Dashboard → API Keys → create a **Sandbox** key.
4. **Webhook:** Dashboard → Webhooks → add an endpoint `https://smartremit.ai/api/persona-webhook`
   (we'll build this route in Phase 2), subscribe to `inquiry.*` + `report/watchlist.matched`, and
   **copy the webhook shared secret**.

### Env vars Phase 2 will read (give me these to go live; I can build against mocks without them)
| Var | From |
|---|---|
| `PERSONA_API_KEY` | Persona → API Keys (sandbox) |
| `PERSONA_WEBHOOK_SECRET` | Persona → Webhooks |
| `PERSONA_INQUIRY_TEMPLATE_VERSION_ID` | the `itmplv_…` you pinned |
| `PERSONA_ENVIRONMENT` | `sandbox` now, `production` later |

---

## 3. KMS (Phase-1 hardening — can defer)
Field-crypto runs on the app-managed `FIELD_ENCRYPTION_KEY` now, behind a provider seam. Before real
PII at scale, pick **AWS KMS** or **GCP KMS** (or a Vercel-Marketplace HSM) and we swap the provider —
call sites don't change. Tell me which and I'll wire it. Not a Phase-2 blocker.

---

## 4. What I need from YOU to START Phase 2 (the only real decision)
- **Build mode:** (a) you provision the Persona sandbox now and I build + test against it live, or
  (b) I build the full integration against the documented Persona API + a mock provider, and you
  provision the sandbox to flip it live. Either works; (b) lets me start immediately.
- If (a): the **4 Persona env values** above.
- **Confirm** the Phase-2 design choices (I'll default to these unless you say otherwise): Persona
  **Hosted Flow** (redirect link, not embedded), **IAL2** assurance level, webhook-is-source-of-truth.

---

## 5. Org / legal track (NOT code-blocking — flagged for go-live)
A real US money transmitter needs: **state MSB/money-transmitter license(s)**, a named **BSA/AML
Compliance Officer**, a written **AML program** (FinCEN 31 CFR 1022.210) + **GLBA Information
Security Program** (16 CFR 314.4) + **Incident-Response Plan**, **DPAs** with Persona/Upstash/Vercel/
Meta, and an **annual pen-test**. We build the technical controls; these are your organizational
deliverables before serving real customers.

---

## 6. Phase 2 (Persona KYC) — go-live runbook

The Phase-2 code ships **dormant**: with no `PERSONA_API_KEY`, `getKycProvider` keeps the
MockKycProvider and `/api/persona-webhook` fail-closes on the empty secret. No migration is
needed — every new field is optional and `kycReviewState===undefined` is treated as `none`
(grandfathered/legacy customers are unaffected).

To activate (in order):

1. **Set the Vercel PROD env vars** (sandbox values are already in local `.env.local`):
   - `PERSONA_API_KEY` (`persona_sandbox_…`)
   - `PERSONA_ENVIRONMENT=sandbox`
   - `PERSONA_WEBHOOK_SECRET` (`wbhsec_…`)
   - `PERSONA_INQUIRY_TEMPLATE_VERSION_ID` (`itmplv_…`)
   - `PERSONA_API_VERSION=2025-12-08`  (confirmed against the sandbox 2026-06-02)
   - `PERSONA_API_BASE=https://api.withpersona.com/api/v1`  (only if overriding the default)
2. **Merge + deploy** this phase (the PR). Vercel auto-deploys on merge.
3. **Enable the Persona webhook** (it was created **Disabled**) → it points at
   `https://smartremit.ai/api/persona-webhook`. Until enabled, no events are delivered.
4. **End-to-end sandbox test:** from the `/account/verify` portal CTA (or the bot's over-cap
   hand-off), open the hosted flow, complete a sandbox inquiry, and confirm:
   - the webhook flips the customer to `pending_review` (NOT `verified` — human-review-only),
   - the "Needs KYC review" queue on `/admin-dashboard/compliance` lists them,
   - Approve on the customer-detail page sets `kycStatus:'verified'` + an audit entry.
   - **Confirm the real `Persona-Signature` header casing** matches the verifier (Task-0 left
     this open while the webhook was disabled); adjust the route's header lookup if needed.
5. **(Optional, separate)** submit the 4 `verification_*` Meta templates so customer status
   messages stop using the free-form fallback.

**Deferred to later phases (not gaps):** SSN/TIN database verification step (no template in the
org yet), Persona continuous watchlist monitoring (locked on the sandbox trial), the verify-
before-send bot gate (Phase 3), and full maker-checker/SLA/round-robin case management (Phase 4).
