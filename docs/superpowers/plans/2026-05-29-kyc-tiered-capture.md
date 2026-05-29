# KYC Tiered Data-Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Western-Union's four-tier KYC/AML data model — **Core-ID (CIP)**, **Travel-Rule counterparty**, **risk/PEP screening of sender + recipient**, and **Enhanced Due Diligence (EDD) at the $3,000 cumulative threshold** — as structured, screenable, scope-aware data, shipped fully **dormant**. A send whose **rolling-month USD-equivalent volume + the requested amount stays under $3,000** is processed **byte-for-byte** as today: the bot asks for exactly today's six fields, `check_send_limit` returns the same shape plus a benign `edd_required: false`, `screenTransfer` produces the same `ComplianceStatus`/`reasons`, and no new field is required. Every new `Customer`/`Transfer` field is **optional**; `MonthlyVolumeStore` is **new** (no migration); Persona and a real sanctions API stay **deferred** behind the unchanged `KycProvider` / `SanctionsScreener` seams. The 453-test suite staying green is the executable dormancy proof.

**Architecture:** This batch stacks on the merged **P5** (`spec/p5-per-corridor-compliance`). It reuses P5's `SanctionsScreener` seam (`src/lib/providers/sanctions-provider.ts` → `getSanctionsScreener`/`MockSanctionsScreener`) to screen the **sender** name (extending the recipient-only screen already in `screenTransfer`), and P4's USD-equivalent accounting (`amountUsd` cents). Two **pure** helpers in `tier-rules.ts` (`evaluateEdd`, `evaluateEddForTransfer`) compute the EDD trigger off a new `MonthlyVolumeStore` (a direct mirror of `daily-volume-store.ts` keyed per ET calendar month, USD-equivalent cents). `check_send_limit` reads monthly volume and returns an additive `edd_required` flag (the progressive gate); the agent collects `source_of_funds`/`occupation` **only** when that flag is true. `createTransfer` merges a `'flagged'` + `'edd_required'` result **after** `screenTransfer` (a watchlist block always wins; EDD never blocks), then calls `monthlyVolumeStore.addCents` after save — exactly as the daily store is added today. The dashboard renders the captured Core-ID/PEP/EDD fields scope-aware (with `govIdNumber` masked) and surfaces flagged-EDD transfers for triage.

```
check_send_limit({ amount_usd })                       src/lib/tools.ts
  │  resolveCurrencyAndRates → amountUsd (USD-equiv)
  │  todayUsedCents = dailyVolumeStore.getTodayCents(phone)        (cap path — UNCHANGED)
  │  monthUsedCents = monthlyVolumeStore.getMonthCents(phone)      ← NEW
  │  evaluateCap(...)                                              (UNCHANGED)
  │  evaluateEdd(monthUsedCents, requestedCents)                  ← NEW (tier-rules.ts, pure)
  ▼  returns { ...today's fields, edd_required, edd_threshold_usd }
  │  edd_required === false → bot asks NOTHING new (DORMANT)
  │  edd_required === true  → prompt rule: collect source_of_funds + occupation
  ▼
createTransfer(store, partnerStore, monthlyVolumeStore, input)   src/lib/transfer-create.ts
  ├── screenTransfer({ …, recipientName, senderName })           src/lib/compliance.ts
  │       recipient + sender screened via SanctionsScreener (P5 seam, REUSED)
  └── evaluateEddForTransfer(monthUsedCents, requestedCents, eddFieldsPresent)
          crosses $3k AND SoF/occupation missing ⇒ merge 'flagged' + 'edd_required' (NEVER block)
  ▼  monthlyVolumeStore.addCents(phone, round(amountUsd*100))     ← NEW (after save)
```

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, Upstash Redis.

**Spec:** `docs/superpowers/specs/2026-05-29-kyc-tiered-capture-design.md`

**Branch:** `spec/kyc-tiered-capture` (branch off the merged P5 base — `getSanctionsScreener`/`MockSanctionsScreener`, the async corridor-aware `screenTransfer` with optional `sourceCountry`/`rules`/`screener`, `ResolvedCorridorRules`/`kycCapHintUsd`, `createTransfer(store, partnerStore, input)`, and `countryForCurrency` are all already present on the working base here).

**Test count delta:** from **453** (54 files). New `tests/monthly-volume-store.test.ts` (~6), `tests/mask.test.ts` (~2); extensions to `tier-rules.test.ts` (~10), `compliance.test.ts` (~5), `tools.test.ts` (~8), `transfer-create.test.ts` (~7), `bot-content-guard.test.ts` (~3), `prompt.test.ts` (~2). Net **+~43 → ~496**. The full pre-batch suite staying green is the executable **dormancy proof**.

**Patterns to reuse (do not reinvent):**
- **Volume store mirror:** `src/lib/daily-volume-store.ts` — same read-modify-write `addCents`, `automaticDeserialization: false` singleton, `fakeRedis()`-friendly `RedisLike`. `MonthlyVolumeStore` is byte-identical in shape with a `monthly_volume:` namespace and a longer TTL.
- **ET date helper:** `src/lib/dates.ts` `easternDate`. NOTE — `easternDate` returns `en-US` locale (`M/D/YYYY`), **not** ISO, so `easternMonth` must build `YYYY-MM` directly via `toLocaleString('en-US', { timeZone, year, month })`, not by slicing `easternDate`.
- **Pure tier helpers:** `src/lib/tier-rules.ts` `deriveTier`/`evaluateCap` — EDD helpers sit beside them, orthogonal, leaving `evaluateCap` byte-for-byte unchanged.
- **Pluggable seam (deferred):** `SanctionsScreener` (`src/lib/providers/sanctions-provider.ts`) is REUSED for sender screening; `KycProvider`/`MockKycProvider` (Persona) stays untouched.
- **Lazy-fill on read, never write on read paths:** `customer-store.getCustomer` fills `senderCountry`/`partnerId` in memory only. New optional fields need no fill — `undefined` means "not captured" and renders `'—'`.
- **Sticky EDD profile:** once `sourceOfFunds`/`occupation` are persisted onto the `Customer`, an EDD-eligible returning customer is **not** re-asked (`eddFieldsPresent` short-circuits the flag and the prompt gate).
- **Server-action security checklist:** this batch adds **no** new mutating server action (capture rides the bot path + the existing `markCustomerVerifiedAction`/`markCustomerRejectedAction`). A staff PII-edit form is deferred (spec open question 5); if added it must clear the full checklist.
- **Untrusted input, defensive:** every LLM enum arg validated against its closed set (unknown → unsupplied, so `eddFieldsPresent` stays false → flag, never silent-pass); `?? ''`/`trim` on PII strings; `Number(...) ?? 0` on volume cents; `??` not `||`; no `as any`; `fakeRedis()` in tests; commit prefix `feat(kyc):`.

**CI reminders:**
- `main` branch protection requires the `ci / ci` status check; no direct pushes. Open a PR; Vercel auto-deploys on merge; Playwright smoke runs against prod.
- The full local gate is `npm run typecheck && npm run lint && npx vitest run && npm run build`.
- `bot-content-guard.test.ts` must stay green — the bot stays PII-blind and partner-blind; no new field value or internal term may appear in chat content.
- GitGuardian may red on the known env-var-name false positive; `ci` is the required check.

---

## File Map

**New files:**
- `src/lib/monthly-volume-store.ts` — `createMonthlyVolumeStore`/`getMonthlyVolumeStore`/`MonthlyVolumeStore` (mirror of the daily store; `monthly_volume:` namespace; 35-day TTL; USD-equivalent cents).
- `tests/monthly-volume-store.test.ts` — store unit tests (~6).
- `tests/mask.test.ts` — `maskLast4` pure-helper unit tests (~2).

