# Phase 2 — Persona KYC Integration · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `MockKycProvider` with a real, server-driven **Persona** identity-verification integration (Inquiry → hosted-flow handoff → signed webhook as source of truth), wire a customer-facing entry (portal CTA **and** WhatsApp one-time link), drive a Persona-status→WhatsApp state machine, and surface results in a **human-review queue** — without touching the send/cap path (that gate is Phase 3).

**Architecture:** A thin `persona-client` (REST) + a `verifyPersonaSignature` helper + a webhook event parser feed a pure `applyKycEvent` state machine. `PersonaKycProvider` implements the existing `KycProvider` seam; a `getKycProvider()` factory selects it when `PERSONA_API_KEY` is set. The webhook route (`/api/persona-webhook`) verifies → dedupes → applies → persists → fires a WhatsApp status template via `after()`. A `kyc-case-store` adds review-state + an append-only audit log; the admin compliance page gains a "Needs KYC Review" queue and the customer-detail page gains reason-bearing Approve/Reject actions. **Human-review-only: no Persona event ever auto-sets `kycStatus:'verified'`** — Persona drives `kycReviewState`; only a human sets `verified`/`rejected`.

**Tech Stack:** Next.js 16 App Router (route handlers + server actions), TypeScript, Vitest (fakeRedis + `vi.mock`), Upstash Redis, `node:crypto` (HMAC-SHA256, `timingSafeEqual`), Meta WhatsApp Cloud API, Persona REST API (version `2025-12-08`, kebab key inflection).

---

## Locked decisions feeding this plan

- **Entry = both:** a logged-in `/account/verify` portal CTA **and** a bot-sent WhatsApp one-time link (the bot already calls `startVerification` at `tools.ts:647,1384`; Phase 2 makes the returned URL a real Persona hosted-flow link).
- **Review = fuller now:** case states + reason capture + append-only KYC audit log + watchlist/PEP surfacing. (Four-eyes/maker-checker enforcement, SLA timers, round-robin assignment stay Phase 4.)
- **Human-review-only:** clean Persona pass → `kycReviewState:'pending_review'`, `kycStatus` stays `'pending'`; a human Approve sets `kycStatus:'verified'`.
- **Data minimization:** persist only `kycProviderRef` (inquiry id), `idLast4`, `idDocType`, status/review-state, watchlist/PEP boolean hit flags, and audit metadata. **Never** the full ID number, SSN, images, or selfie — Persona holds those. (Do **not** populate the existing full `govIdNumber` from Persona.)

## Hard boundary — do NOT touch (Phase 3 territory)

