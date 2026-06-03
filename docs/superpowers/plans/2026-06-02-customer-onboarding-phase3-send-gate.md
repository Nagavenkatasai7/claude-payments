# Phase 3 — Verify-Before-Send Gate + Per-Transaction OTP · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce two send-time controls: (A) **no transfer is ever created unless the sender's `kycStatus === 'verified'`** (everyone, incl. grandfathered; bot + cron; immediate hard block), and (B) **a per-transaction 6-digit OTP step-up** required on the pay page before any human-completed payment.

**Architecture:** A pure `isSendVerified(customer)` predicate (new `kyc-gate.ts`) is enforced at the single shared chokepoint `createTransfer()` (backstop) and at each caller (bot tools, pay-finalize, cron) with caller-appropriate UX (a Persona `kyc_url` for the bot, a skip+notify for cron). The gate lives **outside** `tier-rules.ts` so the 3-day T0 observation window + $500/day cap invariant is byte-for-byte preserved. Part B adds a transaction-scoped OTP (`transaction-otp.ts`), delivered **in-session as free-form WhatsApp text** (a send is inside the 24-h customer-service window, so it needs no Meta AUTHENTICATION template), verified in `POST /api/pay/[transferId]` before finalize.

**Tech Stack:** TypeScript, Vitest (fakeRedis + `vi.mock`), Next.js 16 App Router (route handler + client form), Upstash Redis, `node:crypto` (`randomInt`, `createHash`, `timingSafeEqual`), Meta WhatsApp Cloud API (free-form `sendText`).

---

## Locked decisions feeding this plan

- **Gate by status, NO migration.** `kycStatus !== 'verified'` blocks; grandfathered/not_started/pending/rejected all fail it. No data rewrite — preserves the grandfathered audit signal.
- **Gate both bot + cron** at the shared `createTransfer` chokepoint; cron **skips + notifies** (does not bump `lastRunAt`, so it resumes once verified).
- **Immediate hard block**, everyone incl. grandfathered. No grace window.
- **OTP on every (human-completed) transaction** — at the pay boundary. Cron-created sends still require the customer to complete payment on the pay page (to add bank details), so the OTP applies there too; there is no fully-unattended charge.
- **Observation invariant preserved:** `tier-rules.ts` is NOT modified. Verifying does not lift the cap during the 3-day window.

## Hard boundary — do NOT touch

- ❌ `src/lib/tier-rules.ts` — `deriveTier`/`evaluateCap`/`OBSERVATION_WINDOW_MS`/the caps stay byte-for-byte. (An existing test asserts `verified`-during-window === `T0`; it must stay green.)
- ❌ Do not convert `grandfathered → not_started` (no destructive migration). `customer-store.ts:67` keeps minting `grandfathered` on first inbound; the gate blocks them anyway.
- ❌ Do not route the blocked-send message through the compliance `blocked: true` relay — it is a *verification prompt with a link*, not a compliance block.

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/lib/kyc-gate.ts` | Create | `isSendVerified(customer)` predicate + `SEND_GATE_REASON` |
| `src/lib/transfer-create.ts` | Modify | `CreateTransferInput.senderKycStatus`; backstop assert in `createTransfer` |
| `src/lib/tools.ts` | Modify | early gate in `getQuoteTool`/`checkSendLimitTool` (kyc_url); gate + pass status in `createTransferTool` (both paths) + `sendApprovePickerTool` |
| `src/lib/pay-finalize.ts` | Modify | `FinalizeResult` gains `'kyc_required'`; gate + pass `senderKycStatus` |
| `src/app/api/pay/[transferId]/route.ts` | Modify | surface `kyc_required`; **Part B** OTP request + verify |
| `src/lib/cron-run.ts` | Modify | skip unverified + `sendScheduledSkipped` callback; pass `senderKycStatus` |
| `src/app/api/cron/route.ts` | Modify | wire `sendScheduledSkipped` |
| `src/lib/prompt.ts` | Modify | VERIFY-BEFORE-SEND system rule |
| `src/app/account/page.tsx`, `src/app/account/verify/page.tsx` | Modify | grandfathered → show verify CTA |
| `src/lib/transaction-otp.ts` | Create | per-transaction OTP issue/verify (id+phone-bound) |
| `src/lib/whatsapp.ts` | Modify | `sendTransactionOtp` (free-form in-session; template fallback) |
| `src/app/pay/[transferId]/pay-form.tsx` | Modify | OTP step (request + enter) before "Pay now" |

---

# PART A — KYC-verified send gate

## Task 1: `kyc-gate.ts` — the predicate

**Files:**
- Create: `src/lib/kyc-gate.ts`
- Test: `tests/kyc-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { isSendVerified, SEND_GATE_REASON } from '@/lib/kyc-gate';
import type { Customer } from '@/lib/types';

