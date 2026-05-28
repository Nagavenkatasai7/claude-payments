# P3: Per-partner Sub-Admin Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let partner-scoped staff log in to the dashboard and see only their own partner's customers/transfers/schedules/partner record, while existing platform admins keep seeing everything. Zero customer-facing change — the WhatsApp bot is untouched.

**Architecture:** Introduce a `createScopedStore(staff)` facade that wraps the existing Redis stores and auto-filters list/get methods by `staff.partnerId`. Every dashboard page swaps `getStore()`/`getCustomerStore()`/`getPartnerStore()`/`getScheduleStore()` calls for the scoped facade. Add `Schedule.partnerId` (required) with a sentinel-guarded backfill following the P1/P2 pattern. Suspended-partner enforcement happens at three points: login refusal, mid-session bounce in `getCurrentStaff()`, and proactive session revocation when an admin flips a partner to `suspended`.

**Tech Stack:** Next.js 16 App Router · TypeScript · Vitest · Playwright · Upstash Redis · existing `auth-store`, `partner-store`, `schedule-store`, `customer-store`, `store` modules.

**Spec reference:** [docs/superpowers/specs/2026-05-27-partner-sub-admin-auth-design.md](../specs/2026-05-27-partner-sub-admin-auth-design.md) — committed at `ed335ad` on branch `spec/p3-partner-sub-admin`. Read it once before starting; tasks below assume you've seen the spec's role × scope matrix and migration shape.

**Branch:** Continue on `spec/p3-partner-sub-admin`. The PR title will be `feat(P3): per-partner sub-admin auth + dashboard scoping`. Do **not** cut a new branch — the spec commit is already there.