Per the codebase audit, sends are gated **only** by tier/cap via `deriveTier()` reading `customer.kycStatus`. Phase 2 must not add or move that gate:
- ❌ Do **not** change `src/lib/tier-rules.ts` (`deriveTier`, caps, the 3-day observation window).
- ❌ Do **not** add `kycStatus` checks in `compliance.ts`, `transfer-create.ts`, `pay-finalize.ts`, or the send tools.
- ✅ Phase 2 only: real provider behind the seam, the webhook, the review state/queue, the portal/bot entry, status templates.
- ✅ `kycStatus` still drives tier indirectly — but **only humans** move it to `verified`/`rejected` (same as today's admin actions); Persona moves the new `kycReviewState`, never `kycStatus` to a terminal value.

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `scripts/persona-spike.mjs` | Create (throwaway) | Task 0: hit the real sandbox, capture exact inquiry + webhook + signature shapes into fixtures |
| `tests/fixtures/persona/*.json` | Create | Recorded real webhook/inquiry payloads used as test fixtures |
| `src/lib/env.ts` | Modify | Add 5 `PERSONA_*` getters + 4 `WHATSAPP_VERIFICATION_*` template-name getters |
| `src/lib/types.ts` | Modify | Add Phase-2 KYC fields + `KycReviewState` + `KycCaseEvent` types |
| `src/lib/providers/persona-client.ts` | Create | Low-level REST: `createInquiry`, `getInquiry`, `generateOneTimeLink` |
| `src/lib/providers/persona-signature.ts` | Create | `verifyPersonaSignature(rawBody, header, secrets, nowMs)` — t.body HMAC, multi-secret, replay |
| `src/lib/providers/persona-webhook-parse.ts` | Create | Pure: kebab payload → `PersonaEvent` (event id, name, inquiry id, reference-id, status, watchlist/pep) |
| `src/lib/kyc-state-machine.ts` | Create | Pure `applyKycEvent(customer, event)` → field deltas (the heart; human-review-only) |
| `src/lib/providers/persona-kyc-provider.ts` | Create | `PersonaKycProvider implements KycProvider` |
| `src/lib/providers/kyc-provider.ts` | Modify | Add `getKycProvider(customerStore, appBaseUrl)` factory |
| `src/lib/kyc-case-store.ts` | Create | Review-state read/write + append-only audit log (`kyc_audit:<phone>`) + idempotency set |
| `src/app/api/persona-webhook/route.ts` | Create | Verify → dedupe → parse → applyKycEvent → persist → `after()` WhatsApp status |
| `src/lib/whatsapp-templates.ts` | Modify | `verificationStatusParams` + 4 template-name consts |
| `src/lib/whatsapp.ts` | Modify | `sendVerificationStatus(phone, state, ...)` helper (fail-soft via `sendTemplateOrText`) |
| `src/app/account/verify/page.tsx` + `actions.ts` | Create | `requireCustomer` → start inquiry → redirect to hosted flow; status view |
| `src/app/account/page.tsx` | Modify | "Verify your identity" CTA reflecting current state |
| `src/app/admin-dashboard/compliance/page.tsx` | Modify | "Needs KYC Review" queue |
| `src/app/admin-dashboard/customers/[phone]/page.tsx` | Modify | Show Persona result + watchlist/PEP + reason-bearing Approve/Reject |
| `src/app/admin-dashboard/customers/actions.ts` | Modify | `reviewKycAction` (approve/reject, reason required, audit-logged, scope-gated) |
| `docs/onboarding-provisioning-checklist.md` | Modify | "Enable the webhook" step + prod env vars |

---

## Task 0: Persona sandbox spike — confirm exact wire shapes (NOT TDD; a recorded spike)

**Why:** the research pass was rate-limited, so we confirm Persona's real `2025-12-08`/kebab shapes against the live sandbox instead of guessing. Output = JSON fixtures the later tasks assert against. Secrets are already in `.env.local`.

**Files:**
- Create: `scripts/persona-spike.mjs`
- Create (output): `tests/fixtures/persona/inquiry-created.json`, `tests/fixtures/persona/one-time-link.json`, `tests/fixtures/persona/inquiry-get.json`

- [ ] **Step 1: Write the spike script** — loads `.env.local`, creates an inquiry from the pinned template version, generates a one-time link, fetches the inquiry, and prints + writes each raw JSON response.

```js
// scripts/persona-spike.mjs — run with: node --env-file=.env.local scripts/persona-spike.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
const KEY = process.env.PERSONA_API_KEY;
const TEMPLATE_VERSION = process.env.PERSONA_INQUIRY_TEMPLATE_VERSION_ID;
const VERSION = process.env.PERSONA_API_VERSION ?? '2025-12-08';
// CONFIRM base in this spike; try api.withpersona.com first, fall back to withpersona.com.
const BASE = process.env.PERSONA_API_BASE ?? 'https://api.withpersona.com/api/v1';
const H = {
  Authorization: `Bearer ${KEY}`,
  'Persona-Version': VERSION,
  'Key-Inflection': 'kebab',
  'Content-Type': 'application/json',
};
mkdirSync('tests/fixtures/persona', { recursive: true });
const dump = (name, obj) => { writeFileSync(`tests/fixtures/persona/${name}.json`, JSON.stringify(obj, null, 2)); console.log(`\n=== ${name} ===\n`, JSON.stringify(obj, null, 2).slice(0, 1500)); };

const created = await (await fetch(`${BASE}/inquiries`, {
  method: 'POST',
  headers: { ...H, 'Idempotency-Key': `spike-${VERSION}-1` },
  body: JSON.stringify({ data: { attributes: { 'inquiry-template-version-id': TEMPLATE_VERSION, 'reference-id': 'spike-customer-0001' } } }),
})).json();
dump('inquiry-created', created);
const inquiryId = created?.data?.id;
if (!inquiryId) { console.error('NO INQUIRY ID — inspect the response above; adjust base/headers/body and re-run.'); process.exit(1); }

const otl = await (await fetch(`${BASE}/inquiries/${inquiryId}/generate-one-time-link`, { method: 'POST', headers: H })).json();
dump('one-time-link', otl);

const got = await (await fetch(`${BASE}/inquiries/${inquiryId}`, { headers: H })).json();
dump('inquiry-get', got);

console.log('\n>>> RECORD THESE PATHS FOR THE PLAN:');
console.log('  inquiry id      :', inquiryId, '(expect data.id, prefix inq_)');
console.log('  inquiry status  :', got?.data?.attributes?.status);
console.log('  reference-id    :', got?.data?.attributes?.['reference-id']);
console.log('  one-time-link   : look for a *-link / url field in one-time-link.json above');
```

- [ ] **Step 2: Run it against the sandbox**

Run: `node --env-file=.env.local scripts/persona-spike.mjs`
Expected: three JSON blobs written to `tests/fixtures/persona/`. If the base URL or header names are wrong, the first response is an error JSON — adjust `PERSONA_API_BASE` / header casing and re-run until `inquiry id` prints.

- [x] **Step 3: Record confirmed facts inline in this plan** — ✅ **CONFIRMED 2026-06-02 against the live sandbox:**
  - **Base URL:** `https://api.withpersona.com/api/v1` (create → HTTP 201).
  - **Headers accepted:** `Authorization: Bearer <key>`, `Persona-Version: 2025-12-08`, `Key-Inflection: kebab`, `Content-Type: application/json`, `Idempotency-Key`.
  - **Create body:** `{ data: { attributes: { 'inquiry-template-version-id': <itmplv_…>, 'reference-id': <phone> } } }` → returns `data.id` (`inq_…`), `data.attributes.status`.
  - **One-time link:** `POST /inquiries/{id}/generate-one-time-link` → URL at **`meta.one-time-link`** (`https://withpersona.com/verify?code=…`). ⇒ Task 3's `persona-client.generateOneTimeLink` path `j.meta['one-time-link']` is CORRECT.
  - **Inquiry attribute keys (kebab):** `status, reference-id, note, behaviors, tags, creator, reviewer-comment, updated-at, created-at, started-at, expires-at, completed-at, failed-at, marked-for-review-at, decisioned-at, expired-at, redacted-at, previous-step-name, next-step-name, fields`. ⇒ status lifecycle = `created → started → completed → {decisioned: approved|declined} | failed | marked-for-review | expired`.
  - **⚠️ `fields` keys are snake_case** (the template's own field names), NOT kebab: e.g. `current_government_id` (type `government_id`), `selected_id_class`, `selected_country_code`, `address_street_1`. The top-level attrs are kebab; only `fields.*` is snake. **The id-number source needs a COMPLETED inquiry to confirm** (the spike inquiry is `created`, all values null) — Task 5 uses defensive multi-key extraction and `idLast4` is display-only (a miss = no last-4 shown, never a crash); confirm the exact key during go-live with a completed sandbox inquiry.
  - **Still TODO (webhook disabled):** the exact `Persona-Signature` header casing + a real event payload — captured at go-live (runbook). The Task-4 verifier + Task-5 parser are written format-stable so only constants/field-keys may need a tweak.

- [ ] **Step 4: Capture a real webhook payload + signature** — in the Persona dashboard, temporarily set the webhook to a request-capture endpoint (e.g. an RequestBin/webhook.site URL) OR use the dashboard's "send test event", complete a sandbox inquiry, and save one captured delivery's raw body to `tests/fixtures/persona/webhook-inquiry-completed.json` and note the exact `Persona-Signature` header format. (If capture isn't feasible now, Task 5 uses a hand-built fixture matching the documented shape and we reconcile when the webhook is enabled.)

- [ ] **Step 5: Commit the fixtures (NOT the spike's secrets)**

```bash
git add scripts/persona-spike.mjs tests/fixtures/persona/
git commit -m "chore(kyc): Persona sandbox spike + recorded fixtures (Task 0)"
```
> The spike reads secrets only from `.env.local` (gitignored) and writes no secrets into fixtures — verify the fixtures contain no `Bearer`/`wbhsec_` strings before committing.

---

## Task 1: Persona + verification-template env getters

**Files:**
- Modify: `src/lib/env.ts` (after the `whatsappAuthTemplate` getter, ~line 102)
- Test: `tests/env-persona.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { env } from '@/lib/env';

describe('Persona env getters', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('reads PERSONA_* values', () => {
    vi.stubEnv('PERSONA_API_KEY', 'persona_sandbox_x');
    vi.stubEnv('PERSONA_WEBHOOK_SECRET', 'wbhsec_x');
    vi.stubEnv('PERSONA_INQUIRY_TEMPLATE_VERSION_ID', 'itmplv_x');
    expect(env.personaApiKey).toBe('persona_sandbox_x');
    expect(env.personaWebhookSecret).toBe('wbhsec_x');
    expect(env.personaInquiryTemplateVersionId).toBe('itmplv_x');
  });
  it('defaults version + base + dev-friendly empties when unset', () => {
    expect(env.personaApiVersion).toBe('2025-12-08');
    expect(env.personaApiBase).toBe('https://api.withpersona.com/api/v1');
    expect(env.personaApiKey).toBe(''); // optional ⇒ '' so MockKycProvider stays selected
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run tests/env-persona.test.ts` → FAIL (`personaApiKey` undefined).

- [ ] **Step 3: Add the getters** (optional `?? ''` style so an unset key keeps the mock selected; version/base default to the confirmed Task-0 values):

```typescript
  // ── Customer onboarding Phase 2 — Persona KYC ──
  get personaApiKey(): string { return process.env.PERSONA_API_KEY ?? ''; },
  get personaEnvironment(): string { return process.env.PERSONA_ENVIRONMENT ?? 'sandbox'; },
  get personaWebhookSecret(): string { return process.env.PERSONA_WEBHOOK_SECRET ?? ''; },
  get personaInquiryTemplateVersionId(): string { return process.env.PERSONA_INQUIRY_TEMPLATE_VERSION_ID ?? ''; },
  get personaApiVersion(): string { return process.env.PERSONA_API_VERSION ?? '2025-12-08'; },
  get personaApiBase(): string { return process.env.PERSONA_API_BASE ?? 'https://api.withpersona.com/api/v1'; },
  get whatsappVerificationNeededTemplate(): string { return process.env.WHATSAPP_VERIFICATION_NEEDED_TEMPLATE ?? 'verification_needed'; },
  get whatsappVerificationInProgressTemplate(): string { return process.env.WHATSAPP_VERIFICATION_IN_PROGRESS_TEMPLATE ?? 'verification_in_progress'; },
  get whatsappVerificationVerifiedTemplate(): string { return process.env.WHATSAPP_VERIFICATION_VERIFIED_TEMPLATE ?? 'verification_verified'; },
  get whatsappVerificationFailedTemplate(): string { return process.env.WHATSAPP_VERIFICATION_FAILED_TEMPLATE ?? 'verification_failed'; },
```
> Note: `personaWebhookSecret`/`personaApiKey` use `?? ''` (not `required()`) so the dormant-until-provisioned posture matches Phase 1; the webhook + provider fail-closed on `''`.

- [ ] **Step 4: Run the test to verify it passes** — `npx vitest run tests/env-persona.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add src/lib/env.ts tests/env-persona.test.ts && git commit -m "feat(kyc): Persona + verification-template env getters"`

---

## Task 2: Customer model + KYC case/review types

**Files:**
- Modify: `src/lib/types.ts` (extend `Customer` ~lines 229–265; add types near `KycStatus` ~line 212)
- Test: `tests/types-kyc.test.ts` (compile-level guard + a tiny runtime assertion)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import type { Customer, KycReviewState } from '@/lib/types';

describe('Phase-2 KYC types', () => {
  it('Customer carries the new review fields', () => {
    const c: Partial<Customer> = {
      kycReviewState: 'pending_review',
      idLast4: '1234',
      kycInquiryId: 'inq_x',
      watchlistHit: false,
      pepHit: false,
      kycApprovedBy: 'admin',
    };
    expect(c.kycReviewState).toBe('pending_review');
  });
  it('KycReviewState includes the case states', () => {
    const states: KycReviewState[] = ['none', 'inquiry_started', 'pending_review', 'needs_review', 'approved', 'rejected'];
    expect(states).toHaveLength(6);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run tests/types-kyc.test.ts` → FAIL (type/property missing).

- [ ] **Step 3: Add the types** — near `KycStatus`:

```typescript
/**
 * The KYC *review* case state (Phase 2). Separate from `kycStatus` (which drives
 * tier/cap and is moved to a terminal value ONLY by a human). Persona webhooks
 * move THIS field, never kycStatus.
 *   none            — never started
 *   inquiry_started — inquiry created, customer in the hosted flow
 *   pending_review  — Persona returned a clean pass; awaiting human approval
 *   needs_review    — Persona declined/failed OR a watchlist/PEP hit → human must decide
 *   approved        — a human approved (mirrors kycStatus:'verified')
 *   rejected        — a human rejected (mirrors kycStatus:'rejected')
 */
export type KycReviewState =
  | 'none'
  | 'inquiry_started'
  | 'pending_review'
  | 'needs_review'
  | 'approved'
  | 'rejected';
```

Extend `Customer` (additive, all optional → no migration):

```typescript
  // ── Customer onboarding Phase 2 — Persona KYC (data-minimized) ──
  kycInquiryId?: string;        // Persona inquiry id (inq_...) — also mirrored to kycProviderRef
  kycReviewState?: KycReviewState;
  idLast4?: string;             // last 4 of the verified government ID (display only; full ID never stored)
  idDocType?: GovIdType;        // mirrors the verified document class
  watchlistHit?: boolean;       // a Persona watchlist/sanctions report matched
  pepHit?: boolean;             // a Persona PEP report matched
  kycSubmittedAt?: string;      // inquiry created / customer entered the flow
  kycApprovedBy?: string;       // staff username who approved (audit)
  kycApprovedAt?: string;
  kycRejectedAt?: string;
```

- [ ] **Step 4: Run the test to verify it passes** + `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `git add src/lib/types.ts tests/types-kyc.test.ts && git commit -m "feat(kyc): Phase-2 Customer review fields + KycReviewState"`

---

## Task 3: `persona-client` — low-level REST (createInquiry / getInquiry / generateOneTimeLink)

**Files:**
- Create: `src/lib/providers/persona-client.ts`
- Test: `tests/persona-client.test.ts`

Use the **Task-0-confirmed** base URL, header names, and JSON paths. The signatures below are stable; adjust the response-path extraction to match the recorded fixtures.

- [ ] **Step 1: Write the failing test** (inject `fetch` so no network in tests; assert headers + body shape + path extraction against the Task-0 fixture):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createPersonaClient } from '@/lib/providers/persona-client';
import inquiryCreated from './fixtures/persona/inquiry-created.json';

function fakeFetch(json: unknown) {
  return vi.fn(async () => ({ ok: true, status: 201, json: async () => json, text: async () => JSON.stringify(json) }) as unknown as Response);
}

describe('persona-client.createInquiry', () => {
  it('POSTs the pinned template version + reference-id with the right headers, returns the inquiry id', async () => {
    const fetchImpl = fakeFetch(inquiryCreated);
    const client = createPersonaClient({ apiKey: 'persona_sandbox_x', apiVersion: '2025-12-08', base: 'https://api.withpersona.com/api/v1', templateVersionId: 'itmplv_x', fetchImpl });
    const res = await client.createInquiry({ referenceId: '15551230000', idempotencyKey: 'k1' });
    expect(res.inquiryId).toBe(inquiryCreated.data.id);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.withpersona.com/api/v1/inquiries');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer persona_sandbox_x');
    expect(init.headers['Persona-Version']).toBe('2025-12-08');
    expect(init.headers['Key-Inflection']).toBe('kebab');
    expect(init.headers['Idempotency-Key']).toBe('k1');
    const body = JSON.parse(init.body);
    expect(body.data.attributes['inquiry-template-version-id']).toBe('itmplv_x');
    expect(body.data.attributes['reference-id']).toBe('15551230000');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run tests/persona-client.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (constructor takes an injectable `fetchImpl` for testability; the JSON paths for one-time-link + status come from Task 0):

```typescript
export interface PersonaClientOptions {
  apiKey: string;
  apiVersion: string;
  base: string;
  templateVersionId: string;
  fetchImpl?: typeof fetch;
}

export interface CreateInquiryInput { referenceId: string; idempotencyKey: string; }
export interface CreateInquiryResult { inquiryId: string; status: string; }

export function createPersonaClient(opts: PersonaClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${opts.apiKey}`,
    'Persona-Version': opts.apiVersion,
    'Key-Inflection': 'kebab',
    'Content-Type': 'application/json',
    ...extra,
  });
  return {
    async createInquiry(input: CreateInquiryInput): Promise<CreateInquiryResult> {
      const r = await doFetch(`${opts.base}/inquiries`, {
        method: 'POST',
        headers: headers({ 'Idempotency-Key': input.idempotencyKey }),
        body: JSON.stringify({ data: { attributes: { 'inquiry-template-version-id': opts.templateVersionId, 'reference-id': input.referenceId } } }),
      });
      if (!r.ok) throw new Error(`Persona createInquiry ${r.status}`);
      const j = await r.json();
      return { inquiryId: j?.data?.id, status: j?.data?.attributes?.status };
    },
    async getInquiry(inquiryId: string): Promise<{ status: string; raw: unknown }> {
      const r = await doFetch(`${opts.base}/inquiries/${inquiryId}`, { headers: headers() });
      if (!r.ok) throw new Error(`Persona getInquiry ${r.status}`);
      const j = await r.json();
      return { status: j?.data?.attributes?.status, raw: j };
    },
    async generateOneTimeLink(inquiryId: string): Promise<string> {
      const r = await doFetch(`${opts.base}/inquiries/${inquiryId}/generate-one-time-link`, { method: 'POST', headers: headers() });
      if (!r.ok) throw new Error(`Persona generateOneTimeLink ${r.status}`);
      const j = await r.json();
      // CONFIRM the exact path in Task 0 (one-time-link.json); commonly meta['one-time-link'].
      const link = j?.meta?.['one-time-link'] ?? j?.data?.attributes?.['one-time-link'];
      if (!link) throw new Error('Persona one-time-link missing in response');
      return link;
    },
  };
}
export type PersonaClient = ReturnType<typeof createPersonaClient>;
```

- [ ] **Step 4: Run the test to verify it passes** — PASS. (Add a `generateOneTimeLink` test using `one-time-link.json` once Task 0 confirms the path.)

- [ ] **Step 5: Commit** — `git add src/lib/providers/persona-client.ts tests/persona-client.test.ts && git commit -m "feat(kyc): persona-client REST wrapper"`

---

## Task 4: `verifyPersonaSignature` — webhook HMAC (t.body, multi-secret, replay)

**Files:**
- Create: `src/lib/providers/persona-signature.ts`
- Test: `tests/persona-signature.test.ts`

Persona's `Persona-Signature` header is `t=<unix>,v1=<hex>[,v1=<hex>...]`; the HMAC-SHA256 is computed over the literal string `` `${t}.${rawBody}` `` keyed by each `wbhsec_` secret; **any** matching `v1` passes (dual-secret rotation); reject if `|now - t| > 5min`. (Confirm header name/format against the Task-0 captured delivery; the verifier below is format-stable.)

- [ ] **Step 1: Write the failing test** (compute a known-good signature with `node:crypto`, then assert accept/replay/tamper/rotation):

```typescript
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyPersonaSignature } from '@/lib/providers/persona-signature';

const SECRET = 'wbhsec_test';
const body = JSON.stringify({ data: { id: 'evt_1' } });
const sign = (t: number, secret: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

describe('verifyPersonaSignature', () => {
  const now = 1_700_000_000_000; // ms
  const t = Math.floor(now / 1000);
  it('accepts a fresh, correctly-signed body', () => {
    expect(verifyPersonaSignature(body, `t=${t},v1=${sign(t, SECRET)}`, [SECRET], now)).toBe(true);
  });
  it('rejects a replayed (stale) timestamp beyond 5 min', () => {
    const old = t - 6 * 60;
    expect(verifyPersonaSignature(body, `t=${old},v1=${sign(old, SECRET)}`, [SECRET], now)).toBe(false);
  });
  it('rejects a tampered body', () => {
    expect(verifyPersonaSignature(body + 'x', `t=${t},v1=${sign(t, SECRET)}`, [SECRET], now)).toBe(false);
  });
  it('accepts when ANY of multiple v1 sigs matches (rotation)', () => {
    const header = `t=${t},v1=deadbeef,v1=${sign(t, SECRET)}`;
    expect(verifyPersonaSignature(body, header, ['wbhsec_other', SECRET], now)).toBe(true);
  });
  it('fail-closed on empty secret/header', () => {
    expect(verifyPersonaSignature(body, '', [SECRET], now)).toBe(false);
    expect(verifyPersonaSignature(body, `t=${t},v1=${sign(t, SECRET)}`, [''], now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL (module missing).

- [ ] **Step 3: Implement** (constant-time compare; 5-min window; try every secret × every v1):

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

function safeEqualHex(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); } catch { return false; }
}

export function verifyPersonaSignature(
  rawBody: string,
  header: string,
  secrets: string[],
  nowMs: number,
): boolean {
  const usableSecrets = (secrets ?? []).filter((s) => s && s.length > 0);
  if (!header || usableSecrets.length === 0) return false; // fail-closed
  const parts = header.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const v1s = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!tPart || v1s.length === 0) return false;
  const t = Number(tPart.slice(2));
  if (!Number.isFinite(t)) return false;
  if (Math.abs(nowMs - t * 1000) > REPLAY_WINDOW_MS) return false; // replay guard
  const signed = `${t}.${rawBody}`;
  for (const secret of usableSecrets) {
    const expected = createHmac('sha256', secret).update(signed).digest('hex');
    for (const v1 of v1s) if (safeEqualHex(expected, v1)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/lib/providers/persona-signature.ts tests/persona-signature.test.ts && git commit -m "feat(kyc): Persona webhook signature verify (t.body, multi-secret, replay)"`

---

## Task 5: `persona-webhook-parse` — kebab payload → `PersonaEvent`

**Files:**
- Create: `src/lib/providers/persona-webhook-parse.ts`
- Test: `tests/persona-webhook-parse.test.ts` (uses Task-0 `webhook-inquiry-completed.json`; add hand-built fixtures for declined + watchlist.matched)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { parsePersonaEvent } from '@/lib/providers/persona-webhook-parse';

const completed = {
  data: { type: 'event', id: 'evt_abc', attributes: {
    name: 'inquiry.completed', 'created-at': '2026-06-02T20:00:00Z',
    payload: { data: { type: 'inquiry', id: 'inq_123', attributes: {
      status: 'completed', 'reference-id': '15551230000',
      'name-first': 'JANE', 'name-last': 'DOE',
      fields: { 'identification-number': { type: 'string', value: 'XXXXX6789' } },
    } } },
  } },
};

describe('parsePersonaEvent', () => {
  it('extracts event id, name, inquiry id, reference-id, status', () => {
    const e = parsePersonaEvent(completed);
    expect(e).toMatchObject({ eventId: 'evt_abc', name: 'inquiry.completed', inquiryId: 'inq_123', referenceId: '15551230000', status: 'completed' });
    expect(e?.idLast4).toBe('6789');
  });
  it('returns null for an unparseable body', () => {
    expect(parsePersonaEvent({ nonsense: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL (module missing).

- [ ] **Step 3: Implement** (defensive, kebab-aware; never throws; `idLast4` from the last 4 digits of whatever id-number field Task 0 confirms; watchlist/pep detected from `report/watchlist.matched` events or report relationships):

```typescript
export interface PersonaEvent {
  eventId: string;
  name: string;            // e.g. 'inquiry.completed', 'inquiry.approved', 'inquiry.declined', 'inquiry.failed', 'inquiry.marked-for-review', 'report/watchlist.matched'
  createdAt: string;       // ISO; order events by this
  inquiryId: string | null;
  referenceId: string | null;
  status: string | null;   // inquiry status string
  idLast4?: string;
  watchlistMatched?: boolean;
}

function digitsLast4(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const d = v.replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : undefined;
}

export function parsePersonaEvent(body: unknown): PersonaEvent | null {
  try {
    const b = body as any;
    const attrs = b?.data?.attributes;
    const name = attrs?.name;
    const eventId = b?.data?.id;
    if (!name || !eventId) return null;
    const inq = attrs?.payload?.data;
    const iAttrs = inq?.attributes ?? {};
    // NB (Task-0 finding): `fields` keys are snake_case; the exact id-number key is
    // unconfirmed until a COMPLETED sandbox inquiry. Try the likely candidates;
    // idLast4 is display-only so an undefined result degrades gracefully.
    const f = iAttrs?.fields ?? {};
    const idField =
      f?.identification_number?.value ??
      f?.current_government_id?.value?.identification_number ??
      f?.government_id_number?.value ??
      iAttrs?.['identification-number'];
    return {
      eventId,
      name,
      createdAt: attrs?.['created-at'] ?? '',
      inquiryId: inq?.id ?? null,
      referenceId: iAttrs?.['reference-id'] ?? null,
      status: iAttrs?.status ?? null,
      idLast4: digitsLast4(idField),
      watchlistMatched: name === 'report/watchlist.matched' ? true : undefined,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/lib/providers/persona-webhook-parse.ts tests/persona-webhook-parse.test.ts && git commit -m "feat(kyc): Persona webhook event parser (kebab, data-min)"`

---

## Task 6: `applyKycEvent` — the human-review-only state machine (pure)

**Files:**
- Create: `src/lib/kyc-state-machine.ts`
- Test: `tests/kyc-state-machine.test.ts`

This is the heart and the place the **no-auto-verify** invariant is enforced. Input: current `Customer` + `PersonaEvent`. Output: a partial field delta (never mutates input). It moves `kycReviewState`, `idLast4`, `watchlistHit`/`pepHit`, `kycSubmittedAt` — and **never** sets `kycStatus:'verified'`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { applyKycEvent } from '@/lib/kyc-state-machine';
import type { Customer } from '@/lib/types';

const base: Customer = { senderPhone: '15551230000', firstSeenAt: '2026-06-01T00:00:00Z', kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: '', updatedAt: '' } as Customer;

describe('applyKycEvent', () => {
  it('a clean completed/approved inquiry → pending_review, NEVER verified', () => {
    const d = applyKycEvent(base, { eventId: 'e1', name: 'inquiry.approved', createdAt: '2026-06-02T20:00:00Z', inquiryId: 'inq_1', referenceId: base.senderPhone, status: 'approved', idLast4: '6789' });
    expect(d.kycReviewState).toBe('pending_review');
    expect(d.idLast4).toBe('6789');
    expect('kycStatus' in d).toBe(false); // human-review-only: tier field untouched
  });
  it('a declined/failed inquiry → needs_review (human decides; not auto-rejected)', () => {
    const d = applyKycEvent(base, { eventId: 'e2', name: 'inquiry.declined', createdAt: '2026-06-02T20:01:00Z', inquiryId: 'inq_1', referenceId: base.senderPhone, status: 'declined' });
    expect(d.kycReviewState).toBe('needs_review');
    expect('kycStatus' in d).toBe(false);
  });
  it('a watchlist match → needs_review + watchlistHit, hard stop for a human', () => {
    const d = applyKycEvent(base, { eventId: 'e3', name: 'report/watchlist.matched', createdAt: '2026-06-02T20:02:00Z', inquiryId: 'inq_1', referenceId: base.senderPhone, status: null, watchlistMatched: true });
    expect(d.kycReviewState).toBe('needs_review');
    expect(d.watchlistHit).toBe(true);
  });
  it('inquiry.created/started → inquiry_started + kycSubmittedAt (once)', () => {
    const d = applyKycEvent(base, { eventId: 'e4', name: 'inquiry.created', createdAt: '2026-06-02T19:00:00Z', inquiryId: 'inq_1', referenceId: base.senderPhone, status: 'created' });
    expect(d.kycReviewState).toBe('inquiry_started');
    expect(d.kycSubmittedAt).toBeTruthy();
  });
  it('does NOT downgrade an already-approved (human) customer on a late event', () => {
    const approved = { ...base, kycStatus: 'verified', kycReviewState: 'approved' } as Customer;
    const d = applyKycEvent(approved, { eventId: 'e5', name: 'inquiry.completed', createdAt: '2026-06-02T20:05:00Z', inquiryId: 'inq_1', referenceId: base.senderPhone, status: 'completed' });
    expect(d.kycReviewState).toBeUndefined(); // no change
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
import type { Customer, KycReviewState } from './types';
import type { PersonaEvent } from './providers/persona-webhook-parse';

export interface KycDelta {
  kycReviewState?: KycReviewState;
  kycInquiryId?: string;
  kycProviderRef?: string;
  idLast4?: string;
  watchlistHit?: boolean;
  pepHit?: boolean;
  kycSubmittedAt?: string;
}

const TERMINAL_HUMAN: KycReviewState[] = ['approved', 'rejected'];

export function applyKycEvent(customer: Customer, event: PersonaEvent, nowIso = new Date().toISOString()): KycDelta {
  // Never override a human terminal decision based on a (possibly late/out-of-order) Persona event.
  if (customer.kycReviewState && TERMINAL_HUMAN.includes(customer.kycReviewState)) return {};

  const delta: KycDelta = {};
  if (event.inquiryId) { delta.kycInquiryId = event.inquiryId; delta.kycProviderRef = event.inquiryId; }
  if (event.idLast4) delta.idLast4 = event.idLast4;

  if (event.watchlistMatched || event.name === 'report/watchlist.matched') {
    delta.watchlistHit = true;
    delta.kycReviewState = 'needs_review';
    return delta;
  }
  switch (event.name) {
    case 'inquiry.created':
    case 'inquiry.started':
      delta.kycReviewState = 'inquiry_started';
      if (!customer.kycSubmittedAt) delta.kycSubmittedAt = nowIso;
      break;
    case 'inquiry.completed':
    case 'inquiry.approved':
      // CLEAN PASS — awaiting a human. NEVER set kycStatus here.
      delta.kycReviewState = 'pending_review';
      break;
    case 'inquiry.declined':
    case 'inquiry.failed':
    case 'inquiry.marked-for-review':
      delta.kycReviewState = 'needs_review';
      break;
    // inquiry.expired / inquiry.transitioned / others ⇒ no state change (keep current)
    default:
      break;
  }
  return delta;
}
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/lib/kyc-state-machine.ts tests/kyc-state-machine.test.ts && git commit -m "feat(kyc): applyKycEvent state machine (human-review-only)"`

---

## Task 7: `getKycProvider` factory + swap the construction site

**Files:**
- Modify: `src/lib/providers/kyc-provider.ts` (add factory)
- Modify: `src/lib/providers/persona-kyc-provider.ts` (Task 8 creates it; factory references it)
- Modify: `src/app/api/whatsapp/route.ts:186`
- Test: `tests/get-kyc-provider.test.ts`

> Implement this AFTER Task 8 (the provider) — listed here because it closes the seam. Order at execution: do Task 8, then Task 7.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getKycProvider } from '@/lib/providers/kyc-provider';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { PersonaKycProvider } from '@/lib/providers/persona-kyc-provider';
import { fakeRedis } from './helpers';
import { createCustomerStore } from '@/lib/customer-store';

describe('getKycProvider', () => {
  afterEach(() => vi.unstubAllEnvs());
  const cs = createCustomerStore(fakeRedis());
  it('returns MockKycProvider when PERSONA_API_KEY is unset', () => {
    vi.stubEnv('PERSONA_API_KEY', '');
    expect(getKycProvider(cs, 'https://x')).toBeInstanceOf(MockKycProvider);
  });
  it('returns PersonaKycProvider when PERSONA_API_KEY is set', () => {
    vi.stubEnv('PERSONA_API_KEY', 'persona_sandbox_x');
    vi.stubEnv('PERSONA_INQUIRY_TEMPLATE_VERSION_ID', 'itmplv_x');
    expect(getKycProvider(cs, 'https://x')).toBeInstanceOf(PersonaKycProvider);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL.

- [ ] **Step 3: Implement the factory** (in `kyc-provider.ts`, mirroring `getPaymentProvider`):

```typescript
import { env } from '../env';
import type { CustomerStore } from '../customer-store';
import { MockKycProvider } from './mock-kyc-provider';
import { PersonaKycProvider } from './persona-kyc-provider';
import { createPersonaClient } from './persona-client';

export function getKycProvider(customerStore: CustomerStore, appBaseUrl: string): KycProvider {
  if (env.personaApiKey) {
    const client = createPersonaClient({
      apiKey: env.personaApiKey,
      apiVersion: env.personaApiVersion,
      base: env.personaApiBase,
      templateVersionId: env.personaInquiryTemplateVersionId,
    });
    return new PersonaKycProvider(client, appBaseUrl);
  }
  return new MockKycProvider(customerStore, appBaseUrl);
}
```

Swap `src/app/api/whatsapp/route.ts:186`:
```typescript
// before: const kycProvider = new MockKycProvider(customerStore, env.appBaseUrl);
import { getKycProvider } from '@/lib/providers/kyc-provider';
const kycProvider = getKycProvider(customerStore, env.appBaseUrl);
```

- [ ] **Step 4: Run the test to verify it passes** — PASS; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `git add src/lib/providers/kyc-provider.ts src/app/api/whatsapp/route.ts tests/get-kyc-provider.test.ts && git commit -m "feat(kyc): getKycProvider factory + wire at the construction site"`

---

## Task 8: `PersonaKycProvider` — implement the seam

**Files:**
- Create: `src/lib/providers/persona-kyc-provider.ts`
- Test: `tests/persona-kyc-provider.test.ts`

> Execute this BEFORE Task 7 (the factory references this class).

- [ ] **Step 1: Write the failing test** (inject a fake `PersonaClient`):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PersonaKycProvider } from '@/lib/providers/persona-kyc-provider';

const fakeClient = {
  createInquiry: vi.fn(async () => ({ inquiryId: 'inq_1', status: 'created' })),
  getInquiry: vi.fn(async () => ({ status: 'approved', raw: {} })),
  generateOneTimeLink: vi.fn(async () => 'https://withpersona.com/verify?inquiry-id=inq_1&one-time-link-token=abc'),
};

describe('PersonaKycProvider', () => {
  it('startVerification creates an inquiry (reference-id = phone) + returns the hosted-flow link', async () => {
    const p = new PersonaKycProvider(fakeClient as any, 'https://app');
    const r = await p.startVerification({ customerId: '15551230000', senderPhone: '15551230000' });
    expect(r.providerRef).toBe('inq_1');
    expect(r.url).toContain('one-time-link-token');
    expect(fakeClient.createInquiry).toHaveBeenCalledWith(expect.objectContaining({ referenceId: '15551230000' }));
  });
  it('getStatus maps Persona inquiry status → KycStatus (Persona verdict, not the human gate)', async () => {
    const p = new PersonaKycProvider(fakeClient as any, 'https://app');
    expect(await p.getStatus('inq_1')).toBe('verified'); // approved → verified (provider view)
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
import type { PersonaClient } from './persona-client';
import { parsePersonaEvent } from './persona-webhook-parse';
import type { KycProvider, KycStartResult, KycStatus, KycWebhookResult } from './kyc-provider';

function mapInquiryStatus(status: string | null): KycStatus {
  // Persona's verdict only. The customer's gate-driving kycStatus is set by a HUMAN.
  switch (status) {
    case 'approved':
    case 'completed':
      return 'verified';
    case 'declined':
    case 'failed':
      return 'rejected';
    default:
      return 'pending';
  }
}

export class PersonaKycProvider implements KycProvider {
  constructor(private readonly client: PersonaClient, private readonly appBaseUrl: string) {}

  async startVerification(input: { customerId: string; senderPhone: string }): Promise<KycStartResult> {
    const { inquiryId } = await this.client.createInquiry({
      referenceId: input.senderPhone,
      idempotencyKey: `kyc-${input.senderPhone}-${Date.now()}`,
    });
    const url = await this.client.generateOneTimeLink(inquiryId);
    return { url, providerRef: inquiryId };
  }

  async getStatus(providerRef: string): Promise<KycStatus> {
    const { status } = await this.client.getInquiry(providerRef);
    return mapInquiryStatus(status);
  }

  async handleWebhook(body: unknown): Promise<KycWebhookResult | null> {
    // Seam-honest mapping; the /api/persona-webhook route uses the richer
    // applyKycEvent state machine directly (this is here for interface parity).
    const ev = parsePersonaEvent(body);
    if (!ev || !ev.inquiryId) return null;
    return {
      providerRef: ev.inquiryId,
      status: mapInquiryStatus(ev.status),
      rejectedReason: ev.name === 'inquiry.declined' || ev.name === 'inquiry.failed' ? ev.name : undefined,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/lib/providers/persona-kyc-provider.ts tests/persona-kyc-provider.test.ts && git commit -m "feat(kyc): PersonaKycProvider (start/getStatus/handleWebhook)"`

---

## Task 9: `kyc-case-store` — persistence, idempotency, append-only audit

**Files:**
- Create: `src/lib/kyc-case-store.ts`
- Test: `tests/kyc-case-store.test.ts`

Owns: webhook idempotency dedupe (`sr_kyc_evt:<eventId>` via `set nx`), applying a `KycDelta` to the `Customer`, the human review transition (sets `kycStatus`), the append-only audit (`kyc_audit:<phone>` hash, field = `<iso>#<seq>`), and the review queue.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createCustomerStore } from '@/lib/customer-store';
import { createKycCaseStore } from '@/lib/kyc-case-store';
import type { Customer } from '@/lib/types';

const redis = fakeRedis();
const cs = createCustomerStore(redis);
const store = createKycCaseStore(redis, cs);
const PHONE = '15551230000';
const seed = async (over: Partial<Customer> = {}) => cs.saveCustomer({ senderPhone: PHONE, firstSeenAt: '2026-06-01T00:00:00Z', kycStatus: 'pending', senderCountry: 'US', partnerId: 'default', createdAt: '', updatedAt: '', ...over } as Customer);

beforeEach(() => { redis.dump.clear(); });

describe('kyc-case-store', () => {
  it('markEventSeen is true once, false on replay (idempotency)', async () => {
    expect(await store.markEventSeen('evt_1')).toBe(true);
    expect(await store.markEventSeen('evt_1')).toBe(false);
  });
  it('applyDelta merges fields + appends an audit entry', async () => {
    await seed();
    await store.applyDelta(PHONE, { kycReviewState: 'pending_review', idLast4: '6789', kycInquiryId: 'inq_1' }, { actor: 'persona', action: 'inquiry.completed' });
    const c = await cs.getCustomer(PHONE);
    expect(c?.kycReviewState).toBe('pending_review');
    expect(c?.idLast4).toBe('6789');
    expect((await store.getAudit(PHONE)).length).toBe(1);
  });
  it('review(approve) sets kycStatus verified + approver + audit; review(reject) sets rejected + reason', async () => {
    await seed({ kycReviewState: 'pending_review' });
    await store.review(PHONE, 'approve', 'admin', 'docs look good');
    let c = await cs.getCustomer(PHONE);
    expect(c?.kycStatus).toBe('verified');
    expect(c?.kycReviewState).toBe('approved');
    expect(c?.kycApprovedBy).toBe('admin');

    await seed({ kycReviewState: 'needs_review' });
    await store.review(PHONE, 'reject', 'admin', 'watchlist confirmed');
    c = await cs.getCustomer(PHONE);
    expect(c?.kycStatus).toBe('rejected');
    expect(c?.kycRejectedReason).toBe('watchlist confirmed');
  });
  it('listNeedsReview returns only pending_review/needs_review customers', async () => {
    await seed({ kycReviewState: 'pending_review' });
    const list = await store.listNeedsReview();
    expect(list.map((c) => c.senderPhone)).toContain(PHONE);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
import type { RedisLike } from './store';
import type { CustomerStore } from './customer-store';
import type { Customer } from './types';
import type { KycDelta } from './kyc-state-machine';

const EVT_TTL = 30 * 24 * 60 * 60; // 30d replay-dedup window
const evtKey = (id: string) => `sr_kyc_evt:${id}`;
const auditKey = (phone: string) => `kyc_audit:${phone}`;

export interface AuditMeta { actor: string; action: string; reason?: string; }
export interface AuditEntry extends AuditMeta { at: string; }

export function createKycCaseStore(redis: RedisLike, customers: CustomerStore, now = () => Date.now()) {
  async function appendAudit(phone: string, entry: AuditEntry, seq: number): Promise<void> {
    await redis.hset(auditKey(phone), { [`${entry.at}#${seq}`]: JSON.stringify(entry) });
  }
  return {
    /** True the FIRST time an event id is seen; false on replay (Persona re-delivers). */
    async markEventSeen(eventId: string): Promise<boolean> {
      const r = await redis.set(evtKey(eventId), '1', { nx: true, ex: EVT_TTL });
      return r !== null;
    },
    async applyDelta(phone: string, delta: KycDelta, meta: AuditMeta): Promise<Customer | null> {
      const c = await customers.getCustomer(phone);
      if (!c) return null;
      const nowIso = new Date(now()).toISOString();
      const updated: Customer = { ...c, ...delta, updatedAt: nowIso };
      await customers.saveCustomer(updated);
      const existing = (await redis.hgetall(auditKey(phone))) ?? {};
      await appendAudit(phone, { ...meta, at: nowIso }, Object.keys(existing).length);
      return updated;
    },
    async review(phone: string, decision: 'approve' | 'reject', reviewer: string, reason: string): Promise<Customer | null> {
      const c = await customers.getCustomer(phone);
      if (!c) return null;
      const nowIso = new Date(now()).toISOString();
      const updated: Customer = decision === 'approve'
        ? { ...c, kycStatus: 'verified', kycReviewState: 'approved', kycVerifiedAt: nowIso, kycApprovedBy: reviewer, kycApprovedAt: nowIso, kycRejectedReason: undefined, updatedAt: nowIso }
        : { ...c, kycStatus: 'rejected', kycReviewState: 'rejected', kycRejectedReason: reason, kycRejectedAt: nowIso, updatedAt: nowIso };
      await customers.saveCustomer(updated);
      const existing = (await redis.hgetall(auditKey(phone))) ?? {};
      await appendAudit(phone, { actor: reviewer, action: `review.${decision}`, reason, at: nowIso }, Object.keys(existing).length);
      return updated;
    },
    async getAudit(phone: string): Promise<AuditEntry[]> {
      const h = (await redis.hgetall(auditKey(phone))) ?? {};
      return Object.entries(h)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([, v]) => JSON.parse(v) as AuditEntry);
    },
    async listNeedsReview(): Promise<Customer[]> {
      const phones = await redis.smembers('customers:phones');
      const out: Customer[] = [];
      for (const p of phones) {
        const c = await customers.getCustomer(p);
        if (c && (c.kycReviewState === 'pending_review' || c.kycReviewState === 'needs_review')) out.push(c);
      }
      return out;
    },
  };
}
export type KycCaseStore = ReturnType<typeof createKycCaseStore>;
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/lib/kyc-case-store.ts tests/kyc-case-store.test.ts && git commit -m "feat(kyc): kyc-case-store (idempotency + delta + review + audit)"`

---

## Task 10: `/api/persona-webhook` route — verify → dedupe → apply → notify

**Files:**
- Create: `src/app/api/persona-webhook/route.ts`
- Test: `tests/persona-webhook-route.test.ts`

Mirrors the WhatsApp/payment webhook route pattern (raw body first, fail-closed verify, fast 2xx, `after()` for the WhatsApp notify).

- [ ] **Step 1: Write the failing test** (sign a fixture body, mock the stores + the notify):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { fakeRedis } from './helpers';

const redis = fakeRedis();
vi.mock('@/lib/store', async (orig) => ({ ...(await orig()), getStore: () => ({}) }));
vi.mock('@/lib/env', () => ({ env: { personaWebhookSecret: 'wbhsec_test', appBaseUrl: 'https://app' } }));
const notify = vi.fn(async () => {});
vi.mock('@/lib/whatsapp', () => ({ sendVerificationStatus: notify }));
vi.mock('next/server', async (orig) => ({ ...(await orig()), after: (fn: () => void) => fn() }));
// ...mock getCustomerStore + getKycCaseStore to use `redis` (mirror account-actions.test wiring)...

import { POST } from '@/app/api/persona-webhook/route';

const body = JSON.stringify({ data: { id: 'evt_1', type: 'event', attributes: { name: 'inquiry.completed', 'created-at': '2026-06-02T20:00:00Z', payload: { data: { id: 'inq_1', attributes: { status: 'completed', 'reference-id': '15551230000' } } } } } });
const t = Math.floor(Date.now() / 1000);
const sig = `t=${t},v1=${createHmac('sha256', 'wbhsec_test').update(`${t}.${body}`).digest('hex')}`;
const req = (b: string, header: string) => ({ text: async () => b, headers: { get: (h: string) => (h.toLowerCase() === 'persona-signature' ? header : null) } }) as any;

beforeEach(() => redis.dump.clear());

describe('POST /api/persona-webhook', () => {
  it('401 on a bad signature', async () => {
    const res = await POST(req(body, 't=1,v1=bad'));
    expect(res.status).toBe(401);
  });
  it('200 + applies the event on a valid signature', async () => {
    // seed customer 15551230000 in `redis` first (via the mocked customer store)
    const res = await POST(req(body, sig));
    expect(res.status).toBe(200);
    // assert kycReviewState became 'pending_review' on the seeded customer
  });
  it('200 ignored on a replayed event id (idempotency)', async () => {
    await POST(req(body, sig));
    const res2 = await POST(req(body, sig));
    expect(res2.status).toBe(200); // second is a no-op
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL (route missing).

- [ ] **Step 3: Implement**

```typescript
import { NextRequest, NextResponse, after } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { verifyPersonaSignature } from '@/lib/providers/persona-signature';
import { parsePersonaEvent } from '@/lib/providers/persona-webhook-parse';
import { applyKycEvent } from '@/lib/kyc-state-machine';
import { sendVerificationStatus } from '@/lib/whatsapp';

export async function POST(req: NextRequest) {
  const raw = await req.text(); // raw bytes first — Persona signs the exact body
  const header = req.headers.get('persona-signature') ?? '';
  if (!verifyPersonaSignature(raw, header, [env.personaWebhookSecret], Date.now())) {
    return NextResponse.json({ ok: false }, { status: 401 }); // fail-closed
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ ok: false }, { status: 400 }); }

  const event = parsePersonaEvent(body);
  if (!event) return NextResponse.json({ ok: true, ignored: true });

  const customers = getCustomerStore(getStore());
  const cases = getKycCaseStore(getStore(), customers);

  // Idempotency: Persona re-delivers + out-of-order; process each event id once.
  if (!(await cases.markEventSeen(event.eventId))) return NextResponse.json({ ok: true, deduped: true });

  const phone = event.referenceId;
  if (!phone) return NextResponse.json({ ok: true, ignored: true });
  const customer = await customers.getCustomer(phone);
  if (!customer) return NextResponse.json({ ok: true, ignored: true });

  const delta = applyKycEvent(customer, event);
  let nextState = customer.kycReviewState;
  if (Object.keys(delta).length > 0) {
    const updated = await cases.applyDelta(phone, delta, { actor: 'persona', action: event.name });
    nextState = updated?.kycReviewState;
  }

  // Notify the customer of the state transition, fail-soft (no Meta template ⇒ free-form).
  after(async () => {
    try {
      if (nextState === 'inquiry_started') await sendVerificationStatus(phone, 'in_progress', customer.fullName);
      else if (nextState === 'pending_review') await sendVerificationStatus(phone, 'received', customer.fullName);
      // needs_review ⇒ no customer message (staff handle it); approved/rejected ⇒ sent by the review action.
    } catch (err) { console.error('persona-webhook notify failed:', err); }
  });

  return NextResponse.json({ ok: true });
}
```

> Requires a `getKycCaseStore(store, customerStore)` singleton accessor in `kyc-case-store.ts` (mirror `getCustomerStore`), reading the real Upstash client like the other `getX` accessors.

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/app/api/persona-webhook/route.ts src/lib/kyc-case-store.ts tests/persona-webhook-route.test.ts && git commit -m "feat(kyc): /api/persona-webhook route (verify, dedupe, apply, notify)"`

---

## Task 11: WhatsApp verification-status templates (fail-soft)

**Files:**
- Modify: `src/lib/whatsapp-templates.ts` (template-name consts + `verificationStatusParams`)
- Modify: `src/lib/whatsapp.ts` (`sendVerificationStatus`)
- Test: `tests/verification-status.test.ts`

- [ ] **Step 1: Write the failing test** (the param builder is pure; the sender is fail-soft):

```typescript
import { describe, it, expect, vi } from 'vitest';
import { verificationStatusParams } from '@/lib/whatsapp-templates';

describe('verificationStatusParams', () => {
  it('builds [name, message] for each state', () => {
    expect(verificationStatusParams('Jane', 'verified')[0]).toBe('Jane');
    expect(verificationStatusParams('Jane', 'verified')[1]).toMatch(/verified/i);
    expect(verificationStatusParams('there', 'failed')[1]).toMatch(/again|couldn|not/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL.

- [ ] **Step 3: Implement** — in `whatsapp-templates.ts`:

```typescript
export type VerificationState = 'needed' | 'in_progress' | 'received' | 'verified' | 'failed';

export function verificationStatusParams(name: string, state: VerificationState): string[] {
  const msg: Record<VerificationState, string> = {
    needed: 'Please verify your identity to start sending money.',
    in_progress: 'Your identity verification is in progress.',
    received: 'Thanks — we received your verification and are reviewing it. We’ll message you shortly.',
    verified: 'You’re verified! You can now send money.',
    failed: 'We couldn’t verify your identity. Please tap below to try again.',
  };
  return [name || 'there', msg[state]];
}
```

In `whatsapp.ts` (uses `sendTemplateOrText` for graceful degradation, mirroring cron):

```typescript
import { env } from './env';
import { verificationStatusParams, type VerificationState, TEMPLATE_LANG } from './whatsapp-templates';

const VERIFICATION_TEMPLATE: Record<VerificationState, () => string> = {
  needed: () => env.whatsappVerificationNeededTemplate,
  in_progress: () => env.whatsappVerificationInProgressTemplate,
  received: () => env.whatsappVerificationInProgressTemplate,
  verified: () => env.whatsappVerificationVerifiedTemplate,
  failed: () => env.whatsappVerificationFailedTemplate,
};

export async function sendVerificationStatus(phone: string, state: VerificationState, name?: string): Promise<void> {
  const params = verificationStatusParams(name ?? 'there', state);
  await sendTemplateOrText(
    phone,
    () => sendTemplate(phone, VERIFICATION_TEMPLATE[state](), TEMPLATE_LANG, params),
    `${params[0]}, ${params[1]}`,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/lib/whatsapp-templates.ts src/lib/whatsapp.ts tests/verification-status.test.ts && git commit -m "feat(kyc): WhatsApp verification-status templates (fail-soft)"`

---

## Task 12: `/account/verify` portal page + start-verification action

**Files:**
- Create: `src/app/account/verify/page.tsx`
- Create: `src/app/account/verify/actions.ts`
- Modify: `src/app/account/page.tsx` (add the CTA)
- Test: `tests/account-verify-action.test.ts` (the action; the page is UI per repo convention)

The action is the tested, security-relevant part: gated by `requireCustomer`, it starts a real inquiry, persists `kycInquiryId` + `kycReviewState:'inquiry_started'` via the case store, and redirects the customer to the Persona hosted-flow URL.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
// mock requireCustomer → a known customer; mock getKycProvider → a fake provider that
// returns {url:'https://withpersona.com/...', providerRef:'inq_1'}; mock next/navigation redirect.
import { startVerificationAction } from '@/app/account/verify/actions';

describe('startVerificationAction', () => {
  it('starts an inquiry, persists inquiry_started, redirects to the hosted-flow URL', async () => {
    await expect(startVerificationAction()).rejects.toThrow('REDIRECT:https://withpersona.com');
    // assert the customer now has kycReviewState 'inquiry_started' + kycInquiryId 'inq_1'
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL (module missing).

- [ ] **Step 3: Implement the action**

```typescript
'use server';
import { redirect } from 'next/navigation';
import { requireCustomer } from '@/lib/customer-auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getKycCaseStore } from '@/lib/kyc-case-store';
import { getKycProvider } from '@/lib/providers/kyc-provider';
import { env } from '@/lib/env';

export async function startVerificationAction(): Promise<void> {
  const customer = await requireCustomer();
  const customers = getCustomerStore(getStore());
  const provider = getKycProvider(customers, env.appBaseUrl);
  const { url, providerRef } = await provider.startVerification({
    customerId: customer.senderPhone,
    senderPhone: customer.senderPhone,
  });
  const cases = getKycCaseStore(getStore(), customers);
  await cases.applyDelta(customer.senderPhone, { kycInquiryId: providerRef, kycProviderRef: providerRef, kycReviewState: 'inquiry_started', kycSubmittedAt: new Date().toISOString() }, { actor: customer.senderPhone, action: 'kyc.start' });
  redirect(url); // off to the Persona hosted flow
}
```

- [ ] **Step 4: Implement the page + CTA** (`.payapp` theme, mirroring `account/page.tsx`):

```tsx
// src/app/account/verify/page.tsx
import { requireCustomer } from '@/lib/customer-auth';
import { startVerificationAction } from './actions';

export default async function VerifyPage() {
  const customer = await requireCustomer();
  const state = customer.kycReviewState ?? 'none';
  const done = customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered';
  return (
    <main className="payapp">
      <h1>Verify your identity</h1>
      {done ? (
        <p>You’re verified. You can send money in WhatsApp.</p>
      ) : state === 'pending_review' || state === 'needs_review' ? (
        <p>Thanks — we received your verification and are reviewing it. We’ll message you on WhatsApp shortly.</p>
      ) : (
        <form action={startVerificationAction}>
          <p>To send money we need to verify your identity. It takes about 2 minutes on our secure partner’s page.</p>
          <button type="submit">Start verification</button>
        </form>
      )}
    </main>
  );
}
```

On `account/page.tsx`, add a CTA card linking to `/account/verify` whose label reflects `kycStatus`/`kycReviewState` (Start / In review / Verified).

- [ ] **Step 5: Run tests + `npx tsc --noEmit`**, then **Commit** — `git add src/app/account/verify src/app/account/page.tsx tests/account-verify-action.test.ts && git commit -m "feat(kyc): /account/verify portal entry + start action"`

---

## Task 13: Bot hand-off uses the real link

**Files:**
- Modify (verify only): `src/lib/tools.ts:647,1384` (the existing `startVerification` call sites)
- Test: extend the existing tools test that exercises the verify hand-off

The bot already calls `ctx.kycProvider.startVerification(...)` and surfaces the returned `url`. With Task 7's factory swap, that `url` is now a real Persona one-time link instead of the dashboard URL. **Verify, don't rebuild:**

- [ ] **Step 1:** Read `tools.ts:640–700` and `1360–1404`; confirm the returned `start.url` is sent to the customer and `start.providerRef` is persisted to the customer (`kycProviderRef`/`kycInquiryId`). If a call site does NOT persist `kycReviewState:'inquiry_started'`, add a `getKycCaseStore(...).applyDelta(phone, { kycReviewState:'inquiry_started', kycInquiryId: start.providerRef }, { actor:'bot', action:'kyc.start' })` call there (so the bot-initiated and portal-initiated flows converge on the same state).
- [ ] **Step 2:** Update/extend the tools test asserting the hand-off message contains the provider URL and the customer is moved to `inquiry_started`.
- [ ] **Step 3:** Run the tools test → PASS.
- [ ] **Step 4: Commit** — `git add src/lib/tools.ts tests/<tools-test>.ts && git commit -m "feat(kyc): bot hand-off persists inquiry_started + uses real Persona link"`

---

## Task 14: Admin review surface — queue + reason-bearing approve/reject

**Files:**
- Modify: `src/app/admin-dashboard/customers/actions.ts` (`reviewKycAction`; route `markCustomerVerified/Rejected` through the case store)
- Modify: `src/app/admin-dashboard/customers/[phone]/page.tsx` (show inquiry id, `idLast4`, watchlist/PEP flags, review-state; reason-required Approve/Reject)
- Modify: `src/app/admin-dashboard/compliance/page.tsx` ("Needs KYC Review" queue from `listNeedsReview()`)
- Test: `tests/review-kyc-action.test.ts`

- [ ] **Step 1: Write the failing test** (mirror `partner-staff-actions.test` auth/scope wiring):

```typescript
// requireAdmin → admin; getCustomerStore/getKycCaseStore → fakeRedis-backed.
import { reviewKycAction } from '@/app/admin-dashboard/customers/actions';

describe('reviewKycAction', () => {
  it('approve sets verified + audit; requires a reason; enforces scope', async () => {
    // seed a pending_review customer in scope
    await reviewKycAction(form({ phone: '15551230000', decision: 'approve', reason: 'clean' }));
    // assert kycStatus 'verified', kycReviewState 'approved', an audit entry exists
  });
  it('rejects an out-of-scope customer (partner admin cannot review another partner)', async () => {
    await expect(reviewKycAction(form({ phone: 'other', decision: 'approve', reason: 'x' }))).rejects.toThrow(/not found/i);
  });
  it('throws when reason is empty', async () => {
    await expect(reviewKycAction(form({ phone: '15551230000', decision: 'reject', reason: '' }))).rejects.toThrow(/reason/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — FAIL.

- [ ] **Step 3: Implement** (auth gate + scope check + reason guard, then delegate to the case store; mirror `markCustomerVerifiedAction`):

```typescript
export async function reviewKycAction(formData: FormData): Promise<void> {
  const staff = await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const decision = String(formData.get('decision') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (decision !== 'approve' && decision !== 'reject') throw new Error('Invalid decision.');
  if (!reason) throw new Error('A review reason is required.');
  const customers = getCustomerStore(getStore());
  const customer = await customers.getCustomer(phone);
  if (!customer || !canSee(scopeOf(staff), customer.partnerId)) throw new Error('Customer not found.');
  const cases = getKycCaseStore(getStore(), customers);
  await cases.review(phone, decision, staff.username, reason);
  // notify the customer fail-soft
  const { sendVerificationStatus } = await import('@/lib/whatsapp');
  await sendVerificationStatus(phone, decision === 'approve' ? 'verified' : 'failed', customer.fullName).catch(() => {});
  revalidatePath('/admin-dashboard/compliance');
  revalidatePath(`/admin-dashboard/customers/${phone}`);
}
```

> Keep the existing `markCustomerVerifiedAction`/`markCustomerRejectedAction` working, but have them call `cases.review(...)` internally so every KYC decision is audit-logged uniformly. (Update their tests if message/shape changes.)

- [ ] **Step 4: Implement the UI** — add to `customers/[phone]/page.tsx` an "Identity verification" panel showing `kycReviewState`, `kycInquiryId`, `idLast4`, `watchlistHit`/`pepHit` badges, the audit trail (`getAudit`), and Approve/Reject forms with a required reason `<textarea name="reason">`. Add a "Needs KYC Review" section to `compliance/page.tsx` listing `listNeedsReview()` rows, each linking to the detail page.

- [ ] **Step 5: Run tests + `tsc`**, then **Commit** — `git add src/app/admin-dashboard/customers/actions.ts src/app/admin-dashboard/customers/[phone]/page.tsx src/app/admin-dashboard/compliance/page.tsx tests/review-kyc-action.test.ts && git commit -m "feat(kyc): admin KYC review queue + reason-bearing approve/reject (audit-logged)"`

---

## Task 15: No-migration check + provisioning/runbook update

**Files:**
- Modify: `docs/onboarding-provisioning-checklist.md`

- [ ] **Step 1:** Confirm **no backfill is needed** — every new field is optional and `kycReviewState===undefined` is treated as `'none'` everywhere (queue filter, page rendering). Existing customers (incl. `grandfathered`) are unaffected. Add one test asserting `listNeedsReview()` ignores customers with no `kycReviewState`.
- [ ] **Step 2:** Document the **go-live runbook** in the checklist:
  1. Set in Vercel prod: `PERSONA_API_KEY`, `PERSONA_ENVIRONMENT=sandbox`, `PERSONA_WEBHOOK_SECRET`, `PERSONA_INQUIRY_TEMPLATE_VERSION_ID`, `PERSONA_API_VERSION=2025-12-08` (and `PERSONA_API_BASE` if Task 0 confirmed a non-default base).
  2. Merge/deploy this phase.
  3. **Enable** the Persona webhook (it was created Disabled) pointing at `https://smartremit.ai/api/persona-webhook`.
  4. Run one sandbox inquiry end-to-end (portal CTA → hosted flow → completed) and confirm the webhook flips the customer to `pending_review` + the audit entry lands.
  5. (Optional, separate) submit the 4 `verification_*` Meta templates so customer status messages stop using the free-form fallback.
- [ ] **Step 3: Commit** — `git add docs/onboarding-provisioning-checklist.md tests/<no-migration>.test.ts && git commit -m "docs(kyc): Phase-2 go-live runbook + no-migration check"`

---

## Task 16: Full-suite gate + deploy handoff

- [ ] **Step 1:** Clean iCloud dups: `find . -path ./node_modules -prune -o \( -name "* [0-9].ts" -o -name "* [0-9].tsx" -o -name "* [0-9].md" \) -print -delete`
- [ ] **Step 2:** `npx vitest run` → all pass; `npx tsc --noEmit` clean; `npm run build` clean.
- [ ] **Step 3:** Open the PR; wait for `ci`. **Do NOT** enable the Persona webhook until the user says "deploy" and the route is live (per the runbook).
- [ ] **Step 4:** After merge + smoke green, generate the Claude-in-Chrome verification prompt (per the standing habit) and update memory.

---

## Self-review (against the spec §3a + the locked decisions)

- **IAL2 evidence (Gov ID + Selfie + Watchlist + PEP):** delivered by the pinned template version; nothing to set in code (Task 0/1 pin the version). ✅
- **Webhook = source of truth, signed:** Task 4 (signature) + Task 10 (route) + Task 9 (idempotency/out-of-order via event id + the state machine ignoring late events after a human terminal). ✅
- **Hosted flow, raw PII never touches us:** Task 3 `generateOneTimeLink` + Task 8; we persist only `idLast4` + flags (Task 2/5/6). ✅
- **Human-review-only, no auto-verify:** enforced in Task 6 (`applyKycEvent` never sets `kycStatus`) + Task 9 (`review()` is the only path to `verified`). ✅
- **Send-gate untouched (Phase 3 boundary):** no change to `tier-rules`/`compliance`/`transfer-create`/send tools. ✅
- **Both entry points:** Task 12 (portal) + Task 13 (bot link). ✅
- **Fuller review now:** Task 9 (case states + audit) + Task 14 (queue + reason-bearing approve/reject). Four-eyes/SLA/round-robin explicitly deferred to Phase 4. ✅
- **Watchlist/PEP → hard hold:** Task 6 routes `report/watchlist.matched` → `needs_review` + `watchlistHit`. ✅
- **Open item resolved at build time, not guessed:** the exact Persona wire format (base URL, one-time-link JSON path, signature header casing, id-number field) is pinned by the **Task 0 live-sandbox spike** + fixtures; later tasks assert against those fixtures.

**Placeholder scan:** the only deliberately-deferred specifics are the Task-0-confirmed JSON paths, flagged inline as "CONFIRM IN TASK 0" — resolved before the dependent task runs, not left as TODOs. **Type consistency:** `KycDelta`, `PersonaEvent`, `KycReviewState`, `verificationStatusParams`/`VerificationState`, `getKycCaseStore` are used identically across tasks.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-customer-onboarding-phase2-persona-kyc.md`. Per the `sendhome-execution-interactive` memory, execution is **checkpoint-per-task** (subagent-driven-development, but I report back after each task rather than running continuously). **Task 0 (the live-sandbox spike) runs first and its findings get folded back into the dependent tasks before they execute.**