**Modified files:**
- `src/lib/dates.ts` — add `easternMonth(epochMs): string` (`YYYY-MM`, ET).
- `src/lib/types.ts` — Core-ID/Tier-3 `Customer` fields + `GovIdType`/`SourceOfFunds`/`Occupation`; Travel-Rule/EDD `Transfer` fields + `SenderRecipientRelationship`/`TransferPurpose`; Travel-Rule/EDD fields on `Draft`.
- `src/lib/tier-rules.ts` — `EDD_THRESHOLD_CENTS`, `EddEvaluation`, `evaluateEdd`, `evaluateEddForTransfer` (pure; `evaluateCap` unchanged).
- `src/lib/compliance.ts` — `screenTransfer` gains optional `senderName`, screened via the same `SanctionsScreener` seam.
- `src/lib/transfer-create.ts` — `CreateTransferInput` gains optional Travel-Rule/EDD fields; `createTransfer` gains a `monthlyVolumeStore` param, screens sender, merges the EDD flag, writes Travel-Rule fields, and `addCents` after save.
- `src/lib/tools.ts` — `ToolContext.monthlyVolumeStore`; `check_send_limit` returns `edd_required`/`edd_threshold_usd`; optional EDD/Travel-Rule enum args on `create_transfer`/`send_approve_picker`/`create_schedule`; EDD enums persisted onto the `Customer`; all `createTransfer(...)` call sites updated.
- `src/lib/agent.ts` — `AgentDeps.monthlyVolumeStore`; threaded into `executeTool` context.
- `src/app/api/whatsapp/route.ts` + `src/app/api/cron/route.ts` — `getMonthlyVolumeStore()` wired into agent deps / cron deps.
- `src/lib/cron-run.ts` — `CronDeps.monthlyVolumeStore`; passed into `createTransfer`.
- `src/lib/mask.ts` (new tiny helper) — `maskLast4`.
- `src/lib/prompt.ts` — conditional ENHANCED VERIFICATION block (asks nothing unless `edd_required: true`).
- `src/app/dashboard/customers/[phone]/page.tsx` — Core-ID + PEP + EDD rows in the Identity & KYC card, `govIdNumber` masked.
- `src/app/dashboard/compliance/page.tsx` — distinct "EDD required" label on the flagged tab.
- `tests/tier-rules.test.ts`, `tests/compliance.test.ts`, `tests/tools.test.ts`, `tests/transfer-create.test.ts`, `tests/bot-content-guard.test.ts`, `tests/prompt.test.ts` — extensions.

---

## Task 1: Types — Core-ID / Tier-3 / Travel-Rule / EDD fields + enums

**Goal:** Add every new enum and optional field to `Customer`, `Transfer`, and `Draft` — no behavior change, just the shapes every later task references. `fullName`/`dateOfBirth`/`country` already exist on `Customer`; do **not** duplicate.

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add the closed-list enums**

In `src/lib/types.ts`, after the `KycStatus` union (ends line 174, before `export interface Customer`), add the Core-ID + EDD enums:

```ts
// ── KYC tiered capture: closed-list enums (screenable, friction-free) ──
export type GovIdType = 'passport' | 'drivers_license' | 'national_id' | 'state_id';

export type SourceOfFunds =
  | 'employment' | 'business' | 'investment' | 'gift' | 'savings' | 'other';

export type Occupation =
  | 'salaried' | 'self_employed' | 'business_owner' | 'student'
  | 'homemaker' | 'retired' | 'unemployed' | 'other';
```

After the `Transfer` interface (ends line 57), add the Travel-Rule enums:

```ts
// ── KYC Travel-Rule (Tier 2) enums — per-send counterparty data ──
export type SenderRecipientRelationship =
  | 'self' | 'spouse' | 'parent' | 'child' | 'sibling'
  | 'other_family' | 'friend' | 'business' | 'other';

export type TransferPurpose =
  | 'family_support' | 'gift' | 'education' | 'medical'
  | 'savings' | 'bills' | 'business' | 'other';
```

- [ ] **Step 2: Add the optional `Customer` fields**

Inside `export interface Customer` (lines 176–190), after `dateOfBirth?: string;` (line 184) and before `country?: string;` (line 185), add the Core-ID / Tier-3 / EDD-profile fields. `nationality` is a typed `CountryCode`, deliberately distinct from the legacy free-text `country`:

```ts
  // ── KYC Tier 1 Core-ID (CIP) — all optional (dormant) ──
  residentialAddress?: string;   // single-line residential address (captured, not validated)
  govIdType?: GovIdType;
  govIdNumber?: string;          // PII — dashboard masks to last 4
  nationality?: CountryCode;     // ISO 3166-1 alpha-2 (typed, unlike legacy `country`)
  // ── KYC Tier 3 Risk ──
  pepDeclared?: boolean;         // self-declared Politically Exposed Person flag
  // ── KYC Tier 4 EDD profile (sticky once captured) ──
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  eddCapturedAt?: string;        // ISO — when EDD enums were last supplied
```

- [ ] **Step 3: Add the optional `Transfer` fields**

Inside `export interface Transfer` (lines 27–57), after `totalChargeSource: number;` (line 56), add the per-send Travel-Rule + EDD snapshot fields:

```ts
  // ── KYC Tier 2 Travel-Rule (per-send) — all optional (dormant) ──
  recipientLegalName?: string;            // legal name distinct from display recipientName
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  // ── KYC Tier 4 EDD snapshot at send time ──
  eddRequired?: boolean;                  // true when this send crossed the $3k cumulative trigger
```

> `complianceReasons: string[]` (line 41) is unchanged — the `'edd_required'` flag rides the existing array, mirroring P5's reason-string approach. No schema change there.

- [ ] **Step 4: Add the optional `Draft` fields**

Inside `export interface Draft` (lines 132–150), after `fundingMethod: FundingMethod;` (line 143), add the optional Travel-Rule/EDD fields so the approve-tap path can carry them from the picker into `CreateTransferInput`:

```ts
  // ── KYC Travel-Rule / EDD (optional; populated only on the EDD path) ──
  recipientLegalName?: string;
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. Every new field is optional, so no existing `Customer`/`Transfer`/`Draft` literal (in `customer-store.ts`, `transfer-create.ts`, `tools.ts`, fixtures) needs updating.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(kyc): Core-ID/Travel-Rule/EDD optional fields + enums on Customer/Transfer/Draft"
```

---

## Task 2: `easternMonth` ET calendar-month helper

**Goal:** Add a 3-line sibling of `easternDate` that returns a stable `YYYY-MM` string in `America/New_York`, to key the monthly volume store. (`easternDate` returns `en-US` `M/D/YYYY`, so it cannot be sliced into `YYYY-MM` — build it directly.)

**Files:**
- Modify: `src/lib/dates.ts`
- Test: `tests/dates.test.ts` (extend if present; otherwise inline cases in `monthly-volume-store.test.ts` cover it — confirm in Step 1)

- [ ] **Step 1: Write the failing test**

If `tests/dates.test.ts` exists, add cases; otherwise create it:

```ts
import { describe, it, expect } from 'vitest';
import { easternMonth } from '@/lib/dates';

describe('easternMonth', () => {
  it('returns YYYY-MM in Eastern time', () => {
    // 2026-05-24 18:00Z = 2pm ET → May 2026
    expect(easternMonth(Date.parse('2026-05-24T18:00:00Z'))).toBe('2026-05');
  });
  it('uses the Eastern calendar boundary, not UTC', () => {
    // 2026-06-01 03:00Z = 2026-05-31 23:00 ET → still May in ET
    expect(easternMonth(Date.parse('2026-06-01T03:00:00Z'))).toBe('2026-05');
  });
  it('zero-pads single-digit months', () => {
    expect(easternMonth(Date.parse('2026-01-15T18:00:00Z'))).toBe('2026-01');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/dates.test.ts`
Expected: FAIL — `easternMonth` not exported.

- [ ] **Step 3: Implement `easternMonth` in `src/lib/dates.ts`**

Add after `easternDate` (line 5). Build `YYYY-MM` directly from the ET-localized year + numeric month (do not reuse `easternDate`, which is `M/D/YYYY`):

```ts
export function easternMonth(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.toLocaleString('en-US', { timeZone: ET, year: 'numeric' });
  const month = d.toLocaleString('en-US', { timeZone: ET, month: '2-digit' });
  return `${year}-${month}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dates.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dates.ts tests/dates.test.ts
git commit -m "feat(kyc): easternMonth(YYYY-MM, ET) helper for monthly volume keying"
```

---

## Task 3: `MonthlyVolumeStore` (mirror of `daily-volume-store.ts`)

**Goal:** A direct mirror of `createDailyVolumeStore`, keyed per phone per ET calendar **month**, holding **USD-equivalent cents**. Drives the cumulative EDD trigger. New `monthly_volume:` namespace — no migration, no collision with `daily_volume:`. A first read of a never-written key returns `0` (dormant).

**Files:**
- Create: `src/lib/monthly-volume-store.ts`
- Test: `tests/monthly-volume-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/monthly-volume-store.test.ts` (mirror `tests/daily-volume-store.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';
const OTHER = '15559999999';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-24T18:00:00Z')); // May 2026, 2pm ET
});
afterEach(() => vi.useRealTimers());