**Test count delta:** Suite starts at 354 (post-PR #9), ends at ~385 (+31 tests). Verify the final count with `npx vitest run` after Task 15.

**Patterns to reuse (from PRs #5–#9):**
- Sentinel-guarded migration via `store.claimMigrationFlag('schedule-partner-backfill-v1')` + lazy-fill on read (never persist from read paths).
- Server-action surface for any client→Redis path; pages stay server components.
- TDD per task: failing test first → minimal implementation → green → commit.
- Defensive `(x ?? '').localeCompare(y ?? '')` on every new sort comparator that touches Redis-resident records.
- `fakeRedis()` factory (`tests/helpers.ts`) for unit tests — never hit real Upstash from tests.

**CI/CD reminders:**
- Branch protection on `main` requires the `ci / ci` status check (typecheck + lint + vitest + `next build`). Don't push directly.
- Vercel auto-deploys on merge; `Smoke` workflow fires on `deployment_status: success`.
- The user added new E2E env vars (`E2E_PARTNER_USERNAME`, `E2E_PARTNER_PASSWORD`, `E2E_PARTNER_ID`) on Vercel before the PR merges — Task 15's smoke case runs hard, no graceful skip.
- Post-merge: curl `/api/cron?secret=<CRON_SECRET>` once so `backfillSchedulesOnce` claims its sentinel and persists `Schedule.partnerId` on legacy records.

---

## File map (lock in before starting)

**New files (5):**
- `src/lib/staff-scope.ts` — pure helpers (`Scope`, `scopeOf`, `canSee`). ~25 LOC.
- `src/lib/scoped-store.ts` — the `createScopedStore(staff)` facade. ~95 LOC.
- `tests/staff-scope.test.ts` — pure-helper unit tests.
- `tests/scoped-store.test.ts` — scoping contract tests.
- `tests/auth-suspended-partner.test.ts` — login + mid-session bounce.
- `tests/sidebar.test.ts` — `visibleNavItems` table.
- `tests/schedule-store-partnerId.test.ts` — lazy-fill of legacy schedules.
- `tests/partner-staff-actions.test.ts` — partner-staff CRUD actions.
- `tests/login-suspended-partner.test.ts` — login action rejects suspended partner.

(File count above is informational — the canonical "new files" list is the five `.ts` source files and the test files seeded throughout the tasks below.)

**Modified files (15):**
- `src/lib/types.ts` — add `partnerId: PartnerId` (required) to `Schedule`.
- `src/lib/auth.ts` — add `requirePlatformAdmin()`, `requireScope()`; modify `getCurrentStaff()` to bounce suspended-partner sessions.
- `src/lib/auth-store.ts` — reverse-index sessions for revocation; new `deleteAllSessionsFor()`.
- `src/lib/schedule-store.ts` — lazy-fill `partnerId` from the owning customer on read.
- `src/lib/tools.ts` — `createScheduleTool` writes `partnerId` from customer at creation.
- `src/lib/migration.ts` — new `backfillSchedulesOnce()` sentinel-guarded.
- `src/lib/seed.ts` — optional partner-staff seed (gated by env vars).
- `src/lib/env.ts` — new optional env getters for the partner-staff seed.
- `src/app/api/cron/route.ts` — invoke `backfillSchedulesOnce` alongside the other three.
- `src/app/login/actions.ts` — reject login when staff's partner is `suspended`.
- `src/app/dashboard/sidebar.tsx` — drive nav from `visibleNavItems(staff)`.
- `src/app/dashboard/team/page.tsx` — gate with `requirePlatformAdmin`; show platform staff only.
- `src/app/dashboard/partners/page.tsx` — partner-scoped users redirected to their own detail page.
- `src/app/dashboard/partners/[id]/page.tsx` — third panel: "Staff for this partner."
- `src/app/dashboard/partners/actions.ts` — `createPartnerStaffAction`, `removeStaffAction`; `setPartnerStatusAction` proactively revokes affected sessions.
- All 9 dashboard pages — swap raw stores for `createScopedStore(staff)`; hide Partner column/filter for scoped users.
- `tests/e2e/dashboard-smoke.spec.ts` — second test for partner-scoped login.
- `tests/auth-store.test.ts` — extend with session reverse-index assertions.
- `tests/migration.test.ts` — extend with `backfillSchedulesOnce` cases.
- `tests/partners-actions.test.ts` — extend with session-revocation assertion.
- `tests/schedule.test.ts`, `tests/tools.test.ts`, `tests/cron-run.test.ts` — fix any fixtures that construct a `Schedule` without `partnerId`.
- `.env.example` — document new optional env vars.

Each task below specifies its files, the test code, the implementation code, and the commit.

---

## Task 1: Pure scope helpers (`staff-scope.ts`)

**Files:**
- Create: `src/lib/staff-scope.ts`
- Test: `tests/staff-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/staff-scope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scopeOf, canSee } from '@/lib/staff-scope';
import type { Staff } from '@/lib/types';

function staff(partnerId?: string): Staff {
  return {
    username: 'u',
    name: 'U',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt: '2026-05-27T00:00:00Z',
    partnerId,
  };
}

describe('scopeOf', () => {
  it('returns platform scope when staff has no partnerId', () => {
    expect(scopeOf(staff(undefined))).toEqual({ kind: 'platform' });
  });

  it('returns partner scope when staff has a partnerId', () => {
    expect(scopeOf(staff('acme'))).toEqual({ kind: 'partner', partnerId: 'acme' });
  });
});

describe('canSee', () => {
  it('platform scope sees any partnerId', () => {
    expect(canSee({ kind: 'platform' }, 'any')).toBe(true);
    expect(canSee({ kind: 'platform' }, 'default')).toBe(true);
  });

  it('partner scope sees only its own partnerId', () => {
    const scope = { kind: 'partner' as const, partnerId: 'acme' };
    expect(canSee(scope, 'acme')).toBe(true);
    expect(canSee(scope, 'other')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/staff-scope.test.ts`
Expected: FAIL with `Cannot find module '@/lib/staff-scope'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/staff-scope.ts`:

```ts
import type { PartnerId, Staff } from './types';

export type Scope =
  | { kind: 'platform' }
  | { kind: 'partner'; partnerId: PartnerId };

export function scopeOf(staff: Staff): Scope {
  return staff.partnerId
    ? { kind: 'partner', partnerId: staff.partnerId }
    : { kind: 'platform' };
}

export function canSee(scope: Scope, partnerId: PartnerId): boolean {
  return scope.kind === 'platform' || scope.partnerId === partnerId;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/staff-scope.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/staff-scope.ts tests/staff-scope.test.ts
git commit -m "feat(P3): scope helpers (scopeOf + canSee)"
```

---

## Task 2: Session reverse-index in `auth-store`

**Goal:** Make sessions revocable per-user. Current `createSession`/`deleteSession` only key by token; add a `staff_sessions:<username>` Redis set + `deleteAllSessionsFor(username)`.

**Files:**
- Modify: `src/lib/auth-store.ts`
- Modify: `tests/auth-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/auth-store.test.ts`:

```ts
describe('auth-store session reverse-index', () => {
  it('tracks tokens per user and lets deleteAllSessionsFor revoke them', async () => {
    const s = createAuthStore(fakeRedis());
    const t1 = await s.createSession('priya');
    const t2 = await s.createSession('priya');
    const tOther = await s.createSession('admin');

    await s.deleteAllSessionsFor('priya');

    expect(await s.getSessionUser(t1)).toBeNull();
    expect(await s.getSessionUser(t2)).toBeNull();
    expect(await s.getSessionUser(tOther)).toBe('admin');
  });

  it('deleteSession also removes the token from the reverse-index set', async () => {
    const s = createAuthStore(fakeRedis());
    const t = await s.createSession('priya');
    await s.deleteSession(t);
    // Subsequent deleteAllSessionsFor must be a no-op (no orphan keys).
    await s.deleteAllSessionsFor('priya');
    expect(await s.getSessionUser(t)).toBeNull();
  });

  it('deleteAllSessionsFor on an unknown user is a no-op', async () => {
    const s = createAuthStore(fakeRedis());
    await expect(s.deleteAllSessionsFor('nobody')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/auth-store.test.ts`
Expected: FAIL — `s.deleteAllSessionsFor is not a function`.

- [ ] **Step 3: Modify `src/lib/auth-store.ts`**

Replace the body of `createAuthStore` with:

```ts
export function createAuthStore(redis: RedisLike) {
  return {
    async getStaff(username: string): Promise<Staff | null> {
      const raw = await redis.get(`staff:${username}`);
      return raw ? (JSON.parse(raw) as Staff) : null;
    },
    async saveStaff(staff: Staff): Promise<void> {
      await redis.set(`staff:${staff.username}`, JSON.stringify(staff));
      await redis.sadd('staff:index', staff.username);
    },
    async listStaff(): Promise<Staff[]> {
      const usernames = await redis.smembers('staff:index');
      const all = await Promise.all(
        usernames.map((u) => this.getStaff(u)),
      );
      return all
        .filter((s): s is Staff => s !== null)
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    },
    async deleteStaff(username: string): Promise<void> {
      await redis.del(`staff:${username}`);
      await redis.srem('staff:index', username);
    },
    async createSession(username: string): Promise<string> {
      const token = randomBytes(32).toString('hex');
      await redis.set(`session:${token}`, username, {
        ex: SESSION_TTL_SECONDS,
      });
      await redis.sadd(`staff_sessions:${username}`, token);
      return token;
    },
    async getSessionUser(token: string): Promise<string | null> {
      return redis.get(`session:${token}`);
    },
    async deleteSession(token: string): Promise<void> {
      const username = await redis.get(`session:${token}`);
      await redis.del(`session:${token}`);
      if (username) await redis.srem(`staff_sessions:${username}`, token);
    },
    async deleteAllSessionsFor(username: string): Promise<void> {
      const tokens = await redis.smembers(`staff_sessions:${username}`);
      for (const t of tokens) await redis.del(`session:${t}`);
      await redis.del(`staff_sessions:${username}`);
    },
  };
}
```

Note the defensive `?? ''` on the `createdAt` sort (mirrors the established post-PR-#9 pattern).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/auth-store.test.ts`
Expected: PASS — all existing tests still green + 3 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth-store.ts tests/auth-store.test.ts
git commit -m "feat(P3): session reverse-index + deleteAllSessionsFor"
```

---

## Task 3: `Schedule.partnerId` type field + lazy-fill on read

**Goal:** Make `partnerId` a required field on `Schedule`. Old records lazy-fill from the owning customer on read; new records are written with it.

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/schedule-store.ts`
- Modify: `tests/schedule-store.test.ts` (fix existing fixture)
- Create: `tests/schedule-store-partnerId.test.ts` (new lazy-fill spec)

- [ ] **Step 1: Write the new failing tests**

Create `tests/schedule-store-partnerId.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

describe('schedule-store lazy-fill partnerId', () => {
  it('reads partnerId from the owning customer when missing on the raw record', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await customerStore.saveCustomer({
      senderPhone: '15551112222',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    // Legacy raw schedule (no partnerId on disk).
    await redis.set('schedule:LEG1', JSON.stringify({
      id: 'LEG1',
      phone: '15551112222',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'LEG1');

    const s = createScheduleStore(redis, customerStore);
    const got = await s.getSchedule('LEG1');
    expect(got?.partnerId).toBe('acme');

    // Read must NOT have persisted the lazy-fill (Redis raw still missing).
    const raw = JSON.parse((await redis.get('schedule:LEG1'))!);
    expect(raw.partnerId).toBeUndefined();
  });

  it('falls back to DEFAULT_PARTNER_ID when the owning customer cannot be found', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await redis.set('schedule:LEG2', JSON.stringify({
      id: 'LEG2',
      phone: '15559999999',
      amountUsd: 100,
      recipientName: 'X',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'x@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'LEG2');

    const s = createScheduleStore(redis, customerStore);
    const got = await s.getSchedule('LEG2');
    expect(got?.partnerId).toBe('default');
  });

  it('listSchedules returns lazy-filled partnerId for every schedule', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await customerStore.saveCustomer({
      senderPhone: '15553334444',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'beta',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await redis.set('schedule:LEG3', JSON.stringify({
      id: 'LEG3',
      phone: '15553334444',
      amountUsd: 50,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'LEG3');

    const s = createScheduleStore(redis, customerStore);
    const all = await s.listSchedules();
    expect(all).toHaveLength(1);
    expect(all[0].partnerId).toBe('beta');
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run tests/schedule-store-partnerId.test.ts`
Expected: FAIL — `createScheduleStore` takes 1 arg, not 2; lazy-fill not implemented.

- [ ] **Step 3: Update the `Schedule` type**

In `src/lib/types.ts`, add `partnerId` to `Schedule` (required):

```ts
export interface Schedule {
  id: string;
  phone: string;
  amountUsd: number;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  frequency: ScheduleFrequency;
  dayOfMonth?: number;
  dayOfWeek?: number;
  status: ScheduleStatus;
  createdAt: string;
  lastRunAt?: string;
  partnerId: PartnerId;   // NEW (P3) — required; multi-tenant boundary
}
```

(`PartnerId` is already exported from `types.ts`.)

- [ ] **Step 4: Add lazy-fill in `schedule-store.ts`**

Rewrite `src/lib/schedule-store.ts`:

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike, Store } from './store';
import type { CustomerStore } from './customer-store';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { Schedule } from './types';

export function createScheduleStore(
  redis: RedisLike,
  customerStore: CustomerStore,
) {
  return {
    async getSchedule(id: string): Promise<Schedule | null> {
      const raw = await redis.get(`schedule:${id}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Schedule;
      if (!parsed.partnerId) {
        // Lazy fill from the owning customer (in-memory only — never persist
        // here; the cron pass is the only writer for backfilled records).
        const c = await customerStore.getCustomer(parsed.phone);
        parsed.partnerId = c?.partnerId ?? DEFAULT_PARTNER_ID;
      }
      return parsed;
    },
    async saveSchedule(schedule: Schedule): Promise<void> {
      await redis.set(`schedule:${schedule.id}`, JSON.stringify(schedule));
      await redis.sadd('schedules:ids', schedule.id);
    },
    async listSchedules(): Promise<Schedule[]> {
      const ids = await redis.smembers('schedules:ids');
      const all = await Promise.all(ids.map((id) => this.getSchedule(id)));
      return all
        .filter((s): s is Schedule => s !== null)
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    },
    async listActiveSchedules(): Promise<Schedule[]> {
      return (await this.listSchedules()).filter((s) => s.status === 'active');
    },
  };
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;

let cached: ScheduleStore | null = null;

export function getScheduleStore(): ScheduleStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    const store: Store = getStore();
    const customerStore = getCustomerStore(store);
    cached = createScheduleStore(redis as unknown as RedisLike, customerStore);
  }
  return cached;
}
```

Note the `(b.createdAt ?? '').localeCompare(...)` defensive guard — mirrors the post-PR-#9 hotfix pattern.

- [ ] **Step 5: Update the existing `tests/schedule-store.test.ts` fixture**

Replace the `schedule(...)` helper at the top of `tests/schedule-store.test.ts` so every existing test still compiles:

```ts
function schedule(id: string, status: Schedule['status'] = 'active'): Schedule {
  return {
    id, phone: '15551234567', amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 2, status,
    createdAt: '2026-05-21T00:00:00.000Z',
    partnerId: 'default',
  };
}
```

Then update every `createScheduleStore(fakeRedis())` call in that file to pass a customer store:

```ts
// Replace:
const s = createScheduleStore(fakeRedis());
// With:
const redis = fakeRedis();
const store = createStore(redis);
const cs = createCustomerStore(redis, store);
const s = createScheduleStore(redis, cs);
```

Add the imports at the top of `tests/schedule-store.test.ts`:

```ts
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
```

- [ ] **Step 6: Fix the broken call sites in production code that construct `createScheduleStore` directly**

`src/lib/schedule-store.ts` `getScheduleStore()` already does the wiring (Step 4). Search for any other call sites:

Run: `grep -rn 'createScheduleStore(' src tests`
Expected: only `tests/schedule-store.test.ts`, `tests/schedule-store-partnerId.test.ts`, and `src/lib/schedule-store.ts` itself.

If a test elsewhere calls the old single-arg form, update it the same way.

- [ ] **Step 7: Update other test fixtures that construct a `Schedule` literal**

Run: `grep -rn 'frequency:' tests | grep -v node_modules`
Expected: at least `tests/schedule.test.ts`, `tests/tools.test.ts`, `tests/cron-run.test.ts`, `tests/dashboard.test.ts`, and possibly others.

For each, add `partnerId: 'default'` to the literal so it satisfies the now-required field. Example for `tests/cron-run.test.ts`:

```ts
const s: Schedule = {
  id: 'SCH1',
  phone: '15551234567',
  amountUsd: 100,
  recipientName: 'Mom',
  recipientPhone: '919876543210',
  payoutMethod: 'upi',
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer',
  frequency: 'monthly',
  dayOfMonth: 1,
  status: 'active',
  createdAt: '2026-05-01T00:00:00.000Z',
  partnerId: 'default',   // NEW
};
```

- [ ] **Step 8: Run the full suite to verify the type change is wired everywhere**

Run: `npx vitest run`
Expected: PASS — every previously-green test stays green; 3 new lazy-fill tests pass; no TypeScript errors.

If you see TS errors about `Schedule` literals missing `partnerId`, add it to those fixtures. Don't `as any` it — that hides real bugs.

- [ ] **Step 9: Commit**

```bash
git add src/lib/types.ts src/lib/schedule-store.ts tests/schedule-store.test.ts tests/schedule-store-partnerId.test.ts tests/schedule.test.ts tests/tools.test.ts tests/cron-run.test.ts tests/dashboard.test.ts
git commit -m "feat(P3): Schedule.partnerId required + lazy-fill from owning customer"
```

Only stage files you actually touched. If `tests/dashboard.test.ts` didn't need a change, omit it.

---

## Task 4: `createScheduleTool` populates `partnerId` at create time

**Goal:** New schedules carry their owner's `partnerId` from creation.

**Files:**
- Modify: `src/lib/tools.ts`
- Modify: `tests/tools.test.ts` (extend or add a new spec)

- [ ] **Step 1: Write the failing test**

Append to `tests/tools.test.ts` (or wherever `createScheduleTool` is tested) a new case:

```ts
it('create_schedule writes partnerId from the owning customer', async () => {
  const redis = fakeRedis();
  const store = createStore(redis);
  const customerStore = createCustomerStore(redis, store);
  const scheduleStore = createScheduleStore(redis, customerStore);
  await customerStore.saveCustomer({
    senderPhone: '15551112222',
    firstSeenAt: '2026-01-01T00:00:00Z',
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'acme',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  // ... wire ctx with the standard test fixtures (see existing tests in this file
  // for the ToolContext shape) ...
  const ctx = makeToolContext({ phone: '15551112222', store, scheduleStore, customerStore });

  await executeTool('create_schedule', {
    amount_usd: 100,
    recipient_name: 'Mom',
    recipient_phone: '919876543210',
    payout_method: 'upi',
    payout_destination: 'mom@upi',
    funding_method: 'bank_transfer',
    frequency: 'monthly',
    day_of_month: 2,
  }, ctx);

  const [created] = await scheduleStore.listSchedules();
  expect(created.partnerId).toBe('acme');
});
```

If `tests/tools.test.ts` doesn't yet have a `makeToolContext` helper, read the existing `create_schedule` test in that file and mirror its setup pattern (it currently builds the context inline). Reuse whatever shape is already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools.test.ts -t "create_schedule writes partnerId"`
Expected: FAIL — `created.partnerId` is `undefined` (the tool doesn't set it).

- [ ] **Step 3: Modify `createScheduleTool` in `src/lib/tools.ts`**

Inside `createScheduleTool` (≈line 500), after the `dayOfWeek`/`dayOfMonth` validation and before the `const schedule: Schedule = { ... }` literal, fetch the owning customer:

```ts
// Look up the owner's partnerId — required on every new schedule (P3).
const owner = await ctx.customerStore.getCustomer(ctx.phone);
const partnerId = owner?.partnerId ?? 'default';
```

Then add `partnerId` to the schedule literal:

```ts
const schedule: Schedule = {
  id: newTransferId(),
  phone: ctx.phone,
  amountUsd: Number(args.amount_usd),
  recipientName: String(args.recipient_name),
  recipientPhone,
  payoutMethod: args.payout_method as Schedule['payoutMethod'],
  payoutDestination: String(args.payout_destination),
  fundingMethod: args.funding_method as Schedule['fundingMethod'],
  frequency,
  dayOfMonth,
  dayOfWeek,
  status: 'active',
  createdAt: new Date().toISOString(),
  partnerId,               // NEW (P3)
};
```

(`DEFAULT_PARTNER_ID` from `defaults.ts` is preferred over the literal `'default'`; import it at the top of `tools.ts` and use `partnerId: owner?.partnerId ?? DEFAULT_PARTNER_ID;` if it's not already imported.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools.test.ts`
Expected: PASS — new test + all existing tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "feat(P3): create_schedule populates partnerId from owner"
```

---

## Task 5: `backfillSchedulesOnce` migration

**Goal:** A sentinel-guarded cron pass that persists `Schedule.partnerId` on every legacy record. Idempotent.

**Files:**
- Modify: `src/lib/migration.ts`
- Modify: `src/app/api/cron/route.ts`
- Modify: `tests/migration.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/migration.test.ts`:

```ts
import {
  backfillCustomersOnce,
  backfillCountryCurrencyOnce,
  backfillPartnersOnce,
  backfillSchedulesOnce,   // NEW
} from '@/lib/migration';
import { createScheduleStore } from '@/lib/schedule-store';

describe('backfillSchedulesOnce', () => {
  it('writes partnerId to every legacy schedule (from owning customer)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);

    // Owning customer with partnerId: 'acme'
    await cs.saveCustomer({
      senderPhone: '15551112222',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    // Legacy schedule, no partnerId on disk
    await redis.set('schedule:OLDSCH1', JSON.stringify({
      id: 'OLDSCH1',
      phone: '15551112222',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'OLDSCH1');

    const result = await backfillSchedulesOnce(store, cs, ss);
    expect(result.schedulesBackfilled).toBe(1);
    expect(result.skippedSentinel).toBe(false);

    const raw = JSON.parse((await redis.get('schedule:OLDSCH1'))!);
    expect(raw.partnerId).toBe('acme');
  });

  it('falls back to default when owning customer is missing (defensive)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);
    await redis.set('schedule:OLDSCH2', JSON.stringify({
      id: 'OLDSCH2',
      phone: '15559999999',                // orphan phone — no Customer record
      amountUsd: 100,
      recipientName: 'X',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'x@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'OLDSCH2');

    await backfillSchedulesOnce(store, cs, ss);
    const raw = JSON.parse((await redis.get('schedule:OLDSCH2'))!);
    expect(raw.partnerId).toBe('default');
  });

  it('is idempotent — second call returns skippedSentinel: true and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);
    const first = await backfillSchedulesOnce(store, cs, ss);
    const second = await backfillSchedulesOnce(store, cs, ss);
    expect(first.skippedSentinel).toBe(false);
    expect(second.skippedSentinel).toBe(true);
    expect(second.schedulesBackfilled).toBe(0);
  });

  it('does NOT overwrite an existing partnerId on a schedule', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    const ss = createScheduleStore(redis, cs);
    await cs.saveCustomer({
      senderPhone: '15551112222',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await redis.set('schedule:KEEPME', JSON.stringify({
      id: 'KEEPME',
      phone: '15551112222',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
      partnerId: 'beta',               // already explicit — must be preserved
    }));
    await redis.sadd('schedules:ids', 'KEEPME');

    await backfillSchedulesOnce(store, cs, ss);
    const raw = JSON.parse((await redis.get('schedule:KEEPME'))!);
    expect(raw.partnerId).toBe('beta');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/migration.test.ts -t "backfillSchedulesOnce"`
Expected: FAIL — `backfillSchedulesOnce is not a function`.

- [ ] **Step 3: Add `backfillSchedulesOnce` in `src/lib/migration.ts`**

Append to the file:

```ts
import type { ScheduleStore } from './schedule-store';

const SCHEDULE_PARTNER_SENTINEL_KEY = 'schedule-partner-backfill-v1';

export async function backfillSchedulesOnce(
  store: Store,
  customerStore: CustomerStore,
  scheduleStore: ScheduleStore,
): Promise<{ schedulesBackfilled: number; skippedSentinel: boolean }> {
  const claimed = await store.claimMigrationFlag(SCHEDULE_PARTNER_SENTINEL_KEY);
  if (!claimed) return { schedulesBackfilled: 0, skippedSentinel: true };

  // listSchedules lazy-fills partnerId; re-saving persists.
  // A schedule with an already-explicit partnerId stays unchanged because the
  // spread preserves it (lazy-fill only runs when partnerId is falsy).
  let schedulesBackfilled = 0;
  for (const s of await scheduleStore.listSchedules()) {
    await scheduleStore.saveSchedule({ ...s });
    schedulesBackfilled++;
  }
  return { schedulesBackfilled, skippedSentinel: false };
}
```

- [ ] **Step 4: Wire `backfillSchedulesOnce` into the cron handler**

Modify `src/app/api/cron/route.ts`:

```ts
import {
  backfillCustomersOnce,
  backfillCountryCurrencyOnce,
  backfillPartnersOnce,
  backfillSchedulesOnce,
} from '@/lib/migration';

// ... inside GET, after the partnerBackfill line:

const scheduleStore = getScheduleStore();
const partnerBackfill = await backfillPartnersOnce(store, customerStore, partnerStore);
const schedulePartnerBackfill = await backfillSchedulesOnce(store, customerStore, scheduleStore);

const result = await runDueSchedules({
  store,
  scheduleStore,
  // ... unchanged ...
});

return NextResponse.json({
  ok: true,
  fired: result.fired,
  backfill,
  countryCurrencyBackfill,
  partnerBackfill,
  schedulePartnerBackfill,    // NEW (P3)
});
```

(The `getScheduleStore` import is already present.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/migration.test.ts`
Expected: PASS — all four new tests + every existing migration test.

- [ ] **Step 6: Commit**

```bash
git add src/lib/migration.ts src/app/api/cron/route.ts tests/migration.test.ts
git commit -m "feat(P3): backfillSchedulesOnce sentinel-guarded migration"
```

---

## Task 6: `createScopedStore(staff)` facade

**Goal:** The scoping chokepoint. Wraps the four underlying stores and filters by `staff.partnerId`. Every dashboard page swaps in this facade in Task 11.

**Files:**
- Create: `src/lib/scoped-store.ts`
- Create: `tests/scoped-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/scoped-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createScopedStore } from '@/lib/scoped-store';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createPartnerStore } from '@/lib/partner-store';
import { createScheduleStore } from '@/lib/schedule-store';
import { createTransfer } from '@/lib/transfer-create';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Staff } from '@/lib/types';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ rates: { INR: 85.2 } }),
  }));
});
afterEach(() => vi.restoreAllMocks());

function platformAdmin(): Staff {
  return {
    username: 'admin', name: 'Admin', role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
  };
}
function partnerStaff(partnerId: string): Staff {
  return {
    username: 'partner-' + partnerId, name: 'P', role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    partnerId,
  };
}

async function seedTwoPartnersData(redis = fakeRedis()) {
  const store = createStore(redis);
  const customerStore = createCustomerStore(redis, store);
  const partnerStore = createPartnerStore(redis);
  const scheduleStore = createScheduleStore(redis, customerStore);

  for (const id of ['acme', 'beta']) {
    await partnerStore.savePartner({
      id, name: id.toUpperCase(), countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
  }
  // 2 customers per partner
  for (const [phone, partnerId] of [
    ['15551111111', 'acme'], ['15552222222', 'acme'],
    ['15553333333', 'beta'], ['15554444444', 'beta'],
  ] as const) {
    await customerStore.saveCustomer({
      senderPhone: phone, firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified', senderCountry: 'US', partnerId,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await createTransfer(store, {
      phone, amountUsd: 100, recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    await scheduleStore.saveSchedule({
      id: 'SCH-' + phone, phone, amountUsd: 50,
      recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly', dayOfMonth: 2, status: 'active',
      createdAt: '2026-05-01T00:00:00Z',
      partnerId,
    });
  }
  // Backfill transfers to carry the correct partnerId (createTransfer always
  // writes DEFAULT_PARTNER_ID; rewrite them in-place for this test).
  for (const t of await store.listTransfers()) {
    const c = await customerStore.getCustomer(t.phone);
    await store.saveTransfer({ ...t, partnerId: c?.partnerId ?? 'default' });
  }

  return { redis, store, customerStore, partnerStore, scheduleStore };
}

describe('createScopedStore', () => {
  it('platform staff sees every partner\'s data', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(platformAdmin(), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect((await scoped.listTransfers()).length).toBe(4);
    expect((await scoped.listCustomers()).length).toBe(4);
    expect((await scoped.listSchedules()).length).toBe(4);
    expect((await scoped.listPartners()).length).toBe(2);
  });

  it('partner staff sees only their own partner\'s data', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    const transfers = await scoped.listTransfers();
    const customers = await scoped.listCustomers();
    const schedules = await scoped.listSchedules();
    const partners = await scoped.listPartners();
    expect(transfers.every((t) => t.partnerId === 'acme')).toBe(true);
    expect(transfers).toHaveLength(2);
    expect(customers.every((c) => c.partnerId === 'acme')).toBe(true);
    expect(customers).toHaveLength(2);
    expect(schedules.every((s) => s.partnerId === 'acme')).toBe(true);
    expect(schedules).toHaveLength(2);
    expect(partners.map((p) => p.id)).toEqual(['acme']);
  });

  it('partner staff getTransfer returns null for another partner\'s id', async () => {
    const env = await seedTwoPartnersData();
    const allTransfers = await env.store.listTransfers();
    const otherTransfer = allTransfers.find((t) => t.partnerId === 'beta')!;
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(await scoped.getTransfer(otherTransfer.id)).toBeNull();
  });

  it('partner staff getCustomer returns null for another partner\'s customer', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(await scoped.getCustomer('15553333333')).toBeNull();   // beta's
    expect(await scoped.getCustomer('15551111111')).not.toBeNull(); // acme's
  });

  it('partner staff getPartner returns null for another partner\'s id', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(await scoped.getPartner('beta')).toBeNull();
    expect((await scoped.getPartner('acme'))?.id).toBe('acme');
  });

  it('exposes the scope on the returned facade', async () => {
    const env = await seedTwoPartnersData();
    const scoped = createScopedStore(partnerStaff('acme'), {
      store: env.store, customerStore: env.customerStore,
      partnerStore: env.partnerStore, scheduleStore: env.scheduleStore,
    });
    expect(scoped.scope).toEqual({ kind: 'partner', partnerId: 'acme' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scoped-store.test.ts`
Expected: FAIL — `Cannot find module '@/lib/scoped-store'`.

- [ ] **Step 3: Implement `src/lib/scoped-store.ts`**

```ts
import type { Staff } from './types';
import type { Store } from './store';
import type { CustomerStore } from './customer-store';
import type { PartnerStore } from './partner-store';
import type { ScheduleStore } from './schedule-store';
import { scopeOf, canSee, type Scope } from './staff-scope';
import { getStore } from './store';
import { getCustomerStore } from './customer-store';
import { getPartnerStore } from './partner-store';
import { getScheduleStore } from './schedule-store';

export interface ScopedStoreDeps {
  store: Store;
  customerStore: CustomerStore;
  partnerStore: PartnerStore;
  scheduleStore: ScheduleStore;
}

export function createScopedStore(staff: Staff, deps?: ScopedStoreDeps) {
  const scope: Scope = scopeOf(staff);
  // In production, callers omit `deps` and we wire from the singletons.
  // In tests, callers inject deps backed by fakeRedis.
  const store = deps?.store ?? getStore();
  const customerStore = deps?.customerStore ?? getCustomerStore(store);
  const partnerStore = deps?.partnerStore ?? getPartnerStore();
  const scheduleStore = deps?.scheduleStore ?? getScheduleStore();

  return {
    scope,
    async listTransfers() {
      const all = await store.listTransfers();
      return scope.kind === 'platform'
        ? all
        : all.filter((t) => t.partnerId === scope.partnerId);
    },
    async listCustomers() {
      const all = await customerStore.listCustomers();
      return scope.kind === 'platform'
        ? all
        : all.filter((c) => c.partnerId === scope.partnerId);
    },
    async listSchedules() {
      const all = await scheduleStore.listSchedules();
      return scope.kind === 'platform'
        ? all
        : all.filter((s) => s.partnerId === scope.partnerId);
    },
    async listPartners() {
      const all = await partnerStore.listPartners();
      return scope.kind === 'platform'
        ? all
        : all.filter((p) => p.id === scope.partnerId);
    },
    async getTransfer(id: string) {
      const t = await store.getTransfer(id);
      if (!t || !canSee(scope, t.partnerId)) return null;
      return t;
    },
    async getCustomer(phone: string) {
      const c = await customerStore.getCustomer(phone);
      if (!c || !canSee(scope, c.partnerId)) return null;
      return c;
    },
    async getPartner(id: string) {
      const p = await partnerStore.getPartner(id);
      if (!p || !canSee(scope, p.id)) return null;
      return p;
    },
  };
}

export type ScopedStore = ReturnType<typeof createScopedStore>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/scoped-store.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scoped-store.ts tests/scoped-store.test.ts
git commit -m "feat(P3): createScopedStore facade with per-partner filtering"
```

---

## Task 7: Extend `auth.ts` — `requirePlatformAdmin`, `requireScope`, suspended-partner bounce

**Goal:** New gate helpers + mid-session enforcement: a partner-scoped staff whose partner gets suspended bounces to `/login` on the next page load.

**Files:**
- Modify: `src/lib/auth.ts`
- Create: `tests/auth-suspended-partner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/auth-suspended-partner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createAuthStore } from '@/lib/auth-store';
import { createPartnerStore } from '@/lib/partner-store';

// Mock next/headers + next/navigation BEFORE importing auth.ts
const cookieJar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined,
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  }),
}));
const redirectMock = vi.fn((path: string) => { throw new Error('REDIRECT:' + path); });
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

// Shared redis so auth-store + partner-store see the same data
const redis = fakeRedis();
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(redis) };
});

import { getCurrentStaff, requirePlatformAdmin } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { SESSION_COOKIE } from '@/lib/session-cookie';

beforeEach(() => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('getCurrentStaff suspended-partner bounce', () => {
  it('returns the staff for an active-partner session', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    await partnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p');
    cookieJar.set(SESSION_COOKIE, token);

    const staff = await getCurrentStaff();
    expect(staff?.username).toBe('p');
  });

  it('returns null when the staff\'s partner is suspended', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    await partnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p');
    cookieJar.set(SESSION_COOKIE, token);

    expect(await getCurrentStaff()).toBeNull();
  });

  it('platform staff are unaffected by any partner\'s status', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    // Some random partner happens to be suspended.
    await partnerStore.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'admin', name: 'Admin', role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      // No partnerId → platform.
    });
    const token = await authStore.createSession('admin');
    cookieJar.set(SESSION_COOKIE, token);

    expect((await getCurrentStaff())?.username).toBe('admin');
  });
});

describe('requirePlatformAdmin', () => {
  it('returns the staff for a platform admin', async () => {
    const authStore = getAuthStore();
    await authStore.saveStaff({
      username: 'admin', name: 'Admin', role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    });
    const token = await authStore.createSession('admin');
    cookieJar.set(SESSION_COOKIE, token);

    const staff = await requirePlatformAdmin();
    expect(staff.username).toBe('admin');
  });

  it('redirects /dashboard when role is agent', async () => {
    const authStore = getAuthStore();
    await authStore.saveStaff({
      username: 'a', name: 'A', role: 'agent',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    });
    const token = await authStore.createSession('a');
    cookieJar.set(SESSION_COOKIE, token);

    await expect(requirePlatformAdmin()).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('redirects /dashboard when staff has a partnerId (partner-admin, not platform)', async () => {
    const authStore = getAuthStore();
    const partnerStore = getPartnerStore();
    await partnerStore.savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'pa', name: 'PA', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('pa');
    cookieJar.set(SESSION_COOKIE, token);

    await expect(requirePlatformAdmin()).rejects.toThrow('REDIRECT:/dashboard');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/auth-suspended-partner.test.ts`
Expected: FAIL — `requirePlatformAdmin` not exported; `getCurrentStaff` doesn't yet check partner status.

- [ ] **Step 3: Modify `src/lib/auth.ts`**

Replace the file contents with:

```ts
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from './auth-store';
import { getPartnerStore } from './partner-store';
import { SESSION_COOKIE } from './session-cookie';
import { scopeOf, type Scope } from './staff-scope';
import type { Staff } from './types';

export async function getCurrentStaff(): Promise<Staff | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const username = await getAuthStore().getSessionUser(token);
  if (!username) return null;
  const staff = await getAuthStore().getStaff(username);
  if (!staff) return null;

  // P3: partner-scoped staff bounce when their partner is suspended/missing.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') return null;
  }
  return staff;
}

export async function requireStaff(): Promise<Staff> {
  const staff = await getCurrentStaff();
  if (!staff) redirect('/login');
  return staff;
}

export async function requireAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin') redirect('/dashboard');
  return staff;
}

// P3: a platform admin = role:'admin' AND no partnerId. Used by /dashboard/team
// and partner-staff CRUD actions.
export async function requirePlatformAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin' || staff.partnerId !== undefined) {
    redirect('/dashboard');
  }
  return staff;
}

// P3: convenience for pages — returns staff and pre-computed scope.
export async function requireScope(): Promise<{ staff: Staff; scope: Scope }> {
  const staff = await requireStaff();
  return { staff, scope: scopeOf(staff) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/auth-suspended-partner.test.ts`
Expected: PASS — 6 tests.

Also run the existing tests that depended on `requireStaff` shape:
Run: `npx vitest run tests/partners-actions.test.ts`
Expected: PASS (the mock there still satisfies the contract).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth.ts tests/auth-suspended-partner.test.ts
git commit -m "feat(P3): requirePlatformAdmin + requireScope + suspended-partner mid-session bounce"
```

---

## Task 8: Login refuses suspended-partner staff

**Goal:** A partner-scoped staff whose partner is `suspended` cannot create a new session. Error message is generic — no credential-validity leak.

**Files:**
- Modify: `src/app/login/actions.ts`
- Create: `tests/login-suspended-partner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/login-suspended-partner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined,
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (n: string) => cookieJar.delete(n),
  }),
}));
const redirectMock = vi.fn((p: string) => { throw new Error('REDIRECT:' + p); });
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(redis) };
});
vi.mock('@/lib/seed', () => ({ ensureSeedAdmin: async () => {} }));

import { login } from '@/app/login/actions';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { hashPassword } from '@/lib/password';

beforeEach(() => { redis.dump.clear(); cookieJar.clear(); redirectMock.mockClear(); });
afterEach(() => vi.clearAllMocks());

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe('login action with partner suspension', () => {
  it('allows login when the staff\'s partner is active', async () => {
    await getPartnerStore().savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z', partnerId: 'acme',
    });
    await expect(login(null, form({ username: 'p', password: 'hunter2' })))
      .rejects.toThrow('REDIRECT:/dashboard');
  });

  it('rejects login (generic error) when the partner is suspended', async () => {
    await getPartnerStore().savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z', partnerId: 'acme',
    });
    const result = await login(null, form({ username: 'p', password: 'hunter2' }));
    expect(result).toMatch(/account unavailable/i);
    // No session cookie set
    expect(cookieJar.size).toBe(0);
  });

  it('rejects login when the partner record is missing', async () => {
    await getAuthStore().saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z', partnerId: 'ghost',
    });
    const result = await login(null, form({ username: 'p', password: 'hunter2' }));
    expect(result).toMatch(/account unavailable/i);
  });

  it('platform staff login is unaffected by partner status', async () => {
    await getPartnerStore().savePartner({
      id: 'acme', name: 'A', countries: ['US'], status: 'suspended',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await getAuthStore().saveStaff({
      username: 'admin', name: 'Admin', role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: hashPassword('hunter2'),
      createdAt: '2026-05-27T00:00:00Z',
    });
    await expect(login(null, form({ username: 'admin', password: 'hunter2' })))
      .rejects.toThrow('REDIRECT:/dashboard');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/login-suspended-partner.test.ts`
Expected: FAIL — login currently doesn't check partner status.

- [ ] **Step 3: Modify `src/app/login/actions.ts`**

Replace the body of `login`:

```ts
export async function login(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  await ensureSeedAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const staff = await getAuthStore().getStaff(username);
  if (!staff || !verifyPassword(password, staff.passwordHash)) {
    return 'Invalid username or password.';
  }

  // P3: block login if the staff's partner is suspended or missing.
  // Generic error so credential validity isn't leaked.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') {
      return 'Account unavailable. Contact SendHome support.';
    }
  }

  const token = await getAuthStore().createSession(username);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  redirect('/dashboard');
}
```

Add the import at the top of the file:

```ts
import { getPartnerStore } from '@/lib/partner-store';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/login-suspended-partner.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/login/actions.ts tests/login-suspended-partner.test.ts
git commit -m "feat(P3): login refuses suspended-partner staff (generic error)"
```

---

## Task 9: Partner-staff CRUD actions + session revocation on suspend

**Goal:** Platform admins can create/remove staff scoped to a specific partner. When a partner is suspended, its staff sessions are revoked immediately (eviction is instant, not deferred to next page load).

**Files:**
- Modify: `src/app/dashboard/partners/actions.ts`
- Create: `tests/partner-staff-actions.test.ts`
- Modify: `tests/partners-actions.test.ts` (extend with suspension-revocation case)

- [ ] **Step 1: Write the failing tests**

Create `tests/partner-staff-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

const redis = fakeRedis();

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: async () => ({
    username: 'admin', name: 'Admin', role: 'admin' as const,
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
  }),
}));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { createPartnerStaffAction, removePartnerStaffAction } from '@/app/dashboard/partners/actions';
import { createAuthStore } from '@/lib/auth-store';

beforeEach(() => redis.dump.clear());
afterEach(() => vi.clearAllMocks());

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe('createPartnerStaffAction', () => {
  it('creates a staff record scoped to the given partnerId from the URL', async () => {
    await createPartnerStaffAction('acme', form({
      username: 'p1', name: 'Partner One', password: 'hunter2', role: 'admin',
    }));
    const got = await createAuthStore(redis).getStaff('p1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
    expect(got?.passwordHash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });

  it('refuses to honour partnerId from the form (URL param is authoritative)', async () => {
    // The form might try to override partnerId; we ignore it.
    await createPartnerStaffAction('acme', form({
      username: 'p2', name: 'P Two', password: 'pw', role: 'agent',
      partnerId: 'OVERRIDE',
    }));
    const got = await createAuthStore(redis).getStaff('p2');
    expect(got?.partnerId).toBe('acme');
  });

  it('throws on invalid role', async () => {
    await expect(createPartnerStaffAction('acme', form({
      username: 'x', name: 'x', password: 'x', role: 'root',
    }))).rejects.toThrow(/role/i);
  });

  it('throws when any of username, name, password are missing', async () => {
    await expect(createPartnerStaffAction('acme', form({
      username: '', name: 'x', password: 'x', role: 'agent',
    }))).rejects.toThrow();
  });
});

describe('removePartnerStaffAction', () => {
  it('deletes the staff record and all their sessions', async () => {
    const authStore = createAuthStore(redis);
    await authStore.saveStaff({
      username: 'p1', name: 'P', role: 'agent',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p1');

    await removePartnerStaffAction(form({ username: 'p1' }));

    expect(await authStore.getStaff('p1')).toBeNull();
    expect(await authStore.getSessionUser(token)).toBeNull();
  });
});
```

Append to `tests/partners-actions.test.ts` (the file shape already mocks `requireAdmin` — extend that mock to also mock `requirePlatformAdmin`):

Update the auth mock at the top:

```ts
vi.mock('@/lib/auth', () => ({
  requireAdmin: async () => ({ username: 'admin', role: 'admin' }),
  requireStaff: async () => ({ username: 'admin', role: 'admin' }),
  requirePlatformAdmin: async () => ({ username: 'admin', role: 'admin' }),
}));
```

Then extend the auth-store mock to use a shared redis with partner-store so the action can resolve the affected staff:

```ts
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(sharedRedis) };
});
```

And append a new test:

```ts
describe('setPartnerStatusAction session revocation', () => {
  it('deletes sessions for all staff of a suspended partner', async () => {
    const authStore = (await import('@/lib/auth-store')).getAuthStore();
    await ps.savePartner({
      id: 'acme', name: 'Acme', countries: ['US'], status: 'active',
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    });
    await authStore.saveStaff({
      username: 'p', name: 'P', role: 'admin',
      permissions: { canCancel: false, canResend: false, canAssign: false },
      passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
      partnerId: 'acme',
    });
    const token = await authStore.createSession('p');

    const fd = new FormData();
    fd.set('id', 'acme');
    fd.set('status', 'suspended');
    await setPartnerStatusAction(fd);

    expect(await authStore.getSessionUser(token)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/partner-staff-actions.test.ts tests/partners-actions.test.ts`
Expected: FAIL — `createPartnerStaffAction` / `removePartnerStaffAction` not exported; existing `setPartnerStatusAction` doesn't yet revoke sessions.

- [ ] **Step 3: Modify `src/app/dashboard/partners/actions.ts`**

Append the two new actions and extend `setPartnerStatusAction`:

```ts
import { hashPassword } from '@/lib/password';
import { requirePlatformAdmin } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import type { PartnerId, StaffRole } from '@/lib/types';

export async function createPartnerStaffAction(
  partnerId: PartnerId,
  formData: FormData,
): Promise<void> {
  await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? 'agent') as StaffRole;
  if (role !== 'admin' && role !== 'agent') throw new Error('Invalid role.');
  if (!username || !name || !password) throw new Error('username, name, and password are required.');

  await getAuthStore().saveStaff({
    username,
    name,
    role,
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    partnerId,                  // taken from URL, not form
  });
  revalidatePath(`/dashboard/partners/${partnerId}`);
}

export async function removePartnerStaffAction(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  if (!username) throw new Error('username is required.');
  const authStore = getAuthStore();
  const staff = await authStore.getStaff(username);
  await authStore.deleteStaff(username);
  await authStore.deleteAllSessionsFor(username);
  if (staff?.partnerId) revalidatePath(`/dashboard/partners/${staff.partnerId}`);
}
```

Extend `setPartnerStatusAction`. After `await ps.savePartner({ ...existing, status, updatedAt: ... })`, add:

```ts
if (status === 'suspended') {
  const authStore = getAuthStore();
  const all = await authStore.listStaff();
  const affected = all.filter((s) => s.partnerId === id);
  for (const s of affected) await authStore.deleteAllSessionsFor(s.username);
}
```

(Add `import { getAuthStore } from '@/lib/auth-store';` if not yet imported.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/partner-staff-actions.test.ts tests/partners-actions.test.ts`
Expected: PASS — both files fully green.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/partners/actions.ts tests/partner-staff-actions.test.ts tests/partners-actions.test.ts
git commit -m "feat(P3): partner-staff CRUD actions + session revocation on suspend"
```

---

## Task 10: Partner-detail page — "Staff for this partner" panel + partner-list redirect

**Goal:** UI surface for the Task 9 actions. Plus: a partner-scoped staff hitting `/dashboard/partners` is redirected to their own partner detail page.

**Files:**
- Modify: `src/app/dashboard/partners/[id]/page.tsx`
- Modify: `src/app/dashboard/partners/page.tsx`

- [ ] **Step 1: Modify `src/app/dashboard/partners/page.tsx` — redirect partner-scoped staff**

At the top of `PartnersPage`, after `const staff = await requireStaff();`:

```ts
if (staff.partnerId) {
  redirect(`/dashboard/partners/${staff.partnerId}`);
}
```

Add the `redirect` import:

```ts
import { redirect } from 'next/navigation';
```

- [ ] **Step 2: Modify `src/app/dashboard/partners/[id]/page.tsx` — add Staff panel**

After the Activity panel and before the closing `</main>`, render a Staff panel. Add at the top of the file:

```ts
import { getAuthStore } from '@/lib/auth-store';
import {
  setPartnerStatusAction,
  updatePartnerAction,
  createPartnerStaffAction,
  removePartnerStaffAction,
} from '../actions';
```

After the existing `partner` + `transfers` fetch:

```ts
const allStaff = await getAuthStore().listStaff();
const partnerStaff = allStaff.filter((s) => s.partnerId === partner.id);
```

Render a new section above the closing `</main>`:

```tsx
<section className="sh-card">
  <div className="sh-card-head">
    <div>
      <div className="sh-card-title">Staff for this partner</div>
      <div className="sh-card-sub">
        {partnerStaff.length} {partnerStaff.length === 1 ? 'member' : 'members'}
      </div>
    </div>
  </div>
  <div className="sh-ledger-wrap">
    <table className="sh-table">
      <thead>
        <tr><th>Name</th><th>Username</th><th>Role</th><th>Created</th><th>Actions</th></tr>
      </thead>
      <tbody>
        {partnerStaff.length === 0 && (
          <tr><td colSpan={5} className="sh-empty">No staff yet.</td></tr>
        )}
        {partnerStaff.map((s) => (
          <tr key={s.username}>
            <td>{s.name}</td>
            <td>{s.username}</td>
            <td>
              <span className={`sh-pill ${s.role === 'admin' ? 'sh-pill-info' : 'sh-pill-neutral'}`}>
                <span className="sh-pill-dot"></span>{s.role}
              </span>
            </td>
            <td>{new Date(s.createdAt).toLocaleDateString()}</td>
            <td>
              {isAdmin && (
                <form action={removePartnerStaffAction}>
                  <input type="hidden" name="username" value={s.username} />
                  <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Remove</button>
                </form>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>

  {isAdmin && (
    <form
      action={createPartnerStaffAction.bind(null, partner.id)}
      className="sh-inline-form"
      style={{ flexDirection: 'column', alignItems: 'stretch', padding: 20, gap: 8 }}
    >
      <input className="sh-input" name="username" placeholder="Username" required />
      <input className="sh-input" name="name" placeholder="Full name" required />
      <input className="sh-input" name="password" type="password" placeholder="Password" required />
      <select className="sh-input" name="role" defaultValue="agent">
        <option value="agent">Agent</option>
        <option value="admin">Admin</option>
      </select>
      <button type="submit" className="sh-btn-primary">Invite staff</button>
    </form>
  )}
</section>
```

`createPartnerStaffAction.bind(null, partner.id)` is how we pin the URL-param partnerId into the server action's first positional arg from JSX — the form data only carries username/name/password/role.

- [ ] **Step 3: Smoke-check by running a fast build**

Run: `npx next build --turbopack` (or whichever the project uses)
Expected: build succeeds with no missing-export errors.

(There is no unit test for these page edits — the spec calls out that page-level behavior is proven by scoped-store + sidebar + actions unit tests, with the E2E smoke in Task 15 as the final guard.)

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/partners/page.tsx src/app/dashboard/partners/[id]/page.tsx
git commit -m "feat(P3): partner detail Staff panel + partner-scoped list redirect"
```

---

## Task 11: Sidebar — `visibleNavItems(staff)` gating

**Goal:** Partner-scoped staff don't see `Partners` (list) or `Team`; they get a `My partner` direct link. Platform staff see what they see today.

**Files:**
- Modify: `src/app/dashboard/sidebar.tsx`
- Create: `tests/sidebar.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/sidebar.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { visibleNavItems } from '@/app/dashboard/sidebar';
import type { Staff } from '@/lib/types';

function staff(role: 'admin' | 'agent', partnerId?: string): Staff {
  return {
    username: 'u', name: 'U', role,
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: 'salt:hash', createdAt: '2026-05-27T00:00:00Z',
    partnerId,
  };
}

describe('visibleNavItems', () => {
  it('platform admin sees overview/transactions/schedules/customers/compliance/analytics/partners/team', () => {
    const items = visibleNavItems(staff('admin', undefined));
    expect(items).toContain('overview');
    expect(items).toContain('transactions');
    expect(items).toContain('schedules');
    expect(items).toContain('customers');
    expect(items).toContain('compliance');
    expect(items).toContain('analytics');
    expect(items).toContain('partners');
    expect(items).toContain('team');
    expect(items).not.toContain('my-partner');
  });

  it('platform agent has the same items minus team', () => {
    const items = visibleNavItems(staff('agent', undefined));
    expect(items).toContain('partners');
    expect(items).not.toContain('team');
    expect(items).not.toContain('my-partner');
  });

  it('partner admin sees base + my-partner; never partners or team', () => {
    const items = visibleNavItems(staff('admin', 'acme'));
    expect(items).toContain('overview');
    expect(items).toContain('transactions');
    expect(items).toContain('my-partner');
    expect(items).not.toContain('partners');
    expect(items).not.toContain('team');
  });

  it('partner agent matches partner admin (no team toggle inside partner scope)', () => {
    const items = visibleNavItems(staff('agent', 'acme'));
    expect(items).toContain('my-partner');
    expect(items).not.toContain('partners');
    expect(items).not.toContain('team');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/sidebar.test.ts`
Expected: FAIL — `visibleNavItems` not exported.

- [ ] **Step 3: Refactor `src/app/dashboard/sidebar.tsx`**

```tsx
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import type { Staff } from '@/lib/types';

export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'customers'
  | 'partners'
  | 'compliance'
  | 'analytics'
  | 'team'
  | 'my-partner';

export type NavItem = SidebarActive;

export function visibleNavItems(staff: Staff): NavItem[] {
  const base: NavItem[] = [
    'overview', 'transactions', 'schedules',
    'customers', 'compliance', 'analytics',
  ];
  if (!staff.partnerId) {
    // Platform: base + Partners list + (Team only if admin)
    return [...base, 'partners', ...(staff.role === 'admin' ? (['team'] as NavItem[]) : [])];
  }
  // Partner-scoped: base + direct link to their own partner detail
  return [...base, 'my-partner'];
}

interface NavMeta {
  label: string;
  icon: string;
  hrefFor: (staff: Staff) => string;
}
const NAV_META: Record<NavItem, NavMeta> = {
  overview:     { label: 'Overview',     icon: '◾', hrefFor: () => '/dashboard' },
  transactions: { label: 'Transactions', icon: '↔', hrefFor: () => '/dashboard/transactions' },
  schedules:    { label: 'Schedules',    icon: '↻', hrefFor: () => '/dashboard/schedules' },
  customers:    { label: 'Customers',    icon: '◍', hrefFor: () => '/dashboard/customers' },
  partners:     { label: 'Partners',     icon: '◆', hrefFor: () => '/dashboard/partners' },
  compliance:   { label: 'Compliance',   icon: '⚑', hrefFor: () => '/dashboard/compliance' },
  analytics:    { label: 'Analytics',    icon: '▦', hrefFor: () => '/dashboard/analytics' },
  team:         { label: 'Team',         icon: '◉', hrefFor: () => '/dashboard/team' },
  'my-partner': { label: 'My partner',   icon: '◆', hrefFor: (s) => `/dashboard/partners/${s.partnerId}` },
};

export async function Sidebar({ active }: { active: SidebarActive }) {
  const staff = await requireStaff();
  const items = visibleNavItems(staff);
  const showAccountLabel = !staff.partnerId && staff.role === 'admin';

  return (
    <aside className="sh-sidebar">
      {items.map((key) => {
        if (key === 'team' && showAccountLabel) {
          return (
            <span key={`${key}-label`}>
              <div className="sh-nav-label">Account</div>
              <Link
                key={key}
                href={NAV_META[key].hrefFor(staff)}
                className={`sh-nav-item ${active === key ? 'active' : ''}`}
              >
                <span className="sh-nav-icon">{NAV_META[key].icon}</span> {NAV_META[key].label}
              </Link>
            </span>
          );
        }
        return (
          <Link
            key={key}
            href={NAV_META[key].hrefFor(staff)}
            className={`sh-nav-item ${active === key ? 'active' : ''}`}
          >
            <span className="sh-nav-icon">{NAV_META[key].icon}</span> {NAV_META[key].label}
          </Link>
        );
      })}
      {showAccountLabel && (
        <Link href="/dashboard" className="sh-nav-item">
          <span className="sh-nav-icon">⚙</span> Settings
        </Link>
      )}
    </aside>
  );
}
```

(If you want to keep the existing visual ordering of the `Account` label exactly, mirror the markup from the old Sidebar's `<>...</>` fragment around the Team link. The version above produces the same DOM shape.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/sidebar.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/sidebar.tsx tests/sidebar.test.ts
git commit -m "feat(P3): visibleNavItems drives sidebar; partner-scoped gating"
```

---

## Task 12: `/dashboard/team` — platform-only

**Goal:** Re-gate the Team page with `requirePlatformAdmin` and filter to platform staff only (partner staff now live on partner detail pages).

**Files:**
- Modify: `src/app/dashboard/team/page.tsx`

- [ ] **Step 1: Modify `src/app/dashboard/team/page.tsx`**

Replace the body of `TeamPage`:

```tsx
export default async function TeamPage() {
  await requirePlatformAdmin();
  const allStaff = await getAuthStore().listStaff();
  const staff = allStaff.filter((s) => !s.partnerId);
  // ... rest of the JSX unchanged, using `staff` ...
}
```

Update the import:

```ts
import { requirePlatformAdmin } from '@/lib/auth';
```

Remove the now-unused `requireAdmin` import.

- [ ] **Step 2: No new unit test (covered by `tests/auth-suspended-partner.test.ts` Task 7)**

The `requirePlatformAdmin` redirect contract is locked in Task 7's tests. The page-level filter is mechanical.

- [ ] **Step 3: Run the suite**

Run: `npx vitest run`
Expected: PASS — every test green.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/team/page.tsx
git commit -m "feat(P3): /dashboard/team gated to platform admins; shows platform staff only"
```

---

## Task 13: Page swaps — `createScopedStore` at every dashboard page + hide Partner column/filter for scoped users

**Goal:** Mechanical refactor. Every dashboard page that reads from a raw store swaps to `createScopedStore(staff)`. Transactions and Customers pages hide the Partner column + filter form when scope is partner.

**Files (9 pages):**
- `src/app/dashboard/page.tsx`
- `src/app/dashboard/transactions/page.tsx`
- `src/app/dashboard/customers/page.tsx`
- `src/app/dashboard/customers/[phone]/page.tsx`
- `src/app/dashboard/schedules/page.tsx`
- `src/app/dashboard/compliance/page.tsx`
- `src/app/dashboard/analytics/page.tsx`
- `src/app/dashboard/partners/[id]/page.tsx` (already gated by partner-store; ensure scoped-store path)
- (No swap needed at `/dashboard/partners/page.tsx` — Task 10 already redirects partner-scoped staff away.)

- [ ] **Step 1: Overview page (`src/app/dashboard/page.tsx`)**

```ts
// Replace:
await requireStaff();
const transfers = await getStore().listTransfers();
const schedules = await getScheduleStore().listSchedules();

// With:
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const transfers = await scoped.listTransfers();
const schedules = await scoped.listSchedules();
```

Update imports:

```ts
import { requireScope } from '@/lib/auth';
import { createScopedStore } from '@/lib/scoped-store';
```

Remove now-unused `requireStaff`, `getStore`, `getScheduleStore` imports.

- [ ] **Step 2: Transactions page**

Replace the data fetch with:

```ts
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const store = getStore();
const customerStore = getCustomerStore(store);
const partnerStore = getPartnerStore();
const [transfers, allStaff, customers, partners] = await Promise.all([
  scoped.listTransfers(),
  getAuthStore().listStaff(),
  scoped.listCustomers(),
  scoped.listPartners(),
]);
```

(`getStore`, `getCustomerStore`, `getPartnerStore` are no longer needed once you're going through `scoped`; remove the unused imports.)

In the JSX, hide the partner filter form for partner-scoped users:

```tsx
{scoped.scope.kind === 'platform' && (
  // ... existing partner filter form ...
)}
```

Pass `hidePartnerColumn={scoped.scope.kind === 'partner'}` (a new prop) to `TransactionsExplorer`, and in `transactions-explorer.tsx` conditionally render the Partner `<th>`/`<td>`. If you prefer not to refactor `TransactionsExplorer`, you can leave the column visible — but the spec says to hide it for the scoped case, so add the prop.

- [ ] **Step 3: Customers page**

Same pattern: pull data via `scoped`, hide the partner-filter form when scope is partner.

```ts
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const [customers, transfers, partners] = await Promise.all([
  scoped.listCustomers(),
  scoped.listTransfers(),
  scoped.listPartners(),
]);
```

Hide the form:

```tsx
{scoped.scope.kind === 'platform' && (
  <form method="get" /* ... existing partner filter form ... */ />
)}
```

Hide the Partner `<th>` + `<td>` for partner scope:

```tsx
{scoped.scope.kind === 'platform' && <th>Partner</th>}
// ... and in the row:
{scoped.scope.kind === 'platform' && <td>{partnerById[c.partnerId]?.name ?? c.partnerId}</td>}
```

- [ ] **Step 4: Customer detail page (`customers/[phone]/page.tsx`)**

```ts
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const customer = await scoped.getCustomer(phone);
if (!customer) notFound();
```

Same for the transfers list — use `scoped.listTransfers().then(t => t.filter(...))`.

- [ ] **Step 5: Schedules page**

```ts
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const all = await scoped.listSchedules();
```

- [ ] **Step 6: Compliance page**

```ts
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const transfers = await scoped.listTransfers();
```

- [ ] **Step 7: Analytics page**

```ts
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const transfers = await scoped.listTransfers();
```

- [ ] **Step 8: Partner detail page (`partners/[id]/page.tsx`)**

The page already uses `partnerStore.getPartner(id)`. Swap to scoped:

```ts
const { staff } = await requireScope();
const scoped = createScopedStore(staff);
const partner = await scoped.getPartner(id);
if (!partner) notFound();
```

The `notFound()` call naturally handles "another partner's id" because scoped `getPartner` returns null for unauthorized lookups.

Same for the transfers fetch on this page — go through `scoped.listTransfers().then(ts => ts.filter(t => t.partnerId === id))`.

- [ ] **Step 9: Run typecheck + suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — zero TS errors; full suite green.

- [ ] **Step 10: Manual sanity check (10 minutes)**

```bash
npm run dev
# Open http://localhost:3000/login
# Log in as the seeded platform admin (SEED_ADMIN_USERNAME / SEED_ADMIN_PASSWORD)
# Walk every page — confirm nothing visually broke.
```

(We don't have a partner-staff seeded locally yet; that's Task 14. The E2E partner-case asserts the partner side; for now we're just confirming the platform path is unchanged.)

- [ ] **Step 11: Commit**

```bash
git add src/app/dashboard
git commit -m "feat(P3): every dashboard page reads via createScopedStore; partner UI gating"
```

---

## Task 14: Seed a partner staff (for E2E smoke)

**Goal:** When the new optional env vars are set, the seeder also creates a partner-staff account so Playwright can log in as one.

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `src/lib/seed.ts`
- Modify: `.env.example`

- [ ] **Step 1: Extend `src/lib/env.ts`**

Append:

```ts
  // P3: optional partner-staff seed (set when E2E needs a partner login)
  get seedPartnerUsername() {
    return process.env.SEED_PARTNER_USERNAME ?? '';
  },
  get seedPartnerPassword() {
    return process.env.SEED_PARTNER_PASSWORD ?? '';
  },
  get seedPartnerId() {
    return process.env.SEED_PARTNER_ID ?? '';
  },
```

- [ ] **Step 2: Extend `src/lib/seed.ts`**

```ts
import { env } from './env';
import { hashPassword } from './password';
import { getAuthStore, type AuthStore } from './auth-store';
import { getPartnerStore } from './partner-store';
import type { Staff } from './types';

export async function ensureSeedAdmin(
  store: AuthStore = getAuthStore(),
): Promise<void> {
  const existing = await store.listStaff();
  if (existing.length === 0) {
    const admin: Staff = {
      username: env.seedAdminUsername,
      name: 'Main Admin',
      role: 'admin',
      permissions: { canCancel: true, canResend: true, canAssign: true },
      passwordHash: hashPassword(env.seedAdminPassword),
      createdAt: new Date().toISOString(),
    };
    await store.saveStaff(admin);
  }

  // P3: optional partner-staff seed.
  if (env.seedPartnerUsername && env.seedPartnerPassword && env.seedPartnerId) {
    const existingPartnerStaff = await store.getStaff(env.seedPartnerUsername);
    if (!existingPartnerStaff) {
      // Make sure the partner record exists before seeding the staff
      // (idempotent — does nothing if the partner is already there).
      const partnerStore = getPartnerStore();
      const partner = await partnerStore.getPartner(env.seedPartnerId);
      if (!partner) {
        const now = new Date().toISOString();
        await partnerStore.savePartner({
          id: env.seedPartnerId,
          name: `Seeded partner (${env.seedPartnerId})`,
          countries: ['US'],
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
      }
      const seeded: Staff = {
        username: env.seedPartnerUsername,
        name: 'Partner Staff (seed)',
        role: 'admin',
        permissions: { canCancel: false, canResend: false, canAssign: false },
        passwordHash: hashPassword(env.seedPartnerPassword),
        createdAt: new Date().toISOString(),
        partnerId: env.seedPartnerId,
      };
      await store.saveStaff(seeded);
    }
  }
}
```

- [ ] **Step 3: Update `.env.example`**

Append at the bottom (under a `# P3 — partner-staff seed (optional)` heading):

```
# P3 — partner-staff seed (optional). Set together to seed a partner-scoped
# staff member on first request. Used by the Playwright E2E smoke.
SEED_PARTNER_USERNAME=
SEED_PARTNER_PASSWORD=
SEED_PARTNER_ID=
```

- [ ] **Step 4: Extend `tests/seed.test.ts` (or add a new file if seed.test.ts doesn't exist)**

Check if `tests/seed.test.ts` exists:

Run: `ls tests/seed.test.ts 2>&1`

If yes, append; if no, create:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

const redis = fakeRedis();
const envOverrides: Record<string, string> = {};
vi.mock('@/lib/env', () => ({
  env: new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'seedAdminUsername') return envOverrides.SEED_ADMIN_USERNAME ?? 'admin';
      if (prop === 'seedAdminPassword') return envOverrides.SEED_ADMIN_PASSWORD ?? 'pw';
      if (prop === 'seedPartnerUsername') return envOverrides.SEED_PARTNER_USERNAME ?? '';
      if (prop === 'seedPartnerPassword') return envOverrides.SEED_PARTNER_PASSWORD ?? '';
      if (prop === 'seedPartnerId') return envOverrides.SEED_PARTNER_ID ?? '';
      return '';
    },
  }),
}));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => actual.createPartnerStore(redis) };
});

import { ensureSeedAdmin } from '@/lib/seed';
import { createAuthStore } from '@/lib/auth-store';

beforeEach(() => { redis.dump.clear(); for (const k of Object.keys(envOverrides)) delete envOverrides[k]; });
afterEach(() => vi.clearAllMocks());

describe('ensureSeedAdmin', () => {
  it('seeds the platform admin when no staff exist', async () => {
    await ensureSeedAdmin();
    const got = await createAuthStore(redis).getStaff('admin');
    expect(got?.role).toBe('admin');
    expect(got?.partnerId).toBeUndefined();
  });

  it('also seeds a partner staff when partner-seed env vars are set', async () => {
    envOverrides.SEED_PARTNER_USERNAME = 'p1';
    envOverrides.SEED_PARTNER_PASSWORD = 'hunter2';
    envOverrides.SEED_PARTNER_ID = 'acme';
    await ensureSeedAdmin();
    const got = await createAuthStore(redis).getStaff('p1');
    expect(got?.partnerId).toBe('acme');
    expect(got?.role).toBe('admin');
  });

  it('is idempotent on the partner-staff branch', async () => {
    envOverrides.SEED_PARTNER_USERNAME = 'p1';
    envOverrides.SEED_PARTNER_PASSWORD = 'hunter2';
    envOverrides.SEED_PARTNER_ID = 'acme';
    await ensureSeedAdmin();
    await ensureSeedAdmin();          // second call no-ops
    const all = await createAuthStore(redis).listStaff();
    expect(all.filter((s) => s.username === 'p1')).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/seed.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/env.ts src/lib/seed.ts .env.example tests/seed.test.ts
git commit -m "feat(P3): optional partner-staff seed for E2E"
```

---

## Task 15: E2E smoke — partner-scoped login case

**Goal:** Playwright proves a seeded partner staff sees only their data and is redirected away from platform pages.

**Files:**
- Modify: `tests/e2e/dashboard-smoke.spec.ts`

- [ ] **Step 1: Append a second Playwright test**

Edit `tests/e2e/dashboard-smoke.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// `||` not `??`: GitHub Actions sets env vars to empty string when the
// referenced secret doesn't exist, and `??` only falls back on undefined.
const USERNAME = process.env.E2E_USERNAME || 'forextransfer';
const PASSWORD = process.env.E2E_PASSWORD || 'forex@123';

const PARTNER_USERNAME = process.env.E2E_PARTNER_USERNAME || '';
const PARTNER_PASSWORD = process.env.E2E_PARTNER_PASSWORD || '';
const PARTNER_ID = process.env.E2E_PARTNER_ID || '';

test('staff can log in and reach dashboard pages', async ({ page }) => {
  // ... existing test body unchanged ...
});

test('partner-scoped staff is restricted to their partner', async ({ page }) => {
  test.skip(
    !PARTNER_USERNAME || !PARTNER_PASSWORD || !PARTNER_ID,
    'partner-seed env vars not configured',
  );

  await page.goto('/login');
  await page.getByLabel(/username/i).fill(PARTNER_USERNAME);
  await page.getByLabel(/password/i).fill(PARTNER_PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/dashboard/);

  // Sidebar: should NOT contain "Partners" (list) or "Team" links.
  // (Stricter contains-text assertion avoids matching "My partner" via "Partners".)
  const sidebar = page.locator('aside.sh-sidebar');
  await expect(sidebar.getByRole('link', { name: /^team$/i })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: /^partners$/i })).toHaveCount(0);

  // Sidebar: SHOULD contain "My partner".
  await expect(sidebar.getByRole('link', { name: /my partner/i })).toBeVisible();

  // Visiting /dashboard/partners redirects to /dashboard/partners/<id>.
  await page.goto('/dashboard/partners');
  await expect(page).toHaveURL(new RegExp(`/dashboard/partners/${PARTNER_ID}$`));

  // Visiting /dashboard/team redirects to /dashboard.
  await page.goto('/dashboard/team');
  await expect(page).toHaveURL(/\/dashboard\/?$/);
});
```

Per the user's answer to the gate question, `E2E_PARTNER_*` will be present on Vercel before the PR merges, so the `test.skip` is a defensive belt-and-braces for local Playwright runs without the env vars — CI runs it hard.

- [ ] **Step 2: Local smoke (optional)**

If you have local Playwright + dev server running:

```bash
E2E_PARTNER_USERNAME=p1 E2E_PARTNER_PASSWORD=hunter2 E2E_PARTNER_ID=acme \
  SEED_PARTNER_USERNAME=p1 SEED_PARTNER_PASSWORD=hunter2 SEED_PARTNER_ID=acme \
  npx playwright test tests/e2e/dashboard-smoke.spec.ts
```

Expected: both tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/dashboard-smoke.spec.ts
git commit -m "test(P3): E2E smoke partner-scoped login case"
```

---

## Task 16: Final type + suite verification, then push the branch

- [ ] **Step 1: Full typecheck + lint + vitest + build**

Run, in order:

```bash
npx tsc --noEmit
npm run lint
npx vitest run
npx next build --turbopack
```

Each should exit 0. The build's `next build` output should not contain new warnings.

- [ ] **Step 2: Confirm test count delta**

`npx vitest run` should print roughly 385 tests (354 baseline + ~31 new). Tolerable range: 380–390. If significantly off, find the missing or duplicate tests before pushing.

- [ ] **Step 3: Push the branch**

```bash
git push origin spec/p3-partner-sub-admin
```

(Branch already exists on the remote with the spec commit.)

- [ ] **Step 4: Open the PR via `gh`**

```bash
gh pr create --title "feat(P3): per-partner sub-admin auth + dashboard scoping" --body "$(cat <<'EOF'
## Summary
- Adds `createScopedStore(staff)` chokepoint: every dashboard page now reads via the scoped facade, which auto-filters by `staff.partnerId`.
- Suspended-partner enforcement at three points: login refusal, mid-session bounce in `getCurrentStaff()`, proactive session revocation on partner suspend.
- `Schedule.partnerId` becomes required; sentinel-guarded `backfillSchedulesOnce` migration backfills legacy records (lazy-fill on read + cron-driven persist).
- Partner-staff CRUD on `/dashboard/partners/[id]` (admins only).
- Sidebar gated by `visibleNavItems(staff)`; `/dashboard/team` re-gated to `requirePlatformAdmin`.
- Optional partner-staff seed (`SEED_PARTNER_USERNAME`/`PASSWORD`/`ID`) for E2E.
- Playwright smoke gains a partner-scoped login case.

## Customer-facing impact
None. The WhatsApp bot is untouched. `tests/bot-content-guard.test.ts` still enforces the "no partner concept in customer content" hard rule.

## Test plan
- [ ] CI green (`ci / ci` required check on this branch)
- [ ] After merge: curl `/api/cron?secret=<CRON_SECRET>` once so `backfillSchedulesOnce` claims its sentinel; confirm JSON response shows `schedulePartnerBackfill.skippedSentinel: false` on the first call, then `true` on subsequent calls.
- [ ] Production smoke (auto): platform admin login + nav.
- [ ] Production smoke (auto): partner-staff login → restricted view, redirects from `/dashboard/team` and `/dashboard/partners`.
- [ ] Manual eyeball: suspend a real partner from the dashboard, confirm its staff bounces to `/login` on next click.

## Migration ops
1. Merge PR → Vercel auto-deploys.
2. Curl `/api/cron?secret=<CRON_SECRET>` once (or wait for the next scheduled cron tick).
3. The four sentinels (`customer-backfill-v1`, `country-currency-backfill-v1`, `partner-backfill-v1`, `schedule-partner-backfill-v1`) will be claimed in sequence; subsequent runs are no-ops.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Wait for the `ci / ci` check, then ask the user before merging**

The plan ends here. The user merges the PR when they're satisfied; Vercel auto-deploys; smoke runs.

---

## Post-merge runbook (for the user, not the agent)

1. **Add the new Vercel env vars (one-time):**
   - `SEED_PARTNER_USERNAME` — pick a username (e.g. `partner-acme`)
   - `SEED_PARTNER_PASSWORD` — strong password
   - `SEED_PARTNER_ID` — pick an existing partner id (use `default`, or create a fresh partner via the dashboard first and copy its 8-char id from the URL)
   - `E2E_PARTNER_USERNAME` / `E2E_PARTNER_PASSWORD` / `E2E_PARTNER_ID` — same values as above (for the smoke test)
2. **After deploy:** `curl -H "Authorization: Bearer $CRON_SECRET" https://claude-payments.vercel.app/api/cron` once to claim `schedule-partner-backfill-v1`.
3. **Verify:** Log in as the new partner staff. Confirm you see only their data, can't reach `/dashboard/team` or `/dashboard/partners` (list).
4. **Suspend test:** Suspend the partner from a platform-admin session in a different browser. Confirm the partner-staff browser bounces to `/login` on the next click.

---

## Self-review

(This section is the agent's own checklist — leave it intact so a reader can see how the plan was reviewed.)

**Spec coverage walkthrough:**

- Spec §1 Architecture (role × scope matrix, `createScopedStore` chokepoint, migration shape) → Tasks 1, 6, 5
- Spec §2 Type changes + new modules (`staff-scope.ts`, `scoped-store.ts`, `auth.ts` extensions) → Tasks 1, 6, 7
- Spec §2 `Schedule.partnerId` required + lazy-fill → Tasks 3, 4
- Spec §3 Sidebar gating + page swaps + Partner column/filter hide + URL redirects → Tasks 11, 13, 10
- Spec §3 Staff CRUD on partner detail page → Tasks 9, 10
- Spec §3 `/dashboard/team` re-gated → Task 12
- Spec §4 Login refusal of suspended partner → Task 8
- Spec §4 Mid-session bounce via `getCurrentStaff` → Task 7
- Spec §4 Proactive session revocation in `setPartnerStatusAction` → Task 9
- Spec §4 `deleteAllSessionsFor` + reverse-index → Task 2
- Spec §5 Test plan (8 unit-test files + extended migration + extended partners-actions) → Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 14
- Spec §5 E2E smoke partner case → Task 15
- Spec §5 Seeded partner staff → Task 14
- Spec §6 CI/CD ship pipeline → Task 16

**Placeholder scan:** No "TODO"/"TBD"/"implement later"/"similar to Task N" markers. Every step has either real code or an explicit grep/command with expected output.

**Type consistency:** `Schedule.partnerId: PartnerId` (required) declared in Task 3; consumed by `createScheduleTool` (Task 4), `backfillSchedulesOnce` (Task 5), `createScopedStore.listSchedules` (Task 6), `scheduleStore.getSchedule` lazy-fill (Task 3). `Scope` discriminated union (`{ kind: 'platform' } | { kind: 'partner'; partnerId: PartnerId }`) declared in Task 1, consumed in Task 6 (`scoped.scope`), Task 7 (`requireScope`), Task 13 (page-level `scoped.scope.kind === 'partner'` gating). `requirePlatformAdmin` consistent across Tasks 7, 9, 12. `deleteAllSessionsFor(username: string): Promise<void>` consistent across Tasks 2, 7 (auth.ts uses it indirectly via getCurrentStaff bounce — not directly), 9 (partner-actions). `createPartnerStaffAction(partnerId: PartnerId, formData: FormData): Promise<void>` consistent across Tasks 9, 10. `removePartnerStaffAction(formData: FormData): Promise<void>` consistent across Tasks 9, 10.

**No spec requirement is unimplemented.** The whitelabel/branding placeholder (`Partner.brandName`/`primaryColor`/`logoUrl`) is explicitly deferred in spec §7 and not touched here. Audit log is deferred to P5. Password reset / invite emails deferred.