const c = (kycStatus: Customer['kycStatus']): Customer =>
  ({ senderPhone: 'p', firstSeenAt: '', kycStatus, senderCountry: 'US', partnerId: 'default', createdAt: '', updatedAt: '' }) as Customer;

describe('isSendVerified', () => {
  it('only kycStatus "verified" may send — grandfathered may NOT (must onboard)', () => {
    expect(isSendVerified(c('verified'))).toBe(true);
    expect(isSendVerified(c('grandfathered'))).toBe(false); // Phase 3: must onboard
    expect(isSendVerified(c('pending'))).toBe(false);
    expect(isSendVerified(c('not_started'))).toBe(false);
    expect(isSendVerified(c('rejected'))).toBe(false);
  });
  it('a missing customer is not verified', () => {
    expect(isSendVerified(undefined)).toBe(false);
    expect(isSendVerified(null)).toBe(false);
  });
  it('exposes the machine-readable reason string', () => {
    expect(SEND_GATE_REASON).toBe('kyc_required');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails** — `npx vitest run tests/kyc-gate.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
import type { Customer, KycStatus } from './types';

/** The single machine-readable reason a send is gated for missing KYC. */
export const SEND_GATE_REASON = 'kyc_required' as const;

/**
 * Phase-3 verify-before-send predicate. ONLY 'verified' may send — NOT
 * 'grandfathered' (pre-existing senders must now onboard), and NOT a customer
 * mid-review ('pending' while kycReviewState is pending_review/needs_review).
 *
 * Deliberately SEPARATE from tier-rules.deriveTier so the observation-window /
 * cap invariant stays byte-for-byte (deriveTier still treats grandfathered as
 * T1 for *amount* limits; this gate governs whether they may send AT ALL).
 */
export function isSendVerified(customer: { kycStatus: KycStatus } | null | undefined): boolean {
  return customer?.kycStatus === 'verified';
}

export type { Customer };
```

- [ ] **Step 4: Run the test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add src/lib/kyc-gate.ts tests/kyc-gate.test.ts && git commit -m "feat(kyc): isSendVerified send-gate predicate (Phase 3, Task 1)"`

---

## Task 2: `createTransfer` backstop — require a verified sender

**Files:**
- Modify: `src/lib/transfer-create.ts` (`CreateTransferInput` ~line 17; `createTransfer` body ~line 44)
- Test: `tests/transfer-create-gate.test.ts`

The chokepoint backstop. Add a **required** `senderKycStatus` to the input (callers already hold the customer) and assert it at the top of `createTransfer` so no path can create a transfer for an unverified sender.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createStore } from '@/lib/store';
import { createPartnerStore } from '@/lib/partner-store';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { createTransfer } from '@/lib/transfer-create';

function baseInput(over = {}) {
  return {
    phone: '15551230000', recipientName: 'R', recipientPhone: '910000', payoutMethod: 'bank' as const,
    payoutDestination: 'acct', fundingMethod: 'bank_transfer' as const, amountSource: 100,
    sourceCurrency: 'USD' as const, partnerId: 'default', senderKycStatus: 'verified' as const, ...over,
  };
}

describe('createTransfer KYC backstop', () => {
  it('throws kyc_required when senderKycStatus is not "verified"', async () => {
    const r = fakeRedis();
    const stores = [createStore(r), createPartnerStore(r), createMonthlyVolumeStore(r)] as const;
    await expect(createTransfer(stores[0], stores[1], stores[2], baseInput({ senderKycStatus: 'grandfathered' })))
      .rejects.toThrow(/kyc_required/);
  });
  it('proceeds for a verified sender', async () => {
    const r = fakeRedis();
    const t = await createTransfer(createStore(r), createPartnerStore(r), createMonthlyVolumeStore(r), baseInput());
    expect(t.id).toBeTruthy();
  });
});
```
> Note: adjust the `createStore`/`createPartnerStore`/`createMonthlyVolumeStore` import names to the repo's actual factory exports (confirm in `store.ts`/`partner-store.ts`/`monthly-volume-store.ts`); the assertion is the point.

- [ ] **Step 2: Run it to confirm it fails** — FAIL (no `senderKycStatus` / no throw).

- [ ] **Step 3: Implement** — in `CreateTransferInput` add:

```typescript
  senderKycStatus: import('./types').KycStatus;   // Phase 3: hard verify-before-send backstop
```

At the very top of `createTransfer` (before `transfer-create.ts:44`'s `getTransferCount`):

```typescript
  // Phase 3 backstop: the chokepoint refuses to mint a transfer for an
  // unverified sender. Callers gate earlier with friendly UX; this is the
  // last line of defense so no future caller can bypass it.
  if (input.senderKycStatus !== 'verified') {
    throw new Error('kyc_required');
  }
```

- [ ] **Step 4: Run the test to verify it passes** — PASS. Then fix EVERY existing test that reaches `createTransfer` **directly OR indirectly** — the new required `senderKycStatus` + backstop will break them all. Adversarial review confirmed these:
  - `tests/transfer-create.test.ts` — add `senderKycStatus: 'verified'` to each `createTransfer` input.
  - `tests/pay-finalize.test.ts` — its customer comes from `upsertOnFirstInbound`, which defaults to **`'not_started'`** → the backstop now blocks it. Seed the customer as `verified` first (e.g. `customerStore.saveCustomer({...c, kycStatus:'verified'})` in the test setup) so the existing-behavior tests still exercise the success path; add ONE new test that an unverified owner yields `{ ok:false, error:'kyc_required' }` (that one belongs to Task 5).
  - the tools test(s) that drive `create_transfer`/`send_approve_picker` — seed the customer as `verified`.
  - `tests/cron-run.test.ts` (or equivalent) — seed the schedule owner as `verified`.
  - Run `npx vitest run` (whole suite) → all green. This single field touches many suites; do not skip any.

- [ ] **Step 5: Commit** — `git add src/lib/transfer-create.ts tests/transfer-create-gate.test.ts tests/transfer-create.test.ts && git commit -m "feat(kyc): createTransfer requires a verified sender (Phase 3, Task 2)"`

---

## Task 3: Gate the bot create paths + pass `senderKycStatus`

**Files:**
- Modify: `src/lib/tools.ts` — `createTransferTool` (~line 700; customer resolved ~720, both the primary and the legacy explicit-args branch ~782) and `sendApprovePickerTool` (~line 1100; customer ~1120)
- Test: extend the existing tools test that exercises create/approve

Each path already resolves `customer`. Add an early `isSendVerified` check that returns the bot's existing kyc-handoff shape, and thread `senderKycStatus: customer.kycStatus` into every `createTransfer(...)` call.

- [ ] **Step 1: Write the failing test** — in the tools test, seed a customer whose `kycStatus` is `'grandfathered'`, drive `createTransferTool`, and assert it returns `{ kyc_required: true, kyc_url: <truthy> }` and does NOT create a transfer (store has no new transfer). Reuse the test's existing `ctx`/`kycProvider` mock (the mock's `startVerification` returns a url).

- [ ] **Step 2: Run it → FAIL** (transfer is created today).

- [ ] **Step 3: Implement** — at the top of `createTransferTool` (after `customer` is resolved, ~`tools.ts:722`) and again in the legacy explicit-args branch (~`tools.ts:783`), and in `sendApprovePickerTool` (~`tools.ts:1124`):

```typescript
import { isSendVerified, SEND_GATE_REASON } from './kyc-gate';
// ...
if (!isSendVerified(customer)) {
  const start = await ctx.kycProvider.startVerification({ customerId: ctx.phone, senderPhone: ctx.phone });
  return { error: 'Identity verification required before sending.', reason: SEND_GATE_REASON, kyc_required: true, kyc_url: start.url };
}
```

Then add `senderKycStatus: customer.kycStatus` to each `createTransfer(store, partnerStore, monthlyVolumeStore, { ... })` argument object in `tools.ts` (both create call sites).

- [ ] **Step 4: Run the tools test → PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `git add src/lib/tools.ts tests/<tools-test>.ts && git commit -m "feat(kyc): gate bot create/approve paths on verified (Phase 3, Task 3)"`

---

## Task 4: Early UX gate in `getQuoteTool` + `checkSendLimitTool`

**Files:**
- Modify: `src/lib/tools.ts` — `getQuoteTool` (~616; customer ~622) and `checkSendLimitTool` (~1364; customer ~1369)
- Test: extend the tools test

So the bot directs the customer to verify **before** building a transfer (the prompt already calls `check_send_limit` before `get_quote`). Insert the check immediately after `customer` is resolved, before the cap/quote logic. Reuse the existing `startVerification` hand-off already present in both tools.

- [ ] **Step 1: Write the failing test** — unverified customer → `checkSendLimitTool` returns `{ within_cap: false, reason: 'kyc_required', kyc_url: <truthy> }` and `getQuoteTool` returns the same `within_cap:false`+`kyc_url` shape; neither produces a quote.

- [ ] **Step 2: Run it → FAIL.**

- [ ] **Step 3: Implement** — in `checkSendLimitTool` right after `customer` resolves (~`tools.ts:1370`), before `evaluateCap`:

```typescript
if (!isSendVerified(customer)) {
  const start = await ctx.kycProvider.startVerification({ customerId: ctx.phone, senderPhone: ctx.phone });
  return { within_cap: false, reason: SEND_GATE_REASON, kyc_url: start.url };
}
```

Same block in `getQuoteTool` after its `customer` resolve (~`tools.ts:623`), returning the within_cap-false + kyc_url shape that tool already emits for the over-cap case. (This is a NEW condition on `kycStatus`, independent of the existing `ev.tier === 'T0'|'Suspended'` branch — leave that branch intact.)

- [ ] **Step 4: Run the tools test → PASS.**

- [ ] **Step 5: Commit** — `git add src/lib/tools.ts tests/<tools-test>.ts && git commit -m "feat(kyc): early verify hand-off in quote/check_send_limit (Phase 3, Task 4)"`

---

## Task 5: Gate `pay-finalize` + surface `kyc_required` on the pay route

**Files:**
- Modify: `src/lib/pay-finalize.ts` (`FinalizeResult` ~line 33; body after `customer` resolves ~line 55)
- Modify: `src/app/api/pay/[transferId]/route.ts` (the `finalizeDraftPayment` result handling)
- Test: `tests/pay-finalize-gate.test.ts`

- [ ] **Step 1: Write the failing test** — a draft whose owner is `grandfathered` → `finalizeDraftPayment` returns `{ ok: false, error: 'kyc_required' }`, the draft is NOT consumed (peek-before-consume preserves it), and no transfer is saved.

- [ ] **Step 2: Run it → FAIL.**

- [ ] **Step 3: Implement** — extend the union at `pay-finalize.ts:33`:

```typescript
  | { ok: false; error: 'expired_or_used' | 'cap' | 'blocked' | 'kyc_required'; transferId?: string };
```

After `customer` is resolved (`pay-finalize.ts:55`), BEFORE the cap re-check and BEFORE `consumeDraft`:

```typescript
import { isSendVerified } from './kyc-gate';
// ...
if (!isSendVerified(customer)) return { ok: false, error: 'kyc_required' };
```

And pass `senderKycStatus: customer.kycStatus` into the `createTransfer(...)` call at `pay-finalize.ts:79`.

In `route.ts`, where `finalizeDraftPayment`'s `result.error` is mapped to a message, add the `'kyc_required'` case → return `{ ok: false, error: 'Please verify your identity before sending.', kyc_required: true }` with HTTP 403. (Also handle it in the "existing transfer branch": before `processTransferPayment`, load the customer and `if (!isSendVerified(customer)) return 403 kyc_required` — covers scheduled/cron transfers paid on the page.)

- [ ] **Step 4: Run the test → PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `git add src/lib/pay-finalize.ts "src/app/api/pay/[transferId]/route.ts" tests/pay-finalize-gate.test.ts && git commit -m "feat(kyc): gate pay-time finalize + pay route on verified (Phase 3, Task 5)"`

---

## Task 6: Gate cron-fired schedules (skip + notify)

**Files:**
- Modify: `src/lib/cron-run.ts` (`CronDeps` ~lines 11-23; `runDueSchedules` loop, after the opt-out skip ~line 45)
- Modify: `src/app/api/cron/route.ts` (wire the new callback)
- Test: `tests/cron-run-gate.test.ts` (cron-run is pure-ish with injected deps)

- [ ] **Step 1: Write the failing test** — a due schedule whose owner is unverified → `createTransfer` is NOT called, `lastRunAt` is NOT bumped (schedule stays active), and the injected `sendScheduledSkipped` IS called once with the schedule + owner. A verified owner → fires normally.

- [ ] **Step 2: Run it → FAIL.**

- [ ] **Step 3: Implement** — add to `CronDeps` (optional, so existing callers/tests compile):

```typescript
  sendScheduledSkipped?: (schedule: Schedule, owner: Customer | null, kycUrl: string) => Promise<void>;
```

In the loop, immediately after the existing `if (owner?.optedOutAt) continue;` (`cron-run.ts:~46`):

```typescript
import { isSendVerified } from './kyc-gate';
// ...
if (!isSendVerified(owner)) {
  if (deps.sendScheduledSkipped) {
    const start = await deps.kycProvider.startVerification({ customerId: schedule.phone, senderPhone: schedule.phone });
    await deps.sendScheduledSkipped(schedule, owner ?? null, start.url);
  }
  continue; // do NOT createTransfer, do NOT bump lastRunAt → resumes once verified
}
```
> If `CronDeps` has no `kycProvider`, thread one in from the cron route (mirror how the route builds `sendScheduledLink`). Pass `senderKycStatus: owner.kycStatus` into the `createTransfer(...)` call at `cron-run.ts:48`.

Wire `sendScheduledSkipped` in `src/app/api/cron/route.ts`: a fail-soft WhatsApp nudge — `sendTemplateOrText(schedule.phone, () => sendVerificationStatus(schedule.phone, 'needed', owner?.fullName), \`Verify your identity to resume your scheduled transfer: ${kycUrl}\`)`.

- [ ] **Step 4: Run the test → PASS.**

- [ ] **Step 5: Commit** — `git add src/lib/cron-run.ts src/app/api/cron/route.ts tests/cron-run-gate.test.ts && git commit -m "feat(kyc): cron skips + notifies unverified scheduled sends (Phase 3, Task 6)"`

---

## Task 7: Bot system-prompt rule

**Files:**
- Modify: `src/lib/prompt.ts` (after the Suspended rule, ~line 119)
- Test: if `tests/prompt.test.ts` / a bot-content-guard test asserts prompt invariants, extend it; else this is a prompt-copy change (no unit test per convention)

- [ ] **Step 1:** Add a **VERIFY-BEFORE-SEND GATE** block after `prompt.ts:119`:

```
VERIFY-BEFORE-SEND GATE (applies to EVERYONE, including existing/long-time customers):
- check_send_limit and get_quote may return reason:"kyc_required" with a kyc_url even when within cap.
- On kyc_required: DO NOT call get_quote, send_approve_picker, or create_transfer. Reply with a short
  message asking them to verify their identity to continue, and include the kyc_url link. Then wait.
- This is identity verification, not a compliance block — do not use the blocked/holds wording.
```

- [ ] **Step 2:** If a bot-content-guard test enumerates prompt sections, update it. Run the prompt/guard test → PASS.
- [ ] **Step 3: Commit** — `git add src/lib/prompt.ts && git commit -m "feat(kyc): verify-before-send system-prompt rule (Phase 3, Task 7)"`

---

## Task 8: Grandfathered customers see the verify CTA

**Files:**
- Modify: `src/app/account/page.tsx:21` and `src/app/account/verify/page.tsx:16`
- Test: UI (no unit test per repo convention); `tsc` + manual

- [ ] **Step 1:** In `account/page.tsx` the `kycCta`/`done` logic currently treats `kycStatus === 'verified' || 'grandfathered'` as done. Change BOTH `account/page.tsx` and `account/verify/page.tsx` so `done` is `kycStatus === 'verified'` ONLY. Grandfathered now sees "Verify your identity" / the Start-verification button (they must onboard to keep sending).
- [ ] **Step 2:** `npx tsc --noEmit` clean; the `/account` + `/account/verify` pages render with a grandfathered customer showing the CTA.
- [ ] **Step 3: Commit** — `git add src/app/account/page.tsx src/app/account/verify/page.tsx && git commit -m "feat(kyc): grandfathered customers see the verify CTA (Phase 3, Task 8)"`

---

# PART B — Per-transaction OTP step-up

## Task 9: `transaction-otp.ts` — id+phone-bound 6-digit code

**Files:**
- Create: `src/lib/transaction-otp.ts`
- Test: `tests/transaction-otp.test.ts`

A code bound to BOTH the transaction id (draftId/transferId) AND the phone, so a code issued for one transaction can't authorize another, and a code can't be redirected to a different number. Reuses the same crypto primitives as `otp-store` (`randomInt`, `createHash`, `timingSafeEqual`) but a transaction-scoped key `txotp:<sha256(transactionId)>`. 10-min TTL, ≤5 wrong guesses then burn, 30-s resend cooldown. Never log the code.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createTransactionOtpStore } from '@/lib/transaction-otp';

const redis = fakeRedis();
let nowMs = 1_700_000_000_000;
const store = createTransactionOtpStore(redis, { now: () => nowMs, randomInt: () => 123456 });
const TX = 'draft_abc';
const PHONE = '15551230000';

beforeEach(() => { redis.dump.clear(); nowMs = 1_700_000_000_000; });

describe('transaction-otp', () => {
  it('issues a 6-digit code; verifies for the SAME tx+phone; consumes on success', async () => {
    const issued = await store.issue(TX, PHONE);
    expect(issued.ok && issued.code).toBe('123456');
    expect(await store.verify(TX, PHONE, '123456')).toMatchObject({ ok: true });
    // single-use: a second verify fails
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false);
  });
  it('rejects a code from a DIFFERENT transaction or a DIFFERENT phone', async () => {
    await store.issue(TX, PHONE);
    expect((await store.verify('draft_other', PHONE, '123456')).ok).toBe(false);
    expect((await store.verify(TX, '19999999999', '123456')).ok).toBe(false);
  });
  it('expires after the TTL', async () => {
    await store.issue(TX, PHONE);
    nowMs += 11 * 60 * 1000;
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false);
  });
  it('burns after 5 wrong guesses', async () => {
    await store.issue(TX, PHONE);
    for (let i = 0; i < 5; i++) await store.verify(TX, PHONE, '000000');
    expect((await store.verify(TX, PHONE, '123456')).ok).toBe(false); // burned even with the right code
  });
  it('30-s resend cooldown returns ok:false without a new code', async () => {
    await store.issue(TX, PHONE);
    expect((await store.issue(TX, PHONE)).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it → FAIL** (module missing).

- [ ] **Step 3: Implement**

```typescript
import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';

const TTL_S = 10 * 60;
const COOLDOWN_S = 30;
const MAX_ATTEMPTS = 5;

const key = (txId: string) => `txotp:${createHash('sha256').update(txId).digest('hex')}`;
const cdKey = (txId: string) => `txotp:cd:${createHash('sha256').update(txId).digest('hex')}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Rec { codeHash: string; phoneHash: string; attempts: number; expiresAt: number; }
export type IssueResult = { ok: true; code: string } | { ok: false; reason: 'cooldown' };
export type VerifyResult = { ok: true } | { ok: false; reason: 'no_code' | 'expired' | 'locked' | 'wrong' };

export interface TxOtpOptions { now?: () => number; randomInt?: (min: number, max: number) => number; }

export function createTransactionOtpStore(redis: RedisLike, opts: TxOtpOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const randomInt = opts.randomInt ?? ((min: number, max: number) => cryptoRandomInt(min, max));
  return {
    async issue(txId: string, phone: string): Promise<IssueResult> {
      if (await redis.get(cdKey(txId))) return { ok: false, reason: 'cooldown' };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const rec: Rec = { codeHash: sha(code), phoneHash: sha(phone), attempts: 0, expiresAt: now() + TTL_S * 1000 };
      await redis.set(key(txId), JSON.stringify(rec), { ex: TTL_S });
      await redis.set(cdKey(txId), '1', { ex: COOLDOWN_S });
      return { ok: true, code }; // caller delivers it; never logged here
    },
    async verify(txId: string, phone: string, code: string): Promise<VerifyResult> {
      const raw = await redis.get(key(txId));
      if (!raw) return { ok: false, reason: 'no_code' };
      let rec: Rec; try { rec = JSON.parse(raw) as Rec; } catch { return { ok: false, reason: 'no_code' }; }
      if (now() > rec.expiresAt) { await redis.del(key(txId)); return { ok: false, reason: 'expired' }; }
      if (rec.attempts >= MAX_ATTEMPTS) { await redis.del(key(txId)); return { ok: false, reason: 'locked' }; }
      const okPhone = sha(phone) === rec.phoneHash;
      const a = Buffer.from(sha(code), 'utf8'); const b = Buffer.from(rec.codeHash, 'utf8');
      const okCode = a.length === b.length && timingSafeEqual(a, b);
      if (okPhone && okCode) { await redis.del(key(txId)); return { ok: true }; } // single-use
      rec.attempts += 1;
      await redis.set(key(txId), JSON.stringify(rec), { ex: TTL_S });
      return { ok: false, reason: 'wrong' };
    },
  };
}
export type TransactionOtpStore = ReturnType<typeof createTransactionOtpStore>;

let cached: TransactionOtpStore | null = null;
export function getTransactionOtpStore(): TransactionOtpStore {
  if (!cached) {
    const redis = new Redis({ url: env.kvUrl, token: env.kvToken, automaticDeserialization: false });
    cached = createTransactionOtpStore(redis as unknown as RedisLike);
  }
  return cached;
}
```

- [ ] **Step 4: Run the test → PASS.**

- [ ] **Step 5: Commit** — `git add src/lib/transaction-otp.ts tests/transaction-otp.test.ts && git commit -m "feat(otp): per-transaction OTP store, id+phone-bound (Phase 3, Task 9)"`

---

## Task 10: `sendTransactionOtp` — in-session free-form delivery

**Files:**
- Modify: `src/lib/whatsapp.ts` (add a sender)
- Test: `tests/transaction-otp-send.test.ts` (the message-shaping is testable; the Graph send is mocked)

A send happens DURING an active chat (the customer is inside the 24-h customer-service window), so the code is delivered as **free-form text** — no Meta AUTHENTICATION template needed. If the free-form send fails (rare: link opened >24 h later), fall back to the `verification`-style template path via `sendTemplateOrText`.

- [ ] **Step 1: Write the failing test** — `sendTransactionOtp` calls `sendText(phone, <msg containing the code>)`; assert the masked-phone is logged but the code is NOT in any `console` call.

- [ ] **Step 2: Run it → FAIL.**

- [ ] **Step 3: Implement**

```typescript
/**
 * Deliver a per-transaction step-up OTP. A send is in-session (the customer is
 * actively paying), so free-form text works without an AUTHENTICATION template.
 * Never logs the code. Throws only if delivery hard-fails (caller surfaces a
 * generic error); the route still won't finalize without a verified code.
 */
export async function sendTransactionOtp(phone: string, code: string): Promise<void> {
  await sendText(phone, `Your SmartRemit confirmation code is ${code}. Enter it on the payment page to send this transfer. It expires in 10 minutes.`);
}
```

- [ ] **Step 4: Run the test → PASS.**

- [ ] **Step 5: Commit** — `git add src/lib/whatsapp.ts tests/transaction-otp-send.test.ts && git commit -m "feat(otp): in-session free-form transaction-OTP delivery (Phase 3, Task 10)"`

---

## Task 11: Pay route — request + require the transaction OTP

**Files:**
- Modify: `src/app/api/pay/[transferId]/route.ts`
- Test: `tests/pay-route-otp.test.ts` (POST handler test, mocking the stores + `sendTransactionOtp`)

Two behaviors on `POST /api/pay/[transferId]`:
1. `{ action: 'request_otp' }` → resolve the phone from the id (draft peek `getDraft(id).senderPhone`, else `getTransfer(id).phone`), `getTransactionOtpStore().issue(id, phone)`, `sendTransactionOtp(phone, code)`, return `{ ok: true, sent: true }`. No payment.
2. a pay POST (`{ country, fields, otp }`) → resolve phone, `verify(id, phone, otp)`; on failure return `403 { ok: false, error: 'otp', reason }`; on success continue to the EXISTING finalize/process flow unchanged.

- [ ] **Step 1: Write the failing test** — (a) `action:'request_otp'` issues + sends a code (mock `sendTransactionOtp` called once); (b) a pay POST with a WRONG/missing `otp` → 403, no transfer created; (c) a pay POST with the CORRECT `otp` → proceeds (finalize called).

- [ ] **Step 2: Run it → FAIL.**

- [ ] **Step 3: Implement** — near the top of `POST`, after parsing `body`:

```typescript
import { getTransactionOtpStore } from '@/lib/transaction-otp';
import { sendTransactionOtp } from '@/lib/whatsapp';

async function resolvePhone(store: ReturnType<typeof getStore>, id: string): Promise<string | null> {
  const draft = await getDraftStore().getDraft(id);
  if (draft) return draft.senderPhone;
  const t = await store.getTransfer(id);
  return t?.phone ?? null;
}

// ... inside POST, after `const store = getStore();` and body parse:
if ((body as { action?: string }).action === 'request_otp') {
  const phone = await resolvePhone(store, transferId);
  if (!phone) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
  const issued = await getTransactionOtpStore().issue(transferId, phone);
  if (issued.ok) { try { await sendTransactionOtp(phone, issued.code); } catch { /* generic surface */ } }
  return NextResponse.json({ ok: true, sent: true });
}

// require the OTP before ANY money movement:
const otp = String((body as { otp?: unknown }).otp ?? '').replace(/\D/g, '');
const phoneForOtp = await resolvePhone(store, transferId);
if (!phoneForOtp) return NextResponse.json({ ok: false, error: 'expired_or_used' }, { status: 404 });
const otpResult = await getTransactionOtpStore().verify(transferId, phoneForOtp, otp);
if (!otpResult.ok) {
  return NextResponse.json({ ok: false, error: 'Enter the confirmation code we sent to your WhatsApp.', reason: 'otp' }, { status: 403 });
}
// ↓↓↓ existing bank-detail validation + finalize/process flow continues unchanged ↓↓↓
```
> The OTP check sits BEFORE the bank-detail validation + finalize so no transfer is created without a verified code. Note `getDraft` is a non-consuming peek (`finalizeDraftPayment` consumes later), so requesting/verifying the OTP does not burn the draft.

- [ ] **Step 4: Run the test → PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit** — `git add "src/app/api/pay/[transferId]/route.ts" tests/pay-route-otp.test.ts && git commit -m "feat(otp): pay route issues + requires the transaction OTP (Phase 3, Task 11)"`

---

## Task 12: Pay form — the OTP step before "Pay now"

**Files:**
- Modify: `src/app/pay/[transferId]/pay-form.tsx` (`SimplePayForm` ~70; `BankDetailsPayForm` step 2 ~168)
- Test: UI (no unit test per repo convention); manual + the Claude-in-Chrome prompt

Add a shared OTP step to BOTH form variants, shown just before the final "Pay now" action:
- On mount of the pay step (or a "Send code" button), POST `{ action: 'request_otp' }` → shows "We sent a 6-digit code to your WhatsApp."
- A 6-digit `inputMode="numeric"` field + a "Resend code" button (30-s cooldown reflected by the route's `cooldown`).
- The final POST includes `otp: <entered code>` alongside `{ country, fields }`. A `403 { reason: 'otp' }` response shows "That code is incorrect or expired — resend and try again." inline (no charge happened).

- [ ] **Step 1:** Implement a small `<OtpStep transferId=... onVerifiedPay={...} />` island used by both forms; thread the entered `otp` into the existing pay `fetch` body. Reuse `.payapp` theme + the existing `acct-otp-input` styling.
- [ ] **Step 2:** `npx tsc --noEmit` clean; `npm run build` clean; the pay page renders the OTP step before pay.
- [ ] **Step 3: Commit** — `git add "src/app/pay/[transferId]/pay-form.tsx" && git commit -m "feat(otp): pay-page OTP step before paying (Phase 3, Task 12)"`

---

## Task 13: Full gate + handoff

- [ ] **Step 1:** Clean iCloud dups: `find . -path ./node_modules -prune -o \( -name "* [0-9].ts" -o -name "* [0-9].tsx" -o -name "* [0-9].md" \) -delete`
- [ ] **Step 2:** `npx vitest run` → all pass; `npx tsc --noEmit` clean; `npm run build` clean; `npx eslint . --max-warnings 0` clean.
- [ ] **Step 3:** Open the PR; wait for `ci`. Hold prod merge for the user's "deploy" (the gate changes real send behavior — verify on the preview first).
- [ ] **Step 4:** After deploy, generate the Claude-in-Chrome verification prompt (an unverified customer is blocked from sending + gets a verify link; a verified customer must enter the transaction OTP to pay) and update memory.

---

## Self-review (against the spec + locked decisions)

- **Hard gate, everyone incl. grandfathered (§1):** `isSendVerified` = `'verified'` only (Task 1); enforced at the chokepoint (Task 2) + all callers (Tasks 3–6). Grandfathered fails it + sees the CTA (Task 8). ✅
- **Bot + cron both gated (decision):** bot create/quote/approve (Tasks 3–4), pay-finalize (Task 5), cron skip+notify (Task 6). ✅
- **Observation invariant (§1):** `tier-rules.ts` untouched; the gate is a separate predicate (Task 1 comment + boundary). ✅
- **Gate-by-status, no migration (decision):** no migration task; grandfathered rows unchanged. ✅
- **Immediate hard block (decision):** no grace-window logic anywhere. ✅
- **OTP every transaction (user):** transaction-OTP (Task 9) bound to id+phone, delivered in-session free-form (Task 10), required at the pay boundary (Task 11), UI (Task 12). Cron-created sends still pay on the page → OTP applies; no unattended charge. ✅
- **No-template dependency for the transaction OTP:** free-form `sendText` (Task 10) — confirmed independent of the still-pending Meta AUTHENTICATION template that login needs. ✅

**Placeholder scan:** the tool/route line numbers are anchors (verified in the grounding pack) — re-confirm with a grep at execution since earlier tasks shift them. The only "confirm at execution" notes are exact factory export names (Task 2) + whether `CronDeps` already carries a `kycProvider` (Task 6) — both resolved by reading the file before editing, not left as TODOs. **Type consistency:** `isSendVerified`, `SEND_GATE_REASON`, `senderKycStatus`, `FinalizeResult` `'kyc_required'`, `createTransactionOtpStore`/`getTransactionOtpStore`, `sendTransactionOtp` are used identically across tasks.

**Adversarial review (2-agent):** confirmed all 5 `createTransfer` callers + both pay-route branches are gated (zero uncovered money paths); OTP can't be replayed (id+phone-bound, single-use) or skipped (check sits before both pay branches); no cron unattended-charge hole (cron creates but doesn't charge — the human pay step enforces the OTP); the OTP-request peek doesn't burn the draft. The one finding — the required `senderKycStatus` breaks indirect-caller tests — is patched into Task 2 Step 4.

**Scope note:** Part A and Part B are independently shippable. If you prefer smaller PRs, ship Tasks 1–8 (the KYC gate) first, then Tasks 9–12 (the OTP). The plan is ordered so that's a clean split.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-customer-onboarding-phase3-send-gate.md`. Per the `sendhome-execution-interactive` memory, execution is **checkpoint-per-task** (report after each task). **Two design choices to confirm before building:** (1) the per-transaction OTP lives as a **pay-page step-up** (not an in-chat OTP) — cleaner + reuses infra; (2) Part A + Part B can ship as one PR or two. Flag either now if you'd change them.