describe('monthly-volume store', () => {
  it('getMonthCents returns 0 when nothing recorded (dormant)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    expect(await mvs.getMonthCents(PHONE)).toBe(0);
  });

  it('addCents + getMonthCents round-trips', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 250_000); // $2,500
    expect(await mvs.getMonthCents(PHONE)).toBe(250_000);
  });

  it('multiple addCents accumulate (catches structuring across many sends)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 100_000);
    await mvs.addCents(PHONE, 150_000);
    await mvs.addCents(PHONE, 60_000);
    expect(await mvs.getMonthCents(PHONE)).toBe(310_000);
  });

  it('isolates per phone', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 250_000);
    expect(await mvs.getMonthCents(OTHER)).toBe(0);
  });

  it('isolates per ET calendar month (different month → separate counter)', async () => {
    const mvs = createMonthlyVolumeStore(fakeRedis());
    await mvs.addCents(PHONE, 250_000);
    vi.setSystemTime(new Date('2026-06-15T18:00:00Z')); // June 2026
    expect(await mvs.getMonthCents(PHONE)).toBe(0);
  });

  it('addCents sets a 35-day TTL on the month key', async () => {
    const redis = fakeRedis();
    let capturedOpts: { ex?: number } | undefined;
    const origSet = redis.set.bind(redis);
    redis.set = async (k, v, o) => {
      if (k.startsWith('monthly_volume:')) capturedOpts = o;
      return origSet(k, v, o);
    };
    const mvs = createMonthlyVolumeStore(redis);
    await mvs.addCents(PHONE, 1);
    expect(capturedOpts?.ex).toBe(35 * 24 * 60 * 60);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/monthly-volume-store.test.ts`
Expected: FAIL — module `@/lib/monthly-volume-store` not found.

- [ ] **Step 3: Implement `src/lib/monthly-volume-store.ts`**

Mirror `daily-volume-store.ts` exactly, swapping `easternDate`→`easternMonth`, the namespace, and the TTL:

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import { easternMonth } from './dates';
import type { RedisLike } from './store';

const MONTH_TTL_SECONDS = 35 * 24 * 60 * 60; // keep last month for late audits / rollover

export function createMonthlyVolumeStore(redis: RedisLike) {
  function key(senderPhone: string): string {
    return `monthly_volume:${senderPhone}:${easternMonth(Date.now())}`;
  }

  return {
    async getMonthCents(senderPhone: string): Promise<number> {
      const raw = await redis.get(key(senderPhone));
      return raw ? Number(raw) : 0;
    },

    async addCents(senderPhone: string, cents: number): Promise<void> {
      const k = key(senderPhone);
      const current = Number((await redis.get(k)) ?? '0');
      await redis.set(k, String(current + cents), { ex: MONTH_TTL_SECONDS });
    },
  };
}

export type MonthlyVolumeStore = ReturnType<typeof createMonthlyVolumeStore>;

let cached: MonthlyVolumeStore | null = null;

export function getMonthlyVolumeStore(): MonthlyVolumeStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createMonthlyVolumeStore(redis as unknown as RedisLike);
  }
  return cached;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/monthly-volume-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/monthly-volume-store.ts tests/monthly-volume-store.test.ts
git commit -m "feat(kyc): MonthlyVolumeStore (mirror of daily store; USD-equiv cents, new namespace)"
```

---

## Task 4: EDD trigger in `tier-rules.ts` — pure, TDD'd

**Goal:** Add `EDD_THRESHOLD_CENTS = 300_000` and two pure helpers — `evaluateEdd` (cumulative-month + requested ≥ $3k) and `evaluateEddForTransfer` (flag only when required **and** fields absent; **never** blocks). Orthogonal to the cap tier, so `evaluateCap` is byte-for-byte unchanged.

**Files:**
- Modify: `src/lib/tier-rules.ts`
- Test: `tests/tier-rules.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/tier-rules.test.ts`:

```ts
import {
  EDD_THRESHOLD_CENTS,
  evaluateEdd,
  evaluateEddForTransfer,
  evaluateCap,           // regression import (must already be tested)
} from '@/lib/tier-rules';

describe('evaluateEdd (cumulative $3k trigger)', () => {
  it('exports EDD_THRESHOLD_CENTS = 300_000 ($3,000)', () => {
    expect(EDD_THRESHOLD_CENTS).toBe(300_000);
  });
  it('below threshold → not required (dormant)', () => {
    expect(evaluateEdd(0, 20_000).eddRequired).toBe(false);        // single $200 send
    expect(evaluateEdd(250_000, 49_000).eddRequired).toBe(false);  // 2,500 + 490 = 2,990
  });
  it('exactly at $3,000 → required (>= inclusive)', () => {
    expect(evaluateEdd(0, 300_000).eddRequired).toBe(true);
    expect(evaluateEdd(240_000, 60_000).eddRequired).toBe(true);   // 2,400 + 600 = 3,000
  });
  it('cumulative crossing catches structuring (250k month + 60k send)', () => {
    expect(evaluateEdd(250_000, 60_000).eddRequired).toBe(true);   // 3,100
  });
  it('surfaces month/requested/threshold for messaging', () => {
    const e = evaluateEdd(250_000, 60_000);
    expect(e).toEqual({
      eddRequired: true, monthUsedCents: 250_000,
      requestedCents: 60_000, thresholdCents: 300_000,
    });
  });
});

describe('evaluateEddForTransfer (flag-only, never block)', () => {
  it('flags when required AND fields absent', () => {
    expect(evaluateEddForTransfer({ monthUsedCents: 250_000, requestedCents: 60_000, eddFieldsPresent: false }))
      .toEqual({ eddRequired: true, flagReason: 'edd_required' });
  });
  it('no flag when required but fields present (sticky profile satisfies it)', () => {
    expect(evaluateEddForTransfer({ monthUsedCents: 250_000, requestedCents: 60_000, eddFieldsPresent: true }))
      .toEqual({ eddRequired: true });
  });
  it('no flag on the dormant path (not required)', () => {
    expect(evaluateEddForTransfer({ monthUsedCents: 0, requestedCents: 20_000, eddFieldsPresent: false }))
      .toEqual({ eddRequired: false });
  });
  it('never returns a block reason', () => {
    const r = evaluateEddForTransfer({ monthUsedCents: 500_000, requestedCents: 100_000, eddFieldsPresent: false });
    expect(r.flagReason).toBe('edd_required');
    expect(JSON.stringify(r)).not.toContain('block');
  });
});

describe('evaluateCap regression (EDD is orthogonal — cap math unchanged)', () => {
  it('a T1 verified customer still computes today\'s cap regardless of EDD', () => {
    const customer = {
      senderPhone: '1', firstSeenAt: '2026-01-01T00:00:00Z', kycStatus: 'verified' as const,
      senderCountry: 'US' as const, partnerId: 'default', createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const ev = evaluateCap(customer, new Date('2026-05-29T00:00:00Z'), 0, 100_000);
    expect(ev.tier).toBe('T1');
    expect(ev.dailyCapCents).toBe(299_900); // unchanged T1_DAILY_CAP_CENTS
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tier-rules.test.ts`
Expected: FAIL — `EDD_THRESHOLD_CENTS`/`evaluateEdd`/`evaluateEddForTransfer` not exported.

- [ ] **Step 3: Implement the EDD helpers in `src/lib/tier-rules.ts`**

Append after `evaluateCap` (ends line 58). Do **not** touch `deriveTier`/`evaluateCap` or the existing constants:

```ts
export const EDD_THRESHOLD_CENTS = 300_000;   // $3,000 USD-equivalent

export interface EddEvaluation {
  eddRequired: boolean;          // cumulative-month + requested >= $3,000
  monthUsedCents: number;
  requestedCents: number;
  thresholdCents: number;        // EDD_THRESHOLD_CENTS (surfaced for messaging)
}

// Cumulative trigger: does this send push the rolling-month total to/over $3k?
// `>=` so a send landing exactly on $3,000 trips EDD (regulatory threshold is inclusive).
export function evaluateEdd(
  monthUsedCents: number,
  requestedCents: number,
): EddEvaluation {
  const month = Number(monthUsedCents) || 0;      // defensive (untrusted/coerced)
  const requested = Number(requestedCents) || 0;
  const eddRequired = month + requested >= EDD_THRESHOLD_CENTS;
  return { eddRequired, monthUsedCents: month, requestedCents: requested, thresholdCents: EDD_THRESHOLD_CENTS };
}

// At create time: if EDD is required AND the EDD profile fields are absent,
// the transfer is FLAGGED (never blocked). Returns the reason to merge.
export function evaluateEddForTransfer(input: {
  monthUsedCents: number;
  requestedCents: number;
  eddFieldsPresent: boolean;     // sourceOfFunds && occupation both set
}): { eddRequired: boolean; flagReason?: 'edd_required' } {
  const { eddRequired } = evaluateEdd(input.monthUsedCents, input.requestedCents);
  if (eddRequired && !input.eddFieldsPresent) return { eddRequired, flagReason: 'edd_required' };
  return { eddRequired };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tier-rules.test.ts`
Expected: PASS — including the `evaluateCap` regression.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tier-rules.ts tests/tier-rules.test.ts
git commit -m "feat(kyc): EDD_THRESHOLD_CENTS + pure evaluateEdd/evaluateEddForTransfer (flag-only)"
```

---

## Task 5: Sender screening through the P5 `SanctionsScreener` seam

**Goal:** `screenTransfer` already screens the **recipient** via `SanctionsScreener` (P5). Add an optional `senderName` screened through the **same seam** — no new provider. The dormant path passes nothing → `senderHit = { matched: false }` → byte-for-byte today's recipient-only result.

**Files:**
- Modify: `src/lib/compliance.ts`
- Test: `tests/compliance.test.ts`

- [ ] **Step 1: Add the failing sender-screening cases**

Append to `tests/compliance.test.ts` (the file already imports `screenTransfer`, `GLOBAL_DEFAULTS`, `MockSanctionsScreener`):

```ts
describe('screenTransfer — sender screening (KYC, same SanctionsScreener seam)', () => {
  it('dormant: no senderName reproduces today\'s recipient-only cleared result', async () => {
    const r = await screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US' });
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
  });
  it('a watchlisted SENDER name blocks (screened via the seam)', async () => {
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US',
      senderName: 'John Doe',     // on the default WATCHLIST
    });
    expect(r.status).toBe('blocked');
  });
  it('clean sender + watchlisted recipient still blocks (recipient path unchanged)', async () => {
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'John Doe', transfersToday: 0, sourceCountry: 'US',
      senderName: 'Clean Person',
    });
    expect(r.status).toBe('blocked');
  });
  it('clean sender + clean recipient clears (no false positive)', async () => {
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'US',
      senderName: 'Clean Person',
    });
    expect(r.status).toBe('cleared');
  });
  it('an injected screener is used for the sender too', async () => {
    const screener = new MockSanctionsScreener(['only this sender']);
    const r = await screenTransfer({
      amountUsd: 200, recipientName: 'Mom', transfersToday: 0, sourceCountry: 'GB',
      senderName: 'Only This Sender', screener,
    });
    expect(r.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/compliance.test.ts`
Expected: FAIL — `screenTransfer` has no `senderName` param, so the sender-block cases clear instead of block.

- [ ] **Step 3: Add `senderName` to `screenTransfer` in `src/lib/compliance.ts`**

Add the optional param and a second `screener.screen` call, OR-ing the hits. Keep the same blocked-reason precedence and shape. Replace the input type + the recipient-screen block (current lines 20–42):

```ts
export async function screenTransfer(input: {
  amountUsd: number;                 // USD-equivalent (unchanged; fed by quote.amountUsd)
  recipientName: string;
  transfersToday: number;
  sourceCountry?: CountryCode;       // P5 — jurisdiction scoping
  rules?: ResolvedCorridorRules;     // P5 — defaults to GLOBAL_DEFAULTS
  screener?: SanctionsScreener;      // P5 — defaults to a mock over rules' base ∪ extra
  senderName?: string;               // NEW (KYC) — sender legal name, screened via the SAME seam
}): Promise<ComplianceResult> {
  const rules = input.rules ?? GLOBAL_DEFAULTS;
  const screener =
    input.screener ??
    getSanctionsScreener([...rules.baseWatchlist, ...rules.watchlistExtra]);
  const sourceCountry = input.sourceCountry ?? 'US';

  const recipientHit = await screener.screen({ name: input.recipientName ?? '', sourceCountry });
  const senderHit = input.senderName
    ? await screener.screen({ name: input.senderName ?? '', sourceCountry })   // NEW (KYC)
    : { matched: false };
  if (recipientHit.matched || senderHit.matched) {
    return {
      status: 'blocked',
      reasons: ['Recipient is on the compliance watchlist.'],
    };
  }
```

> **Reason-string note (spec open question 1):** v1 reuses the existing `'Recipient is on the compliance watchlist.'` for a sender hit to keep dormancy (zero churn to existing assertions and dashboard rendering). A distinct `'Sender is on the compliance watchlist.'` is the documented fast-follow; if adopted, budget the extra assertion in this test and a dashboard-label check.

- [ ] **Step 4: Run the compliance test to verify green**

Run: `npx vitest run tests/compliance.test.ts`
Expected: PASS — all P5 cases plus the new sender cases. The dormant (no-`senderName`) cases reproduce today exactly.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean — `senderName` is optional; the single caller (`transfer-create.ts`) does not yet pass it, which is fine (dormant).

- [ ] **Step 6: Commit**

```bash
git add src/lib/compliance.ts tests/compliance.test.ts
git commit -m "feat(kyc): screenTransfer screens sender + recipient via the same SanctionsScreener seam"
```

---

## Task 6: `maskLast4` helper for dashboard PII

**Goal:** A tiny pure helper that masks a government-ID number to its last 4 digits for read-only display. Defensive `?? ''`. Unit-tested (the only piece of the dashboard work covered by Vitest; pages are smoke-only per convention).

**Files:**
- Create: `src/lib/mask.ts`
- Test: `tests/mask.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mask.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { maskLast4 } from '@/lib/mask';

describe('maskLast4', () => {
  it('returns the last 4 of a long value', () => {
    expect(maskLast4('A1234567')).toBe('4567');
  });
  it('returns the whole short value when 4 or fewer chars', () => {
    expect(maskLast4('99')).toBe('99');
  });
  it('handles undefined / empty defensively', () => {
    expect(maskLast4(undefined)).toBe('');
    expect(maskLast4('')).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/mask.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/mask.ts`**

```ts
// Mask a high-sensitivity value (e.g. a government-ID number) to its last 4
// characters for read-only display. Defensive against undefined/short input.
// App-level field encryption of PII is OUT OF SCOPE for the prototype (the
// Upstash layer provides at-rest encryption); this masking is the minimum
// dashboard exposure control.
export function maskLast4(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v.length <= 4 ? v : v.slice(-4);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mask.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mask.ts tests/mask.test.ts
git commit -m "feat(kyc): maskLast4 helper for read-only PII display"
```

---

## Task 7: `check_send_limit` returns `edd_required` + thread `monthlyVolumeStore` into `ToolContext`

**Goal:** Extend `check_send_limit` to read monthly volume and return an additive `edd_required` flag (false on the dormant path) plus `edd_threshold_usd`; today's returned fields are byte-for-byte unchanged. Add `monthlyVolumeStore` to `ToolContext`. This is the progressive gate the prompt keys off.

**Files:**
- Modify: `src/lib/tools.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/tools.test.ts` (the harness already builds a `ToolContext` with `dailyVolumeStore`; add a `monthlyVolumeStore: createMonthlyVolumeStore(redis)` beside it in the shared context builder, then):

```ts
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';

it('check_send_limit: dormant path returns edd_required:false with all today\'s fields intact', async () => {
  const res = await executeTool('check_send_limit', { amount_usd: 200 }, ctx);
  // Today's fields unchanged (regression):
  expect(res).toHaveProperty('within_cap');
  expect(res).toHaveProperty('tier');
  expect(res).toHaveProperty('daily_cap_usd');
  expect(res).toHaveProperty('today_remaining_usd');
  // Additive KYC fields:
  expect(res.edd_required).toBe(false);
  expect(res.edd_threshold_usd).toBe(3000);
});

it('check_send_limit: edd_required:true when cumulative-month + requested >= $3k and SoF/occupation absent', async () => {
  await ctx.monthlyVolumeStore.addCents(ctx.phone, 250_000); // $2,500 this month
  const res = await executeTool('check_send_limit', { amount_usd: 600 }, ctx); // → $3,100
  expect(res.edd_required).toBe(true);
});

it('check_send_limit: edd_required:false when the customer already has EDD fields on file (sticky)', async () => {
  await ctx.customerStore.saveCustomer({
    ...(await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer,
    sourceOfFunds: 'employment', occupation: 'salaried', eddCapturedAt: '2026-05-01T00:00:00Z',
  });
  await ctx.monthlyVolumeStore.addCents(ctx.phone, 250_000);
  const res = await executeTool('check_send_limit', { amount_usd: 600 }, ctx);
  expect(res.edd_required).toBe(false); // sticky profile satisfies it
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/tools.test.ts`
Expected: FAIL — `ctx.monthlyVolumeStore` undefined / `edd_required` missing.

- [ ] **Step 3: Add `monthlyVolumeStore` to `ToolContext`**

In `src/lib/tools.ts`, add the import (after line 15) and the context field (after `dailyVolumeStore` on line 298):

```ts
import type { MonthlyVolumeStore } from './monthly-volume-store';
```
```ts
  monthlyVolumeStore: MonthlyVolumeStore;   // NEW (KYC) — cumulative-month USD-equiv cents
```

Also import the EDD helper (after line 8):

```ts
import { evaluateCap, evaluateEdd } from './tier-rules';
```

- [ ] **Step 4: Extend `checkSendLimitTool` (additive only)**

In `checkSendLimitTool` (lines 782–816), after `const evalResult = evaluateCap(...)` (line 793) and before the `kycUrl` block, add the monthly read + EDD evaluation; then add the two new keys to the returned object (lines 805–815) without altering any existing key:

```ts
  const monthUsedCents = await ctx.monthlyVolumeStore.getMonthCents(ctx.phone);   // NEW (KYC)
  const edd = evaluateEdd(monthUsedCents, requestedCents);                         // NEW (KYC)
  const eddFieldsPresent = Boolean(customer.sourceOfFunds && customer.occupation); // NEW (KYC)
```

In the `return {...}`, after `kyc_url: kycUrl,`:

```ts
    edd_required: edd.eddRequired && !eddFieldsPresent,   // false on the dormant path
    edd_threshold_usd: edd.thresholdCents / 100,          // 3000 (for messaging)
```

Update the `check_send_limit` tool **description** (line 271) to document the additive return, keeping the existing fields verbatim:

```ts
"Check whether the sender is allowed to send `amount_usd` right now. Pass 0 to fetch their current cap status without proposing an amount. Returns { within_cap, tier, daily_cap_usd, per_transfer_cap_usd, today_used_usd, today_remaining_usd, reason?, day_of_window?, kyc_url?, edd_required, edd_threshold_usd }. Always call this BEFORE get_quote.",
```

- [ ] **Step 5: Run the tools test + typecheck**

Run: `npx vitest run tests/tools.test.ts && npm run typecheck`
Expected: the three new cases PASS; typecheck FAILS only where a non-test caller builds a `ToolContext` without `monthlyVolumeStore` (the agent — fixed in Task 9). The other tool tests stay green (additive change).

- [ ] **Step 6: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(kyc): check_send_limit returns edd_required + thread monthlyVolumeStore into ToolContext"
```

---

## Task 8: EDD merge + sender screening + Travel-Rule writes + monthly accrual in `createTransfer`

**Goal:** `createTransfer` gains a `monthlyVolumeStore` parameter and optional Travel-Rule/EDD fields on `CreateTransferInput`. It screens the **sender** name, merges a `'flagged'` + `'edd_required'` result **after** `screenTransfer` (a watchlist block always wins), writes the Travel-Rule + `eddRequired` snapshot onto the `Transfer`, and `addCents` to the monthly store after save. All three callers updated to the 4-arg form.

**Files:**
- Modify: `src/lib/transfer-create.ts`, `src/lib/tools.ts`, `src/lib/cron-run.ts`
- Test: `tests/transfer-create.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/transfer-create.test.ts` (it already builds `createStore(fakeRedis())` + `createPartnerStore(redis)` and calls the 3-arg `createTransfer(store, partnerStore, input)`; add a `createMonthlyVolumeStore(redis)` and thread it as the new 3rd arg):

```ts
import { createMonthlyVolumeStore } from '@/lib/monthly-volume-store';

it('KYC dormant: a sub-$3k send produces today\'s compliance result exactly (regression)', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const mvs = createMonthlyVolumeStore(redis);
  await partnerStore.ensureDefaultPartner();
  const t = await createTransfer(store, partnerStore, mvs, {
    phone: '15551230000', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
  });
  expect(t.complianceStatus).toBe('cleared');
  expect(t.complianceReasons).toEqual([]);
  expect(t.eddRequired).toBeFalsy();
});

it('KYC: a $3k-cumulative send with missing EDD fields → flagged + edd_required (NOT blocked)', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const mvs = createMonthlyVolumeStore(redis);
  await partnerStore.ensureDefaultPartner();
  await mvs.addCents('15551230001', 250_000);  // $2,500 already this month
  const t = await createTransfer(store, partnerStore, mvs, {
    phone: '15551230001', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
  });
  expect(t.complianceStatus).toBe('flagged');
  expect(t.complianceReasons).toContain('edd_required');
  expect(t.eddRequired).toBe(true);
  expect(t.status).not.toBe('blocked'); // EDD never hard-blocks; customer not suspended
});

it('KYC: $3k send WITH EDD fields present → no EDD flag', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const mvs = createMonthlyVolumeStore(redis);
  await partnerStore.ensureDefaultPartner();
  await mvs.addCents('15551230002', 250_000);
  const t = await createTransfer(store, partnerStore, mvs, {
    phone: '15551230002', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    sourceOfFunds: 'employment', occupation: 'salaried',
  });
  expect(t.complianceReasons).not.toContain('edd_required');
});

it('KYC precedence: a watchlist hit still BLOCKS even when EDD would flag', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const mvs = createMonthlyVolumeStore(redis);
  await partnerStore.ensureDefaultPartner();
  await mvs.addCents('15551230003', 250_000);
  const t = await createTransfer(store, partnerStore, mvs, {
    phone: '15551230003', amountSource: 600, sourceCurrency: 'USD', partnerId: 'default',
    recipientName: 'John Doe',  // on WATCHLIST
    recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
  });
  expect(t.complianceStatus).toBe('blocked');
  expect(t.complianceReasons).not.toContain('edd_required');
});

it('KYC: monthlyVolumeStore.addCents called with USD-equivalent cents after save', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const mvs = createMonthlyVolumeStore(redis);
  await partnerStore.ensureDefaultPartner();
  const t = await createTransfer(store, partnerStore, mvs, {
    phone: '15551230004', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
  });
  expect(await mvs.getMonthCents('15551230004')).toBe(Math.round(t.amountUsd * 100));
});

it('KYC: Travel-Rule fields are written onto the Transfer when supplied', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const partnerStore = createPartnerStore(redis);
  const mvs = createMonthlyVolumeStore(redis);
  await partnerStore.ensureDefaultPartner();
  const t = await createTransfer(store, partnerStore, mvs, {
    phone: '15551230005', amountSource: 200, sourceCurrency: 'USD', partnerId: 'default',
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'asha@upi', fundingMethod: 'bank_transfer',
    recipientLegalName: 'Mother Legal Name', relationship: 'parent', purpose: 'family_support',
  });
  expect(t.recipientLegalName).toBe('Mother Legal Name');
  expect(t.relationship).toBe('parent');
  expect(t.purpose).toBe('family_support');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/transfer-create.test.ts`
Expected: FAIL — `createTransfer` does not take a `monthlyVolumeStore` 3rd arg, does not merge EDD, and `CreateTransferInput` has no Travel-Rule/EDD fields.

- [ ] **Step 3: Extend `CreateTransferInput` and `createTransfer` in `src/lib/transfer-create.ts`**

Add the imports (after line 4) and the optional input fields (after line 21):

```ts
import { evaluateEddForTransfer } from './tier-rules';
import type { MonthlyVolumeStore } from './monthly-volume-store';
```
```ts
import type {
  CurrencyCode, FundingMethod, PartnerId, PayoutMethod, Transfer,
  SenderRecipientRelationship, TransferPurpose, SourceOfFunds, Occupation,   // NEW (KYC)
} from './types';
```

Add to `CreateTransferInput` (after `partnerId: PartnerId;` line 21):

```ts
  // ── KYC Travel-Rule (Tier 2) + EDD (Tier 4) — all optional (dormant) ──
  recipientLegalName?: string;
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  senderName?: string;          // sender legal name for sanctions screening (from customer.fullName)
```

Add `monthlyVolumeStore` as the 3rd parameter (after `partnerStore`, line 26):

```ts
export async function createTransfer(
  store: Store,
  partnerStore: PartnerStore,
  monthlyVolumeStore: MonthlyVolumeStore,   // NEW (KYC) — cumulative-month accrual + EDD trigger
  input: CreateTransferInput,
): Promise<Transfer> {
```

Pass `senderName` into the existing `screenTransfer` call (line 37–43), add the EDD evaluation, and merge it after screening. Replace the screening block:

```ts
  const monthUsedCents = await monthlyVolumeStore.getMonthCents(input.phone);   // NEW (KYC)
  const compliance = await screenTransfer({
    amountUsd: q.amountUsd,            // USD-equivalent — UNCHANGED
    recipientName: input.recipientName,
    transfersToday,
    sourceCountry,
    rules,
    senderName: input.senderName,      // NEW (KYC) — screened via the same seam (undefined ⇒ no-op)
  });

  // EDD merge: a watchlist BLOCK always wins; EDD only ever ADDS a flag.
  const eddFieldsPresent = Boolean(input.sourceOfFunds && input.occupation);
  const eddCheck = evaluateEddForTransfer({
    monthUsedCents,
    requestedCents: Math.round(q.amountUsd * 100),
    eddFieldsPresent,
  });
  let complianceStatus = compliance.status;
  let complianceReasons = compliance.reasons;
  if (complianceStatus !== 'blocked' && eddCheck.flagReason) {
    complianceStatus = 'flagged';
    complianceReasons = [...complianceReasons, eddCheck.flagReason];
  }
```

In the `const transfer: Transfer = {...}` literal (lines 44–69), change `complianceStatus`/`complianceReasons`/`status` to use the merged locals and add the new optional fields:

```ts
    complianceStatus,
    complianceReasons,
    status: complianceStatus === 'blocked' ? 'blocked' : 'awaiting_payment',
    // ...existing P1/P2/P4 fields unchanged...
    recipientLegalName: input.recipientLegalName,   // NEW (KYC)
    relationship: input.relationship,               // NEW (KYC)
    purpose: input.purpose,                          // NEW (KYC)
    eddRequired: eddCheck.eddRequired,               // NEW (KYC)
```

After `await store.incrementTodayTransferCount(input.phone);` (line 72), accrue the monthly volume (same USD-equivalent cents the daily path uses):

```ts
  await monthlyVolumeStore.addCents(input.phone, Math.round(transfer.amountUsd * 100));   // NEW (KYC)
```

- [ ] **Step 4: Update the three `createTransfer` call sites to the 4-arg form**

Run: `npm run typecheck`
Expected: FAIL at each call site. Update:
- `src/lib/cron-run.ts:29` — add `monthlyVolumeStore` to `CronDeps` (after `partnerStore`, line 11) and pass it: `createTransfer(deps.store, deps.partnerStore, deps.monthlyVolumeStore, {...})`.
- `src/lib/tools.ts:430` (approve-tap path) and `:485` (legacy path) — pass `ctx.monthlyVolumeStore`. On the approve-tap path, source `senderName: customer.fullName` and the Travel-Rule/EDD fields from the consumed `draft`; on the legacy path source them from `args`. See Step 5 for the arg plumbing.

- [ ] **Step 5: Plumb the EDD/Travel-Rule args through the tools (sticky-profile persist)**

In `src/lib/tools.ts`, add the optional enum args to the `create_transfer`, `send_approve_picker`, and `create_schedule` tool schemas (under `properties`, NOT in `required`):

```ts
          recipient_legal_name: { type: 'string', description: 'Recipient legal name (only when enhanced verification is required).' },
          relationship: { type: 'string', enum: ['self','spouse','parent','child','sibling','other_family','friend','business','other'] },
          purpose: { type: 'string', enum: ['family_support','gift','education','medical','savings','bills','business','other'] },
          source_of_funds: { type: 'string', enum: ['employment','business','investment','gift','savings','other'] },
          occupation: { type: 'string', enum: ['salaried','self_employed','business_owner','student','homemaker','retired','unemployed','other'] },
```

Add small closed-set validators near the top of the file (treat an unknown value as unsupplied — fail-safe to flag, never silent-pass):

```ts
const SOURCE_OF_FUNDS = ['employment','business','investment','gift','savings','other'] as const;
const OCCUPATIONS = ['salaried','self_employed','business_owner','student','homemaker','retired','unemployed','other'] as const;
const RELATIONSHIPS = ['self','spouse','parent','child','sibling','other_family','friend','business','other'] as const;
const PURPOSES = ['family_support','gift','education','medical','savings','bills','business','other'] as const;
function asEnum<T extends readonly string[]>(set: T, v: unknown): T[number] | undefined {
  return typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T[number]) : undefined;
}
```

In `sendApprovePickerTool`, capture the validated enums and store them on the draft (`createDraft({... recipientLegalName, relationship, purpose, sourceOfFunds, occupation })`). In `createTransferTool` approve-tap path, pass them from the consumed `draft` plus `senderName: customer.fullName`; on the legacy path, pull from `args` via `asEnum(...)` and `senderName: legacyCustomer.fullName`. After a successful `createTransfer` on either path, **persist the EDD profile back onto the Customer (sticky)** when supplied:

```ts
  const sof = asEnum(SOURCE_OF_FUNDS, args.source_of_funds) ?? draft?.sourceOfFunds;
  const occ = asEnum(OCCUPATIONS, args.occupation) ?? draft?.occupation;
  if (sof && occ && (customer.sourceOfFunds !== sof || customer.occupation !== occ)) {
    await ctx.customerStore.saveCustomer({
      ...customer, sourceOfFunds: sof, occupation: occ, eddCapturedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
```

Add the matching `tools.test.ts` cases (in Task 7's file): "EDD enum args persist onto the Customer (sticky)"; "invalid enum value is treated as unsupplied (eddFieldsPresent stays false)"; "Travel-Rule fields flow from the draft into the Transfer". Run `npx vitest run tests/tools.test.ts` until green.

- [ ] **Step 6: Run the full transfer-create + tools suites + typecheck**

Run: `npx vitest run tests/transfer-create.test.ts tests/tools.test.ts && npm run typecheck`
Expected: PASS / typecheck FAILS only at the agent/webhook/cron deps wiring (Task 9). The dormant regression matches today.

- [ ] **Step 7: Commit**

```bash
git add src/lib/transfer-create.ts src/lib/tools.ts src/lib/cron-run.ts tests/transfer-create.test.ts tests/tools.test.ts
git commit -m "feat(kyc): createTransfer merges EDD flag + screens sender + writes Travel-Rule + accrues monthly volume"
```

---

## Task 9: Wire `monthlyVolumeStore` through the agent, webhook, and cron

**Goal:** Thread the new store from the singletons (`getMonthlyVolumeStore()`) into `AgentDeps` → `executeTool` context, and into the cron `CronDeps`, exactly mirroring how `dailyVolumeStore` / `partnerStore` are plumbed. This closes the typecheck failures from Tasks 7–8.

**Files:**
- Modify: `src/lib/agent.ts`, `src/app/api/whatsapp/route.ts`, `src/app/api/cron/route.ts`

- [ ] **Step 1: Add `monthlyVolumeStore` to `AgentDeps` and the tool context**

In `src/lib/agent.ts`: add the import (after line 8) and the dep field (after `dailyVolumeStore` line 23):

```ts
import type { MonthlyVolumeStore } from './monthly-volume-store';
```
```ts
  monthlyVolumeStore: MonthlyVolumeStore;   // NEW (KYC)
```

In the `executeTool({...})` context object (lines 119–129), after `dailyVolumeStore: deps.dailyVolumeStore,`:

```ts
            monthlyVolumeStore: deps.monthlyVolumeStore,   // NEW (KYC)
```

- [ ] **Step 2: Wire the webhook**

In `src/app/api/whatsapp/route.ts`: add the import (beside line 11) and build the store (beside line 49):

```ts
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
```
```ts
  const monthlyVolumeStore = getMonthlyVolumeStore();
```

In the `createAgent({...})` deps (lines 91–100), after `dailyVolumeStore,` (line 97):

```ts
        monthlyVolumeStore,   // NEW (KYC)
```

- [ ] **Step 3: Wire the cron route**

In `src/app/api/cron/route.ts`: add the import (beside line 4) and build the store, then pass it into `runDueSchedules`:

```ts
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
```
```ts
  const monthlyVolumeStore = getMonthlyVolumeStore();
```

In the `runDueSchedules({...})` deps (lines 42–63), after `partnerStore,` (line 44):

```ts
    monthlyVolumeStore,   // NEW (KYC): cumulative-month EDD trigger at run time
```

> Spec open question 6 resolved: EDD is evaluated at **run time** inside `createTransfer`, so each fired scheduled transfer trips the cumulative line consistently with the bot path. No setup-time EDD capture on `create_schedule`.

- [ ] **Step 4: Full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS / clean — all `ToolContext`/`CronDeps`/`AgentDeps` consumers now supply `monthlyVolumeStore`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent.ts src/app/api/whatsapp/route.ts src/app/api/cron/route.ts
git commit -m "feat(kyc): thread monthlyVolumeStore through agent, webhook, and cron deps"
```

---

## Task 10: Prompt — conditional ENHANCED VERIFICATION block

**Goal:** Add a prompt block that asks for `source_of_funds` + `occupation` **only** when `check_send_limit` returns `edd_required: true`. On the dormant path the bot asks nothing new. PII-blind and partner-blind — no field value is ever echoed; the words `corridor`/`watchlist`/`sanctions`/`partner` never appear.

**Files:**
- Modify: `src/lib/prompt.ts`
- Test: `tests/prompt.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/prompt.test.ts`:

```ts
it('includes the conditional ENHANCED VERIFICATION block gated on edd_required', () => {
  expect(SYSTEM_PROMPT).toContain('ENHANCED VERIFICATION');
  expect(SYSTEM_PROMPT).toContain('edd_required');
  expect(SYSTEM_PROMPT).toContain('source_of_funds');
  expect(SYSTEM_PROMPT).toContain('occupation');
});

it('instructs the bot to ask NOTHING extra when edd_required is false (dormancy)', () => {
  expect(SYSTEM_PROMPT).toMatch(/edd_required is false/i);
  expect(SYSTEM_PROMPT.toLowerCase()).toContain('never ask');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/prompt.test.ts`
Expected: FAIL — the block is not present yet.

- [ ] **Step 3: Add the block to `src/lib/prompt.ts`**

Append before the final closing backtick (after the CURRENCY block, line 103). Keep it PII/partner/corridor-blind:

```
ENHANCED VERIFICATION
- If — and ONLY if — check_send_limit returns edd_required: true, then BEFORE
  send_approve_picker collect TWO additional details:
    • source of funds (employment, business, investment, gift, savings, other)
    • occupation (salaried, self-employed, business owner, student, homemaker,
      retired, unemployed, other)
  Pass them as source_of_funds and occupation. Explain briefly: "For transfers
  totaling $3,000 or more this month we're required to ask a couple of quick
  questions." Map the user's wording to the closest option; never store or
  repeat back the values. If edd_required is false, NEVER ask these.
```

- [ ] **Step 4: Run prompt + bot-content-guard tests**

Run: `npx vitest run tests/prompt.test.ts tests/bot-content-guard.test.ts`
Expected: prompt cases PASS; bot-content-guard still PASS (the block has no `content:` literal and no forbidden term — verified explicitly in Task 11). If guard reds, the block leaked a forbidden term — fix the wording, do not weaken the guard.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add src/lib/prompt.ts tests/prompt.test.ts
git commit -m "feat(kyc): conditional ENHANCED VERIFICATION prompt block (asks nothing unless edd_required)"
```

---

## Task 11: Bot-content-guard — no PII value or EDD internal term leaks to bot content

**Goal:** Extend `bot-content-guard.test.ts` so the bot stays PII-blind: no stored PII value and no internal term appears in any chat-message `content` literal across `prompt.ts`/`agent.ts`/`tools.ts`. `source_of_funds`/`occupation` may appear only as the *question* in the prompt, never as a stored value; `partner`/`corridor`/`watchlist`/`sanctions` stay absent (the P2/P4/P5 guards remain green).

**Files:**
- Modify: `tests/bot-content-guard.test.ts`

- [ ] **Step 1: Add the KYC guard assertions**

Append a describe block (the file already scans `content:` literals and the P5 forbidden set on lines 41–64):

```ts
describe('KYC guards: bot never leaks PII values or EDD internals to chat content', () => {
  const filesToScan = ['src/lib/prompt.ts', 'src/lib/agent.ts', 'src/lib/tools.ts'];
  // Stored-PII / internal terms that must never appear inside a chat content literal.
  const forbidden = ['govidnumber', 'gov_id', 'residentialaddress', 'pepdeclared', 'eddcapturedat'];

  for (const rel of filesToScan) {
    it(`${rel} has no chat content leaking a PII value or EDD internal`, () => {
      const contents = readFileSync(resolve(process.cwd(), rel), 'utf-8');
      const matches = [...contents.matchAll(/content:\s*['"`]([^'"`]*?)['"`]/g)];
      for (const m of matches) {
        const text = m[1].toLowerCase();
        for (const term of forbidden) expect(text).not.toContain(term);
      }
    });
  }

  it('the prompt mentions source of funds / occupation only as a question, not a stored field name', () => {
    const prompt = readFileSync(resolve(process.cwd(), 'src/lib/prompt.ts'), 'utf-8');
    // The instruction must be present (Task 10) but must not echo a stored value back.
    expect(prompt).toContain('source of funds');
    expect(prompt.toLowerCase()).not.toContain('your source of funds is');
  });
});
```

- [ ] **Step 2: Run it to verify green**

Run: `npx vitest run tests/bot-content-guard.test.ts`
Expected: PASS — this batch touched the prompt only with a PII-blind question block and added no `content:` literal carrying PII or an internal term.

- [ ] **Step 3: Commit**

```bash
git add tests/bot-content-guard.test.ts
git commit -m "feat(kyc): bot-content-guard extended — no PII value or EDD internal leaks to bot"
```

---

## Task 12: Dashboard — scope-aware Core-ID/PEP/EDD display + flagged-EDD label

**Goal:** Render the captured Core-ID + Tier-3 + EDD fields on the scoped customer detail page (`govIdNumber` masked to last-4), and surface the `'edd_required'` flag reason with a distinct label on the compliance page's flagged tab. Read-only; no server action; scope-aware via the existing `requireScope()` + `createScopedStore(staff)` already on both pages.

**Files:**
- Modify: `src/app/dashboard/customers/[phone]/page.tsx`, `src/app/dashboard/compliance/page.tsx`

- [ ] **Step 1: Add the Core-ID / PEP / EDD rows to the customer detail page**

In `src/app/dashboard/customers/[phone]/page.tsx`, add the import (after line 7):

```ts
import { maskLast4 } from '@/lib/mask';
```

In the Identity & KYC `<dl>` (lines 59–73), after `<dt>DOB</dt><dd>{customer.dateOfBirth ?? '—'}</dd>` (line 66), add the new rows (lazy-fill leaves `undefined` → `'—'`; `govIdNumber` masked):

```tsx
              <dt>Nationality</dt><dd>{customer.nationality ?? '—'}</dd>
              <dt>Address</dt><dd>{customer.residentialAddress ?? '—'}</dd>
              <dt>Gov ID</dt><dd>{customer.govIdType ? `${customer.govIdType} ••••${maskLast4(customer.govIdNumber)}` : '—'}</dd>
              <dt>PEP</dt><dd>{customer.pepDeclared ? 'Self-declared' : 'No'}</dd>
              <dt>Source of funds</dt><dd>{customer.sourceOfFunds ?? '—'}</dd>
              <dt>Occupation</dt><dd>{customer.occupation ?? '—'}</dd>
```

> Scope-awareness is automatic: the page reads `customer` via `createScopedStore(staff)` (line 20–22), which already restricts a sub-admin to their partner's customers, so PII visibility is platform-admin + owning-partner-staff only. The customer **list** page (`customers/page.tsx`) is untouched — PII detail lives only on the scoped `[phone]` page. No new server action is added; if a staff Core-ID/EDD edit form is later added it must clear the full server-action security checklist (spec open question 5, deferred).

- [ ] **Step 2: Add a distinct "EDD required" label on the compliance flagged tab**

In `src/app/dashboard/compliance/page.tsx`, the flagged table already renders `t.complianceReasons.join(', ')` via `TransferRow` (line 31). Change the `<td>` that renders reasons so an `edd_required` reason shows a distinct pill instead of the raw token. Update `TransferRow`'s reasons cell:

```tsx
      <td>
        {t.complianceReasons.length === 0 ? '—' : t.complianceReasons.map((r) =>
          r === 'edd_required'
            ? <span key={r} className="sh-pill sh-pill-warn"><span className="sh-pill-dot"></span>EDD required</span>
            : <span key={r} style={{ marginRight: 6 }}>{r}</span>,
        )}
      </td>
```

> `'edd_required'` rides the existing `complianceReasons` array (no schema change), so it already surfaces in the flagged tab; this only relabels it so staff can distinguish it from large-amount/velocity flags. If `sh-pill-warn` does not exist in `globals.css`, reuse an existing pill class (e.g. `sh-pill-danger`) rather than adding CSS — keep the diff to the page.

- [ ] **Step 3: Verify build + lint**

Run: `npm run build && npm run lint`
Expected: clean. UI pages are not unit-tested (project convention); the build is the gate, and `maskLast4` is covered by `tests/mask.test.ts` (Task 6).

- [ ] **Step 4: Commit**

```bash
git add "src/app/dashboard/customers/[phone]/page.tsx" src/app/dashboard/compliance/page.tsx
git commit -m "feat(kyc): scope-aware Core-ID/PEP/EDD display (govIdNumber masked) + flagged-EDD label"
```

---

## Task 13: Wrap — full verification, PR, post-merge runbook

**Files:** none (verification + git).

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all clean; the full suite green (~496 tests). The pre-batch ~453 staying green is the dormancy proof.

- [ ] **Step 2: Confirm the dormancy invariant by hand**

With no monthly volume accrued and no new fields supplied:
- `evaluateEdd(0, smallCents)` → `eddRequired: false` (Task 4 tests).
- `check_send_limit({ amount_usd: 200 })` returns today's fields plus `edd_required: false` (Task 7).
- `screenTransfer({...})` with no `senderName` reproduces today's recipient-only `blocked`/`flagged`/`cleared` (Task 5).
- A sub-$3k `createTransfer` produces today's `complianceStatus`/`complianceReasons` and `eddRequired` falsy (Task 8 regression).
- The bot prompt asks nothing new (Task 10) and leaks no PII/internal term (Task 11).
- `MonthlyVolumeStore` is a fresh namespace — a never-written key reads `0`; no migration runs (no backfill added this batch).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin spec/kyc-tiered-capture
gh pr create --title "feat(kyc): tiered KYC/Travel-Rule/EDD data capture (dormant, provider-deferred)" --body "$(cat <<'EOF'
## Summary
- Captures Western-Union's four-tier KYC/AML data model — Core-ID (CIP), Travel-Rule counterparty, sender+recipient risk/PEP screening, and EDD at the $3,000 CUMULATIVE rolling-month threshold — as structured, screenable, scope-aware data. Shipped fully DORMANT: a send whose rolling-month USD-equivalent volume + the requested amount stays under $3,000 is processed byte-for-byte as today.
- New `MonthlyVolumeStore` (mirror of the daily store; `monthly_volume:` namespace, USD-equivalent cents, ET-month keyed) drives the cumulative trigger — catching structuring across many small sends.
- Pure `evaluateEdd`/`evaluateEddForTransfer` in `tier-rules.ts` (orthogonal to the cap tier; `evaluateCap` unchanged). EDD-miss FLAGS (`complianceStatus 'flagged'`, reason `'edd_required'`) — never blocks, never auto-suspends the customer.
- `check_send_limit` returns an additive `edd_required` flag (false on the dormant path); the agent collects `source_of_funds`/`occupation` ONLY when it is true (sticky once captured).
- `screenTransfer` screens SENDER + recipient via the reused P5 `SanctionsScreener` seam — no real provider built.
- Scope-aware dashboard: Core-ID/PEP/EDD fields on the scoped customer page (`govIdNumber` masked to last-4); `'edd_required'` relabeled on the compliance flagged tab.

## Test plan
- [ ] typecheck / lint / vitest / build all green (~496 tests)
- [ ] Pre-batch ~453 suite unchanged (dormancy proof): sub-$3k compliance result + check_send_limit shape byte-for-byte today
- [ ] New: `monthly-volume-store`, `evaluateEdd`/`evaluateEddForTransfer`, sender-screening `screenTransfer`, `edd_required` tool gate, EDD merge + precedence in `createTransfer`, `maskLast4`
- [ ] `bot-content-guard` extended — no PII value or EDD internal leaks to bot content

## Out of scope (deferred)
- Real Persona integration (KycProvider/MockKycProvider seam stays untouched) and real sanctions provider (rides MockSanctionsScreener)
- Source-of-funds DOCUMENT upload (enum + optional note only); the P5 admin rule-creation UI; auto-blocking on flagged EDD
- App-level field encryption of PII (Upstash at-rest layer for the prototype; flagged as the gap to close pre-launch)
- Full-send Travel-Rule capture / trailing-30-day window / per-corridor EDD thresholds (fast-follows; `kycCapHintUsd` is the documented per-corridor override hook)
EOF
)"
```

- [ ] **Step 4: Confirm `ci / ci` is green on the PR**

Run: `gh pr checks <pr-number>`
Expected: `ci` passes. (GitGuardian may red on the known env-var-name false positive.)

- [ ] **Step 5: Post-merge runbook**

After merge → Vercel auto-deploys → Playwright smoke runs against prod. **No migration runs** — `MonthlyVolumeStore` is a fresh `monthly_volume:` namespace with no read-path write, and no new backfill was added. EDD stays dormant until a customer's real rolling-month USD-equivalent volume + a requested send crosses $3,000, at which point `check_send_limit` returns `edd_required: true` and the bot collects SoF/occupation. Flagged-EDD transfers appear on `/dashboard/compliance` for staff triage; they never auto-block the customer. Enabling a real KYC/sanctions provider later is a single `getSanctionsScreener` / `KycProvider` factory swap — no call-site change.

---

## Self-Review (completed by plan author)

**Spec coverage (tasks → spec sections):**
- §Component 1 (Core-ID `Customer` fields + `GovIdType`/`SourceOfFunds`/`Occupation`, Tier-3 `pepDeclared`, EDD profile, no `fullName`/`dateOfBirth`/`country` duplication) → **Task 1**.
- §Component 2 (Travel-Rule `Transfer` fields + `SenderRecipientRelationship`/`TransferPurpose`, `eddRequired`, `Draft` extension, `complianceReasons` unchanged) → **Task 1** (+ written in **Task 8**).
- §Component 3 (`MonthlyVolumeStore` mirror, `monthly_volume:` namespace, USD-equivalent cents, no migration) → **Task 3** (+ `easternMonth` in **Task 2**).
- §Component 4 (`EDD_THRESHOLD_CENTS`, `evaluateEdd`, `evaluateEddForTransfer`, `>=` inclusive, flag-only, `evaluateCap` unchanged) → **Task 4**.
- §Component 5 (`check_send_limit` additive `edd_required`/`edd_threshold_usd`; `ToolContext.monthlyVolumeStore`; optional Travel-Rule/EDD args → Draft → `CreateTransferInput`; sticky Customer persist; prompt block) → **Tasks 7, 8, 9, 10**.
- §Component 6 (sender + recipient screening via the P5 seam; optional `senderName` defaults to recipient-only) → **Task 5**.
- §Component 7 (EDD-flag surfacing on `/dashboard/compliance`, distinct label, read-only, scope-aware) → **Task 12**.
- §Component 8 (Core-ID/PEP/EDD on the scoped `[phone]` page, `govIdNumber` masked, list page untouched, no server action) → **Task 12** (+ `maskLast4` in **Task 6**).
- §Security notes (new PII in Redis with app-level encryption flagged out-of-scope; scope-aware render; bot PII/partner-blind; server-side enforcement; defensive untrusted input; enums-not-free-text) → **Tasks 6, 8, 11, 12** + the masking helper + the closed-set `asEnum` validators.
- §Dormancy invariant → proven as pure units early (Task 4 `edd_required:false`; Task 3 fresh-key `0`), at the tool layer (Task 7 regression), at the screen layer (Task 5 no-`senderName`), at the create layer (Task 8 regression), and whole-suite-green (Task 13).
- §Testing strategy → every task's TDD steps + new `monthly-volume-store.test.ts` / `mask.test.ts` and extensions to tier-rules/compliance/tools/transfer-create/bot-content-guard/prompt; projected +~43 → ~496 from the measured 453.
- §Open questions resolved: (1) sender reason-string reuses the existing watchlist string for dormancy, distinct string flagged as fast-follow — Task 5; (2) Travel-Rule fields collected on the EDD path only (preserve dormancy) — Tasks 8/10; (3) calendar-month window via `easternMonth` (mirrors the daily store) — Task 2/3; (4) global $3k `EDD_THRESHOLD_CENTS`, `kycCapHintUsd` left as the documented per-corridor override hook — Task 4; (5) staff PII-edit form deferred (no new mutating server action) — Tasks 8/12; (6) EDD evaluated at run time in `createTransfer`, not at `create_schedule` setup — Task 9.

**Placeholder scan:** No TBD/TODO. Every code step shows real, copy-pasteable code citing real symbols verified in this session — `easternDate`/`ET` (`dates.ts`), `createDailyVolumeStore`/`RedisLike`/`automaticDeserialization:false` (`daily-volume-store.ts`), `deriveTier`/`evaluateCap`/`T1_DAILY_CAP_CENTS` (`tier-rules.ts`), `screenTransfer` with `rules`/`screener`/`sourceCountry`/`GLOBAL_DEFAULTS` (`compliance.ts`), `MockSanctionsScreener` (`sanctions-provider.ts`), `createTransfer(store, partnerStore, input)` and its three call sites (`transfer-create.ts:24`, `cron-run.ts:29`, `tools.ts:430/485`), `ToolContext.dailyVolumeStore` (`tools.ts:298`), `checkSendLimitTool` return shape (`tools.ts:805–815`), `AgentDeps`/`executeTool` context (`agent.ts:23,125`), webhook `getDailyVolumeStore()`+`createAgent` (`route.ts:49,91–100`), cron `runDueSchedules` deps (`cron/route.ts:42–63`), `createScopedStore`/`requireScope` + the Identity & KYC `<dl>` (`customers/[phone]/page.tsx:20,59–73`), and `TransferRow` reasons cell (`compliance/page.tsx:31`). The deliberate typecheck reds (Tasks 7/8) are called out as the proof that the only `ToolContext`/`createTransfer` consumers are the agent/webhook/cron, closed in Task 9.

**Type consistency:** `GovIdType`/`SourceOfFunds`/`Occupation`/`SenderRecipientRelationship`/`TransferPurpose` unions; `Customer { residentialAddress?, govIdType?, govIdNumber?, nationality?: CountryCode, pepDeclared?, sourceOfFunds?, occupation?, eddCapturedAt? }`; `Transfer { recipientLegalName?, relationship?, purpose?, eddRequired? }`; `Draft { recipientLegalName?, relationship?, purpose?, sourceOfFunds?, occupation? }`; `easternMonth(epochMs: number): string`; `MonthlyVolumeStore = { getMonthCents(phone): Promise<number>; addCents(phone, cents): Promise<void> }`; `EDD_THRESHOLD_CENTS = 300_000`; `EddEvaluation { eddRequired, monthUsedCents, requestedCents, thresholdCents }`; `evaluateEdd(monthUsedCents, requestedCents): EddEvaluation`; `evaluateEddForTransfer({ monthUsedCents, requestedCents, eddFieldsPresent }): { eddRequired; flagReason?: 'edd_required' }`; `screenTransfer({ …, senderName? }): Promise<ComplianceResult>`; `createTransfer(store, partnerStore, monthlyVolumeStore, input)`; `CreateTransferInput { …, recipientLegalName?, relationship?, purpose?, sourceOfFunds?, occupation?, senderName? }`; `ToolContext.monthlyVolumeStore`, `AgentDeps.monthlyVolumeStore`, `CronDeps.monthlyVolumeStore`; `maskLast4(value: string | undefined): string`. Names used identically across Tasks 1–13 and matching the spec's Architecture/Components blocks. No `as any`; `??` (never `||`) for the merge and coercion fallbacks; `?? ''`/`trim` on PII strings; `Number(...) || 0` on volume cents; enums validated against closed sets. ✓
