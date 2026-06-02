# Plan — Customer Onboarding **Phase 1**: Auth + OTP + Crypto Core

**Spec:** `docs/superpowers/specs/2026-06-02-customer-onboarding-kyc-design.md`
**Branch:** `feat/customer-onboarding-kyc`
**Scope:** the production-grade foundation — field encryption, Argon2id, WhatsApp OTP, customer auth
domain, minimal account portal. **No bot-flow / send-gate change** (that's Phase 3), so existing
behavior is byte-for-byte unchanged until later phases. Everything here is TDD'd.

## Execution model (per `sendhome-execution-interactive`)
Continuous subagent-driven: per task → implementer (TDD: failing test → implement → green) →
spec-review → code-quality-review → fix → commit on the branch → next. **No per-task pauses.**
Checkpoint at: this plan's approval (now), any genuine design gap, and before push/PR. New server
actions follow the mandatory security checklist. `rm -rf .next` before integration typecheck.

## Decisions — CONFIRMED (2026-06-02)
- ✅ **Argon2 library = `hash-wasm`** (pure-WASM, serverless-safe on Vercel, no native build). One
  new dependency.
- ✅ **Phase-1 encryption key = app-managed now + KMS seam**: a 32-byte key in a Vercel secret
  (`FIELD_ENCRYPTION_KEY`) behind an `EncryptionKeyProvider` interface, so a real **KMS** (AWS/GCP)
  drops in later without touching call sites.
- ✅ **OTP dev-mode**: until the Meta `AUTHENTICATION` template is approved, `sendOtpCode` logs the
  code under a dev/staging flag and no-ops the live send.

> **Status: awaiting user review of this plan + the spec. No code until the user says "approved."**

---

## Tasks

### Task 1 — `field-crypto`: AES-256-GCM envelope encryption + crypto-shred
**Test first** (`tests/field-crypto.test.ts`): encrypt→decrypt round-trips for strings/unicode;
ciphertext ≠ plaintext and differs per call (random IV); tamper in ciphertext/tag → decrypt throws
(GCM auth); a record whose wrapped data-key is dropped is undecryptable (crypto-shred); the
`EncryptionKeyProvider` seam is injectable (test uses a fixed test key).
**Implement** (`src/lib/field-crypto.ts`): `EncryptionKeyProvider` interface (`getMasterKey()` /
`unwrap()`); `EnvKeyProvider` (master key from `env.fieldEncryptionKey`); `encryptField(plaintext):
string` → compact `v1.<iv>.<wrappedDataKey>.<tag>.<ciphertext>` (base64url); `decryptField(s):
string`; per-field random data key wrapped by the master key (AES-256-GCM); `cryptoShred` semantics
= dropping the stored blob. Pure `node:crypto`, no dep.
**Done:** module + tests green; `env.ts` gains `fieldEncryptionKey` (optional; required-at-use).

### Task 2 — Argon2id password hashing (+ legacy scrypt back-compat)
**Test first** (`tests/password-argon2.test.ts`): `hashPassword` emits a PHC `$argon2id$…` string;
`verifyPassword` accepts the right pw, rejects wrong; **back-compat:** legacy `salt:hash` (scrypt)
still verifies; `needsRehash` true for legacy + below-target params, false for current; pepper
changes the hash (and a wrong pepper fails verify).
**Implement** (`src/lib/password.ts`): add `hash-wasm` Argon2id (m=19456,t=2,p=1); HMAC-pepper
pre-step (`env.passwordPepper`, optional → no-op if unset so existing staff hashes keep working);
`hashPassword`→PHC; `verifyPassword` branches on PHC-prefix (argon2) vs legacy `salt:hash` (existing
scrypt path, kept); `needsRehash(stored)`. Shared by staff + customer auth. **Lazy rehash** is wired
by callers on successful login (Task 5 + a staff follow-up).
**Done:** tests green; existing `password.test.ts` + staff login still pass; `package.json` adds
`hash-wasm`.

### Task 3 — `otp-store`: CSPRNG OTP, hashed, throttled, single-use
**Test first** (`tests/otp-store.test.ts`): `issueOtp` returns nothing leaky + stores a **hash**
(not the code) under an opaque key with TTL; `verifyOtp` succeeds once then the code is consumed;
resend overwrites the prior code (only one live); wrong code increments attempts, **5 wrong → code
burned**; send throttle (1/30s, ≤5/hr, ≤10/day per number) rejects; verify uses constant-time
compare; code never appears in the returned value or store key.
**Implement** (`src/lib/otp-store.ts`): `issueOtp(phone)` → `{ code }` returned ONLY to the caller
that sends it (never persisted plain); store `sha256(code)` + attempts + expiry in Redis (opaque
key `otp:<sha256(phone)>`); `verifyOtp(phone, code)` `timingSafeEqual` on hashes, attempt cap,
consume on success; throttle counters reuse the velocity pattern. `crypto.randomInt(0,1_000_000)`,
zero-padded to 6.
**Done:** tests green.

### Task 4 — WhatsApp `AUTHENTICATION` OTP template + `sendOtpCode`
**Test first** (`tests/whatsapp-otp.test.ts`): `authenticationTemplateParams(code)` emits body
param + button(index 0) param with the **identical** code; `sendOtpCode` calls `sendTemplate` with
the auth template name/lang; **dev-mode** (`env.otpDevMode`) logs + no-op sends; the code is not in
any thrown error.
**Implement** (`src/lib/whatsapp-templates.ts` + `whatsapp.ts`): `authenticationTemplateParams`,
`sendOtpCode(phone, code)` → `sendTemplate(AUTH_TEMPLATE, 'en', params)` (body+button). Extend
`sendTemplate` if needed so a button param at index 0 is supported (mirror `sendTemplateWithButton`).
Dev-mode env flag for pre-approval testing.
**Done:** tests green; documented that the Meta template must be approved to go live (spec §2).

### Task 5 — Customer auth domain (sessions, register/login/reset)
**Test first** (`tests/customer-auth-store.test.ts`, `tests/customer-auth.test.ts`,
`tests/pwned.test.ts`): register attaches to the existing phone-keyed `Customer` (or creates), email
+ password validated, **HIBP breach check** (mocked range API) rejects pwned, **collision** on an
already-registered phone; login verifies Argon2id pw + **lazy-rehashes** legacy; session = 256-bit,
Redis keyed by `sha256(id)`, **rotates on login**, **30-min idle / 12-h absolute**; logout destroys
server+cookie; reset token (256-bit, hashed, single-use, TTL, **revokes all sessions**, no
auto-login); brute-force: exp backoff + lock <100/account, per-IP/per-phone; **enumeration-safe
generic responses**.
**Implement:** `src/lib/pwned.ts` (HIBP k-anonymity, injectable fetch); `src/lib/customer-session-
cookie.ts` (`__Host-sr_session`, Secure/HttpOnly/SameSite=Lax); `src/lib/customer-auth-store.ts`
(register/login/session CRUD/reset, Redis hashed keys); `src/lib/customer-auth.ts`
(`getCurrentCustomer`/`requireCustomer`). PII fields (email) stored via `field-crypto`. Reuse the
velocity store for throttling.
**Done:** tests green; staff auth untouched (separate cookie/namespace).

### Task 6 — Minimal account portal (register → OTP → login) — UI + actions
**Test first** (`tests/account-actions.test.ts`): the server actions
(`registerAction`/`verifyOtpAction`/`loginAction`/`logoutAction`/`requestResetAction`) each follow
the security checklist (validate, rate-limit, enumeration-safe, collision, session rotation);
phone-bound onboarding token (`onboarding-token.ts`) is signed, single-use, short-TTL.
**Implement:** `src/lib/onboarding-token.ts`; `src/app/account/` (`.payapp`-themed: register, OTP
step, login, reset) + `src/app/account/actions.ts`; the bot sends the `/onboard/<token>` link
(read-only wiring; the hard SEND-GATE stays Phase 3). 16px inputs, WCAG-AA, trust copy.
**Done:** `rm -rf .next` → lint + typecheck + full suite + build green; smoke can reach `/account`.

---

## Phase-1 exit criteria
- All tasks green; **full suite + lint + typecheck + build** pass; existing behavior unchanged
  (no bot/send-gate change); staff auth unaffected.
- New deps: `hash-wasm` only. New env (optional until used): `FIELD_ENCRYPTION_KEY`,
  `PASSWORD_PEPPER`, `WHATSAPP_AUTH_TEMPLATE`, `OTP_DEV_MODE`.
- Wrap-up summary → on your **"deploy"**, drive the full PR→ci→merge→smoke pipeline.
- **Then** Phase 2 (Persona) spec/plan, which needs your Persona sandbox keys to go live.
