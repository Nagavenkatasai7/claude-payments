# Customer Profile + New-Account Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-sender `Customer` record + three-tier cap system (T0 new with $500/day for 3 days · T1 verified with $2,999/day · Suspended) + KYC provider abstraction (mock now, Persona later) + dashboard pages to manage it all.

**Architecture:** Two new Redis primitives (durable `customer:<phone>` record + 48h-TTL `daily_volume:<phone>:<easternDate>` cents counter). One pure-function module (`tier-rules.ts`) is the canonical source of truth for cap math. One new agent tool (`check_send_limit`) + cap enforcement at three layers (`check_send_limit` → `send_approve_picker` → `create_transfer`). `TurnContext` gains server-controlled `isNewCustomer` + `tierReminderDayOfWindow` flags the LLM cannot fabricate. Grandfather migration runs from cron with a lazy fallback in the webhook.

**Tech Stack:** Next.js 16 App Router on Vercel, TypeScript, Upstash Redis (`INCRBY`/`EXPIRE`), Vitest, Ollama Cloud + Kimi K2.6 agent loop, Meta WhatsApp Cloud API, Recharts (unchanged).

**Spec:** [docs/superpowers/specs/2026-05-24-customer-profile-tier-design.md](../specs/2026-05-24-customer-profile-tier-design.md)

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add `Customer`, `Tier`, `CapEvaluation`, `KycStatus` (re-export); extend `TurnContext` with `isNewCustomer` + `tierReminderDayOfWindow`. |
| `src/lib/tier-rules.ts` | **Create** | Pure functions `deriveTier`, `evaluateCap`, plus constants. Only place cap math lives. |
| `src/lib/customer-store.ts` | **Create** | `getCustomer`, `saveCustomer`, `upsertOnFirstInbound`, `listCustomers`. Lazy grandfather detection by peeking at `store.listTransfers()`. |
| `src/lib/daily-volume-store.ts` | **Create** | `addCents` (INCRBY + EXPIRE 48h), `getTodayCents`. |
| `src/lib/providers/kyc-provider.ts` | **Create** | `KycProvider` interface + `KycStatus`/`KycStartResult`/`KycVerifiedFields` types. |
| `src/lib/providers/mock-kyc-provider.ts` | **Create** | `MockKycProvider` — `startVerification` returns dashboard URL; `getStatus` reads from Customer; `handleWebhook` returns null. |
| `src/lib/tools.ts` | Modify | Add `check_send_limit` schema + impl. Modify `send_approve_picker` + `create_transfer` to call `evaluateCap` + (create_transfer only) call `dailyVolumeStore.addCents`. Extend `ToolContext` with `customerStore`, `dailyVolumeStore`, `kycProvider`. |
| `src/lib/agent.ts` | Modify | `AgentDeps` gains `customerStore`, `dailyVolumeStore`, `kycProvider`. Inject `[NEW CUSTOMER]` and `[TIER_REMINDER day N/3]` system notes on round 0 (alongside existing `[NEW CONVERSATION]`). |
| `src/lib/prompt.ts` | Modify | Append `NEW-CUSTOMER ONBOARDING & SENDING LIMITS` section. |
| `src/app/api/whatsapp/route.ts` | Modify | Call `customerStore.upsertOnFirstInbound`; compute `tierReminderDayOfWindow`; pass `isNewCustomer` + `tierReminderDayOfWindow` into `TurnContext`. Wire new stores + provider into `createAgent`. |
| `src/app/api/cron/route.ts` | Modify | Add `backfillCustomersOnce(...)` step before `runDueSchedules`. Support `?force=true` query param (still requires `CRON_SECRET`). |
| `src/lib/migration.ts` | **Create** | Pure `backfillCustomersOnce(store, customerStore)` function — sentinel-guarded. Easier to unit-test outside the route. |
| `src/app/dashboard/sidebar.tsx` | Modify | Add `Customers` nav item; extend `SidebarActive`. |
| `src/app/dashboard/customers/page.tsx` | **Create** | List view + tier badges + lifetime sent + sortable. `force-dynamic`. |
| `src/app/dashboard/customers/[phone]/page.tsx` | **Create** | Detail view + admin-only Mark verified / Mark rejected forms. |
| `src/app/dashboard/customers/actions.ts` | **Create** | `markCustomerVerifiedAction`, `markCustomerRejectedAction` — `requireAdmin`. |
| `src/app/dashboard/transactions-tabs.tsx` | Modify | Add `Tier` column between `Phone` and `Amount`; accept `tierByPhone: Record<string, Tier>` prop. |
| `src/app/dashboard/transactions/page.tsx` | Modify | After `listTransfers()`, also `listCustomers()`, build `tierByPhone` map, pass through. |
| `src/app/globals.css` | Modify | Three small tier-badge color variants. |
| `tests/tier-rules.test.ts` | **Create** | ~15 unit cases. |
| `tests/customer-store.test.ts` | **Create** | CRUD + idempotency + grandfather detection. |
| `tests/daily-volume-store.test.ts` | **Create** | Round-trip, isolation per phone, isolation per day. |
| `tests/kyc-provider.test.ts` | **Create** | MockKycProvider behavior. |
| `tests/migration.test.ts` | **Create** | Backfill creates grandfathered records, sentinel makes idempotent. |
| `tests/tools.test.ts` | Modify | `check_send_limit` cases + cap-enforcement on `send_approve_picker` + daily-volume incr on `create_transfer`. |
| `tests/agent.test.ts` | Modify | `[NEW CUSTOMER]` + `[TIER_REMINDER]` system-note injection tests. |
| `tests/e2e.test.ts` | Modify | New-customer e2e: greeted → over-cap → under-cap → approve → mark verified → day-4 → T1 flow. |
| `tests/e2e/dashboard-smoke.spec.ts` | Modify | Navigate to `/dashboard/customers` and assert table renders. |

---

## Task 1: Types + TurnContext extension

**Files:**
- Modify: `src/lib/types.ts`

Types-only task. Compiler is the test. Later tasks (2+) need these. PR #5 used the same pattern.

- [ ] **Step 1: Append the new types to `src/lib/types.ts`**

At the end of `src/lib/types.ts`, after the existing `IncomingMessage` union, add:

```ts
export type KycStatus =
  | 'not_started'
  | 'pending'
  | 'verified'
  | 'rejected'
  | 'grandfathered';

export interface Customer {
  senderPhone: string;
  firstSeenAt: string;       // ISO-8601, set on first inbound
  kycStatus: KycStatus;
  kycVerifiedAt?: string;
  kycProviderRef?: string;
  kycRejectedReason?: string;
  fullName?: string;
  dateOfBirth?: string;
  country?: string;
  createdAt: string;
  updatedAt: string;
}

export type Tier = 'T0' | 'T1' | 'Suspended';

export type CapReason =
  | 'verification_required_after_window'
  | 'verification_rejected'
  | 'over_per_transfer_cap'
  | 'over_daily_cap';

export interface CapEvaluation {
  withinCap: boolean;
  tier: Tier;
  dailyCapCents: number;
  perTransferCapCents: number;
  todayUsedCents: number;
  todayRemainingCents: number;
  reason?: CapReason;
  dayOfWindow?: number;   // 1, 2, or 3 — present only when tier === 'T0'
}
```

Now extend the existing `TurnContext` (added by PR #5). Find:

```ts
export interface TurnContext {
  isNewConversation: boolean;
  buttonTap?: ButtonTap;
}
```

Replace with:

```ts
export interface TurnContext {
  isNewConversation: boolean;
  buttonTap?: ButtonTap;
  isNewCustomer?: boolean;              // true only on the first inbound from a brand-new phone (never grandfathered)
  tierReminderDayOfWindow?: 1 | 2 | 3;  // T0 + new conversation + not new-customer → which day of the 3-day window
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers of the new types yet).

- [ ] **Step 3: Commit**

```bash
git checkout -b feat/customer-profile-tier
git add src/lib/types.ts
git commit -m "types: add Customer, Tier, CapEvaluation, KycStatus; extend TurnContext"
```

---

## Task 2: `tier-rules.ts` pure functions

**Files:**
- Create: `src/lib/tier-rules.ts`
- Test: `tests/tier-rules.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/tier-rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  deriveTier,
  evaluateCap,
  T0_DAILY_CAP_CENTS,
  T1_DAILY_CAP_CENTS,
  OBSERVATION_WINDOW_MS,
} from '@/lib/tier-rules';
import type { Customer } from '@/lib/types';

function customer(overrides: Partial<Customer> & { firstSeenAt: string }): Customer {
  return {
    senderPhone: '15551234567',
    firstSeenAt: overrides.firstSeenAt,
    kycStatus: 'not_started',
    createdAt: overrides.firstSeenAt,
    updatedAt: overrides.firstSeenAt,
    ...overrides,
  };
}

const SIGN_UP = new Date('2026-05-20T12:00:00Z');
const DAY_2  = new Date('2026-05-21T12:00:00Z');
const DAY_3  = new Date('2026-05-22T12:00:00Z');
const DAY_4  = new Date('2026-05-23T12:00:01Z'); // 3 days + 1 second
const EXACT_3_DAYS = new Date(SIGN_UP.getTime() + OBSERVATION_WINDOW_MS); // exact boundary

describe('deriveTier', () => {
  it('returns T0 during the 3-day window regardless of KYC status', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'not_started' }), DAY_2)).toBe('T0');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' }), DAY_2)).toBe('T0');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' }), DAY_2)).toBe('T0');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'grandfathered' }), DAY_2)).toBe('T0');
  });

  it('returns Suspended any time kycStatus is rejected (even in window)', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' }), DAY_2)).toBe('Suspended');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' }), DAY_4)).toBe('Suspended');
  });

  it('returns T1 on day 4+ for verified or grandfathered customers', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' }), DAY_4)).toBe('T1');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'grandfathered' }), DAY_4)).toBe('T1');
  });

  it('returns Suspended on day 4+ for unverified customers', () => {
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'not_started' }), DAY_4)).toBe('Suspended');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' }), DAY_4)).toBe('Suspended');
  });

  it('exact-3-day-boundary is OUT of window (T0 ends, T1 or Suspended begins)', () => {
    // exact ageMs === OBSERVATION_WINDOW_MS → in_window = false
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' }), EXACT_3_DAYS)).toBe('T1');
    expect(deriveTier(customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' }), EXACT_3_DAYS)).toBe('Suspended');
  });
});

describe('evaluateCap', () => {
  it('T0 customer with no spending today + small request → within cap', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 0, 10_000); // $100 requested
    expect(r.withinCap).toBe(true);
    expect(r.tier).toBe('T0');
    expect(r.dailyCapCents).toBe(T0_DAILY_CAP_CENTS);
    expect(r.todayUsedCents).toBe(0);
    expect(r.todayRemainingCents).toBe(T0_DAILY_CAP_CENTS);
    expect(r.dayOfWindow).toBe(2);
  });

  it('T0 customer over the per-transfer cap', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 0, 60_000); // $600
    expect(r.withinCap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
  });

  it('T0 customer over the daily cap (cumulative)', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 30_000, 30_000); // $300 already, requesting $300 more = $600
    expect(r.withinCap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.todayRemainingCents).toBe(20_000); // $200 left
  });

  it('T0 customer at exactly the daily cap → within', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 30_000, 20_000); // $300 + $200 = $500 exactly
    expect(r.withinCap).toBe(true);
  });

  it('T1 customer can send up to the higher cap', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' });
    const r = evaluateCap(c, DAY_4, 0, 200_000); // $2,000
    expect(r.withinCap).toBe(true);
    expect(r.tier).toBe('T1');
    expect(r.dailyCapCents).toBe(T1_DAILY_CAP_CENTS);
  });

  it('Suspended (day 4 unverified) → not within, reason = verification_required_after_window', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_4, 0, 1_000);
    expect(r.withinCap).toBe(false);
    expect(r.tier).toBe('Suspended');
    expect(r.reason).toBe('verification_required_after_window');
    expect(r.dailyCapCents).toBe(0);
  });

  it('Suspended (rejected) → not within, reason = verification_rejected', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' });
    const r = evaluateCap(c, DAY_2, 0, 1_000);
    expect(r.withinCap).toBe(false);
    expect(r.reason).toBe('verification_rejected');
  });

  it('zero-request returns within=true (status-only check)', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    const r = evaluateCap(c, DAY_2, 0, 0);
    expect(r.withinCap).toBe(true);
    expect(r.todayRemainingCents).toBe(T0_DAILY_CAP_CENTS);
  });

  it('dayOfWindow is 1 on signup day, 2 on day 2, 3 on day 3', () => {
    const c = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'pending' });
    expect(evaluateCap(c, SIGN_UP, 0, 0).dayOfWindow).toBe(1);
    expect(evaluateCap(c, DAY_2, 0, 0).dayOfWindow).toBe(2);
    expect(evaluateCap(c, DAY_3, 0, 0).dayOfWindow).toBe(3);
  });

  it('dayOfWindow is undefined for T1 and Suspended', () => {
    const verified = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'verified' });
    expect(evaluateCap(verified, DAY_4, 0, 0).dayOfWindow).toBeUndefined();
    const suspended = customer({ firstSeenAt: SIGN_UP.toISOString(), kycStatus: 'rejected' });
    expect(evaluateCap(suspended, DAY_2, 0, 0).dayOfWindow).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tier-rules`
Expected: FAIL — `Cannot find module '@/lib/tier-rules'`.

- [ ] **Step 3: Create `src/lib/tier-rules.ts`**

```ts
import type { Customer, Tier, CapEvaluation } from './types';

export const T0_DAILY_CAP_CENTS = 50_000;   // $500.00
export const T1_DAILY_CAP_CENTS = 299_900;  // $2,999.00
export const OBSERVATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function deriveTier(customer: Customer, now: Date): Tier {
  if (customer.kycStatus === 'rejected') return 'Suspended';
  const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
  const inWindow = ageMs < OBSERVATION_WINDOW_MS;
  if (inWindow) return 'T0';
  if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'T1';
  return 'Suspended';
}

export function evaluateCap(
  customer: Customer,
  now: Date,
  todayUsedCents: number,
  requestedCents: number,
): CapEvaluation {
  const tier = deriveTier(customer, now);
  const dailyCapCents =
    tier === 'T0' ? T0_DAILY_CAP_CENTS :
    tier === 'T1' ? T1_DAILY_CAP_CENTS :
    0;
  const perTransferCapCents = dailyCapCents;
  const todayRemainingCents = Math.max(0, dailyCapCents - todayUsedCents);

  let dayOfWindow: number | undefined;
  if (tier === 'T0') {
    const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
    dayOfWindow = Math.min(3, Math.floor(ageMs / (24 * 60 * 60 * 1000)) + 1);
  }

  const base = {
    tier,
    dailyCapCents,
    perTransferCapCents,
    todayUsedCents,
    todayRemainingCents,
    dayOfWindow,
  };

  if (tier === 'Suspended') {
    const reason = customer.kycStatus === 'rejected'
      ? 'verification_rejected' as const
      : 'verification_required_after_window' as const;
    return { ...base, withinCap: false, reason };
  }
  if (requestedCents > perTransferCapCents) {
    return { ...base, withinCap: false, reason: 'over_per_transfer_cap' };
  }
  if (requestedCents > todayRemainingCents) {
    return { ...base, withinCap: false, reason: 'over_daily_cap' };
  }
  return { ...base, withinCap: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tier-rules`
Expected: PASS (all 15 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tier-rules.ts tests/tier-rules.test.ts
git commit -m "tier-rules: pure deriveTier + evaluateCap with constants for T0/T1 caps"
```

---

## Task 3: `customer-store.ts`

**Files:**
- Create: `src/lib/customer-store.ts`
- Test: `tests/customer-store.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/customer-store.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { createTransfer } from '@/lib/transfer-create';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

const PHONE = '15551234567';

afterEach(() => vi.restoreAllMocks());

describe('customer store', () => {
  it('getCustomer returns null when no record', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });

  it('saveCustomer + getCustomer round-trips', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const c = {
      senderPhone: PHONE,
      firstSeenAt: '2026-05-24T12:00:00Z',
      kycStatus: 'not_started' as const,
      createdAt: '2026-05-24T12:00:00Z',
      updatedAt: '2026-05-24T12:00:00Z',
    };
    await cs.saveCustomer(c);
    expect(await cs.getCustomer(PHONE)).toEqual(c);
  });

  it('upsertOnFirstInbound creates a brand-new customer (wasCreated=true) when no transfers exist', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE);
    expect(wasCreated).toBe(true);
    expect(customer.kycStatus).toBe('not_started');
    expect(customer.senderPhone).toBe(PHONE);
    expect(new Date(customer.firstSeenAt).toString()).not.toBe('Invalid Date');
  });

  it('upsertOnFirstInbound is idempotent: second call returns existing record with wasCreated=false', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    const first = await cs.upsertOnFirstInbound(PHONE);
    const second = await cs.upsertOnFirstInbound(PHONE);
    expect(second.wasCreated).toBe(false);
    expect(second.customer.firstSeenAt).toBe(first.customer.firstSeenAt);
  });

  it('upsertOnFirstInbound grandfathers a phone with existing transfers (wasCreated=false)', async () => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    // Pre-existing transfer (e.g. from before this batch shipped)
    await createTransfer(store, {
      phone: PHONE,
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    const cs = createCustomerStore(fakeRedis(), store);
    const { customer, wasCreated } = await cs.upsertOnFirstInbound(PHONE);
    expect(wasCreated).toBe(false); // grandfathered, not a "real" new customer
    expect(customer.kycStatus).toBe('grandfathered');
    expect(customer.kycVerifiedAt).toBeDefined();
    // firstSeenAt anchored to the oldest existing transfer
    expect(customer.firstSeenAt).not.toBe(customer.updatedAt);
  });

  it('listCustomers returns every saved customer', async () => {
    const store = createStore(fakeRedis());
    const cs = createCustomerStore(fakeRedis(), store);
    await cs.upsertOnFirstInbound('15551111111');
    await cs.upsertOnFirstInbound('15552222222');
    const all = await cs.listCustomers();
    expect(all.map((c) => c.senderPhone).sort()).toEqual(['15551111111', '15552222222']);
  });

  it('returns null on JSON corruption rather than throwing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    await redis.set(`customer:${PHONE}`, 'not-json');
    const cs = createCustomerStore(redis, store);
    expect(await cs.getCustomer(PHONE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- customer-store`
Expected: FAIL — `Cannot find module '@/lib/customer-store'`.

- [ ] **Step 3: Create `src/lib/customer-store.ts`**

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike, Store } from './store';
import type { Customer } from './types';

export function createCustomerStore(redis: RedisLike, store: Store) {
  return {
    async getCustomer(senderPhone: string): Promise<Customer | null> {
      const raw = await redis.get(`customer:${senderPhone}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Customer;
      } catch {
        return null;
      }
    },

    async saveCustomer(customer: Customer): Promise<void> {
      await redis.set(`customer:${customer.senderPhone}`, JSON.stringify(customer));
      await redis.sadd('customers:phones', customer.senderPhone);
    },

    async upsertOnFirstInbound(
      senderPhone: string,
    ): Promise<{ customer: Customer; wasCreated: boolean }> {
      const existing = await this.getCustomer(senderPhone);
      if (existing) return { customer: existing, wasCreated: false };

      // Lazy grandfather: peek at existing transfers
      const transfers = await store.listTransfers();
      const minAt = transfers
        .filter((t) => t.phone === senderPhone)
        .map((t) => t.createdAt)
        .sort()[0];

      const nowIso = new Date().toISOString();
      const customer: Customer = minAt
        ? {
            senderPhone,
            firstSeenAt: minAt,
            kycStatus: 'grandfathered',
            kycVerifiedAt: nowIso,
            createdAt: minAt,
            updatedAt: nowIso,
          }
        : {
            senderPhone,
            firstSeenAt: nowIso,
            kycStatus: 'not_started',
            createdAt: nowIso,
            updatedAt: nowIso,
          };

      await this.saveCustomer(customer);
      return { customer, wasCreated: !minAt };
    },

    async listCustomers(): Promise<Customer[]> {
      const phones = await redis.smembers('customers:phones');
      const all = await Promise.all(phones.map((p) => this.getCustomer(p)));
      return all.filter((c): c is Customer => c !== null);
    },
  };
}

export type CustomerStore = ReturnType<typeof createCustomerStore>;

let cached: CustomerStore | null = null;

export function getCustomerStore(store: Store): CustomerStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createCustomerStore(redis as unknown as RedisLike, store);
  }
  return cached;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- customer-store`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add src/lib/customer-store.ts tests/customer-store.test.ts
git commit -m "customer-store: get/save/upsert/list + lazy grandfather detection"
```

---

## Task 4: `daily-volume-store.ts`

**Files:**
- Create: `src/lib/daily-volume-store.ts`
- Test: `tests/daily-volume-store.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/daily-volume-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';
const OTHER = '15559999999';

beforeEach(() => {
  // Pin time to a known ET date for deterministic key naming
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-24T18:00:00Z')); // 2pm ET
});
afterEach(() => vi.useRealTimers());

describe('daily-volume store', () => {
  it('getTodayCents returns 0 when no spend recorded', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    expect(await dvs.getTodayCents(PHONE)).toBe(0);
  });

  it('addCents + getTodayCents round-trips', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 30_000); // $300
    expect(await dvs.getTodayCents(PHONE)).toBe(30_000);
  });

  it('multiple addCents calls accumulate', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 10_000);
    await dvs.addCents(PHONE, 25_000);
    expect(await dvs.getTodayCents(PHONE)).toBe(35_000);
  });

  it('isolates per phone', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 30_000);
    expect(await dvs.getTodayCents(OTHER)).toBe(0);
  });

  it('isolates per ET calendar day', async () => {
    const dvs = createDailyVolumeStore(fakeRedis());
    await dvs.addCents(PHONE, 30_000);
    vi.setSystemTime(new Date('2026-05-25T18:00:00Z')); // next day 2pm ET
    expect(await dvs.getTodayCents(PHONE)).toBe(0);
  });

  it('addCents sets a 48h TTL', async () => {
    const redis = fakeRedis();
    const dvs = createDailyVolumeStore(redis);
    let lastOpts: { ex?: number } | undefined;
    const origSet = redis.set.bind(redis);
    redis.set = async (k, v, o) => {
      lastOpts = o;
      return origSet(k, v, o);
    };
    await dvs.addCents(PHONE, 1);
    // The fakeRedis impl uses set+incr or a direct counter — capture TTL on the set path
    // If incr is used internally, this assertion verifies the EXPIRE call instead — see impl note.
    expect(true).toBe(true); // sentinel; implementation hint below
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- daily-volume-store`
Expected: FAIL — `Cannot find module '@/lib/daily-volume-store'`.

- [ ] **Step 3: Create `src/lib/daily-volume-store.ts`**

The fake redis has `incr` but not `expire`. We can avoid `expire` by NOT using `incr` — instead we compute the new total in app code and use `set` with an `ex`. Atomicity matters less here (single sender, serialized inbounds).

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import { easternDate } from './dates';
import type { RedisLike } from './store';

const DAY_TTL_SECONDS = 48 * 60 * 60; // keep yesterday around for one day for late audits

export function createDailyVolumeStore(redis: RedisLike) {
  function key(senderPhone: string): string {
    return `daily_volume:${senderPhone}:${easternDate(Date.now())}`;
  }

  return {
    async getTodayCents(senderPhone: string): Promise<number> {
      const raw = await redis.get(key(senderPhone));
      return raw ? Number(raw) : 0;
    },

    async addCents(senderPhone: string, cents: number): Promise<void> {
      const k = key(senderPhone);
      const current = Number((await redis.get(k)) ?? '0');
      await redis.set(k, String(current + cents), { ex: DAY_TTL_SECONDS });
    },
  };
}

export type DailyVolumeStore = ReturnType<typeof createDailyVolumeStore>;

let cached: DailyVolumeStore | null = null;

export function getDailyVolumeStore(): DailyVolumeStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createDailyVolumeStore(redis as unknown as RedisLike);
  }
  return cached;
}
```

Update the TTL test in step 1 to verify the SET call carries `ex: 172800`. Replace the last `it(...)` block with:

```ts
  it('addCents sets a 48h TTL on the day key', async () => {
    const redis = fakeRedis();
    let capturedOpts: { ex?: number } | undefined;
    const origSet = redis.set.bind(redis);
    redis.set = async (k, v, o) => {
      if (k.startsWith('daily_volume:')) capturedOpts = o;
      return origSet(k, v, o);
    };
    const dvs = createDailyVolumeStore(redis);
    await dvs.addCents(PHONE, 1);
    expect(capturedOpts?.ex).toBe(48 * 60 * 60);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- daily-volume-store`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/daily-volume-store.ts tests/daily-volume-store.test.ts
git commit -m "daily-volume-store: per-day cents counter with 48h TTL"
```

---

## Task 5: `KycProvider` interface + `MockKycProvider`

**Files:**
- Create: `src/lib/providers/kyc-provider.ts`
- Create: `src/lib/providers/mock-kyc-provider.ts`
- Test: `tests/kyc-provider.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/kyc-provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

const PHONE = '15551234567';

describe('MockKycProvider', () => {
  it('startVerification returns a URL pointing at the dashboard customer page and a providerRef', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    const provider = new MockKycProvider(cs, 'https://example.com');
    const r = await provider.startVerification({ customerId: PHONE, senderPhone: PHONE });
    expect(r.url).toBe(`https://example.com/dashboard/customers/${PHONE}`);
    expect(r.providerRef).toBe(`mock-${PHONE}`);
  });

  it('getStatus reads from the customer record', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    await cs.upsertOnFirstInbound(PHONE);
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.getStatus(`mock-${PHONE}`)).toBe('pending'); // not_started maps to pending
    await cs.saveCustomer({
      ...(await cs.getCustomer(PHONE))!,
      kycStatus: 'verified',
    });
    expect(await provider.getStatus(`mock-${PHONE}`)).toBe('verified');
  });

  it('getStatus returns pending for unknown providerRef', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.getStatus('mock-unknown-phone')).toBe('pending');
  });

  it('handleWebhook always returns null (no real webhooks in mock mode)', async () => {
    const cs = createCustomerStore(fakeRedis(), createStore(fakeRedis()));
    const provider = new MockKycProvider(cs, 'https://example.com');
    expect(await provider.handleWebhook({ anything: true })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- kyc-provider`
Expected: FAIL — `Cannot find module '@/lib/providers/mock-kyc-provider'`.

- [ ] **Step 3: Create `src/lib/providers/kyc-provider.ts`**

```ts
export type KycStatus = 'pending' | 'verified' | 'rejected';

export interface KycStartResult {
  url: string;
  providerRef: string;
}

export interface KycVerifiedFields {
  fullName?: string;
  dateOfBirth?: string;
  country?: string;
}

export interface KycWebhookResult {
  providerRef: string;
  status: KycStatus;
  fields?: KycVerifiedFields;
  rejectedReason?: string;
}

export interface KycProvider {
  startVerification(input: { customerId: string; senderPhone: string }): Promise<KycStartResult>;
  getStatus(providerRef: string): Promise<KycStatus>;
  handleWebhook(body: unknown): Promise<KycWebhookResult | null>;
}
```

- [ ] **Step 4: Create `src/lib/providers/mock-kyc-provider.ts`**

```ts
import type { CustomerStore } from '../customer-store';
import type { KycProvider, KycStartResult, KycStatus, KycWebhookResult } from './kyc-provider';

/**
 * MockKycProvider: B1 stand-in. startVerification returns the dashboard URL
 * for the customer detail page (staff manually flips kycStatus there).
 * B2 will replace this with PersonaKycProvider behind the same interface.
 */
export class MockKycProvider implements KycProvider {
  constructor(
    private readonly customerStore: CustomerStore,
    private readonly appBaseUrl: string,
  ) {}

  async startVerification(input: {
    customerId: string;
    senderPhone: string;
  }): Promise<KycStartResult> {
    return {
      url: `${this.appBaseUrl}/dashboard/customers/${input.senderPhone}`,
      providerRef: `mock-${input.senderPhone}`,
    };
  }

  async getStatus(providerRef: string): Promise<KycStatus> {
    // Extract phone from providerRef "mock-<phone>"
    const phone = providerRef.startsWith('mock-') ? providerRef.slice('mock-'.length) : null;
    if (!phone) return 'pending';
    const customer = await this.customerStore.getCustomer(phone);
    if (!customer) return 'pending';
    if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'verified';
    if (customer.kycStatus === 'rejected') return 'rejected';
    return 'pending';
  }

  async handleWebhook(_body: unknown): Promise<KycWebhookResult | null> {
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- kyc-provider`
Expected: PASS (all 4).

- [ ] **Step 6: Commit**

```bash
git add src/lib/providers/kyc-provider.ts src/lib/providers/mock-kyc-provider.ts tests/kyc-provider.test.ts
git commit -m "kyc-provider: interface + MockKycProvider (B2 swaps in Persona)"
```

---

## Task 6: `tools.ts` — add `check_send_limit`, enforce caps in `send_approve_picker` + `create_transfer`, bump daily volume

**Files:**
- Modify: `src/lib/tools.ts`
- Modify: `tests/tools.test.ts`

Big task. Read `src/lib/tools.ts` end-to-end first — you'll be adding one new tool schema + one new implementation + modifying two existing implementations + extending `ToolContext` with three new fields. Reference: PR #5's Task 7 followed the same shape.

**EXPECTED:** Typecheck goes red at call sites (`agent.ts`, `tests/agent.test.ts`, `tests/tools.test.ts`, `tests/e2e.test.ts`). Don't fix those here — Task 7 owns them.

- [ ] **Step 1: Add the tool schema**

In `src/lib/tools.ts`, inside the `toolSchemas` array after the existing `cancel_draft` schema, append:

```ts
  {
    type: 'function',
    function: {
      name: 'check_send_limit',
      description:
        "Check whether the sender is allowed to send `amount_usd` right now. Pass 0 to fetch their current cap status without proposing an amount. Returns { within_cap, tier, daily_cap_usd, per_transfer_cap_usd, today_used_usd, today_remaining_usd, reason?, day_of_window?, kyc_url? }. Always call this BEFORE get_quote.",
      parameters: {
        type: 'object',
        properties: {
          amount_usd: {
            type: 'number',
            description: 'Amount the sender wants to send in USD. Pass 0 for status-only.',
          },
        },
        required: ['amount_usd'],
      },
    },
  },
```

- [ ] **Step 2: Extend `ToolContext` and imports**

At the top of `src/lib/tools.ts`, find the existing import block. Add:

```ts
import { evaluateCap } from './tier-rules';
import type { CustomerStore } from './customer-store';
import type { DailyVolumeStore } from './daily-volume-store';
import type { KycProvider } from './providers/kyc-provider';
```

Modify the `ToolContext` interface:

```ts
export interface ToolContext {
  phone: string;
  store: Store;
  scheduleStore: ScheduleStore;
  draftStore: DraftStore;
  turn: TurnContext;
  customerStore: CustomerStore;
  dailyVolumeStore: DailyVolumeStore;
  kycProvider: KycProvider;
}
```

- [ ] **Step 3: Add the `executeTool` switch case**

In the `executeTool` switch, after the existing `case 'cancel_draft':` add:

```ts
    case 'check_send_limit':
      return checkSendLimitTool(args, ctx);
```

- [ ] **Step 4: Implement `checkSendLimitTool`**

At the bottom of `src/lib/tools.ts`, add:

```ts
async function checkSendLimitTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const amountUsd = Number(args.amount_usd ?? 0);
  const requestedCents = Math.round(amountUsd * 100);
  const customer = (await ctx.customerStore.getCustomer(ctx.phone))
    ?? (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
  const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
  const evalResult = evaluateCap(customer, new Date(), todayUsedCents, requestedCents);

  // Surface a KYC URL for T0 or Suspended (the agent uses this in the message).
  let kycUrl: string | undefined;
  if (evalResult.tier === 'T0' || evalResult.tier === 'Suspended') {
    const start = await ctx.kycProvider.startVerification({
      customerId: ctx.phone,
      senderPhone: ctx.phone,
    });
    kycUrl = start.url;
  }

  return {
    within_cap: evalResult.withinCap,
    tier: evalResult.tier,
    daily_cap_usd: evalResult.dailyCapCents / 100,
    per_transfer_cap_usd: evalResult.perTransferCapCents / 100,
    today_used_usd: evalResult.todayUsedCents / 100,
    today_remaining_usd: evalResult.todayRemainingCents / 100,
    reason: evalResult.reason,
    day_of_window: evalResult.dayOfWindow,
    kyc_url: kycUrl,
  };
}
```

- [ ] **Step 5: Enforce cap in `sendApprovePickerTool`**

Find `sendApprovePickerTool` (added by PR #5). Immediately after the phone-validation block, before `getTransferCount`, add:

```ts
  // Cap enforcement (defense in depth — check_send_limit + this + create_transfer)
  {
    const customer = (await ctx.customerStore.getCustomer(ctx.phone))
      ?? (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
    const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
    const requestedCents = Math.round(amountUsd * 100);
    const ev = evaluateCap(customer, new Date(), todayUsedCents, requestedCents);
    if (!ev.withinCap) {
      return {
        error: 'Cap exceeded for this transfer.',
        cap_eval: {
          tier: ev.tier,
          reason: ev.reason,
          today_used_usd: ev.todayUsedCents / 100,
          today_remaining_usd: ev.todayRemainingCents / 100,
          daily_cap_usd: ev.dailyCapCents / 100,
        },
      };
    }
  }
```

(The existing body — `getTransferCount`, `quote`, `createDraft`, `sendInteractive` — stays unchanged after this block.)

- [ ] **Step 6: Enforce cap + bump daily volume in `createTransferTool`**

Find `createTransferTool`. Both code paths (`ctxDraftId` and legacy explicit-args) need:
- A cap check before `createTransfer(store, input)`
- A `dailyVolumeStore.addCents(...)` call after a successful `createTransfer`

For the `ctxDraftId` (approve-tap) path, after `consumeDraft` returns a draft, before calling `createTransfer(store, ...)`:

```ts
    // Re-check cap at the moment of approval (cap state may have changed since picker)
    {
      const customer = (await ctx.customerStore.getCustomer(ctx.phone))
        ?? (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
      const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
      const requestedCents = Math.round(draft.amountUsd * 100);
      const ev = evaluateCap(customer, new Date(), todayUsedCents, requestedCents);
      if (!ev.withinCap) {
        return {
          error: 'That quote would exceed your current sending cap. Please request a fresh quote.',
          cap_eval: { tier: ev.tier, reason: ev.reason, today_remaining_usd: ev.todayRemainingCents / 100 },
        };
      }
    }
```

After the successful `createTransfer(...)` in that path, add:

```ts
      await ctx.dailyVolumeStore.addCents(ctx.phone, Math.round(transfer.amountUsd * 100));
```

For the legacy explicit-args path, after validating `recipientPhone` but before `createTransfer(store, {...})`:

```ts
  // Cap check on the legacy path (cron-fired or no-button cold-start)
  {
    const amtUsd = Number(args.amount_usd);
    const customer = (await ctx.customerStore.getCustomer(ctx.phone))
      ?? (await ctx.customerStore.upsertOnFirstInbound(ctx.phone)).customer;
    const todayUsedCents = await ctx.dailyVolumeStore.getTodayCents(ctx.phone);
    const requestedCents = Math.round(amtUsd * 100);
    const ev = evaluateCap(customer, new Date(), todayUsedCents, requestedCents);
    if (!ev.withinCap) {
      return {
        error: 'Cap exceeded for this transfer.',
        cap_eval: { tier: ev.tier, reason: ev.reason, today_remaining_usd: ev.todayRemainingCents / 100 },
      };
    }
  }
```

After the successful `createTransfer(...)` in that path, add the same:

```ts
    await ctx.dailyVolumeStore.addCents(ctx.phone, Math.round(transfer.amountUsd * 100));
```

- [ ] **Step 7: Run typecheck — confirm errors only at call sites**

Run: `npm run typecheck`
Expected: FAIL with errors at `src/lib/agent.ts` (`ToolContext` missing fields) and `tests/*.test.ts` call sites. No errors inside `tools.ts`. (Same expected state as PR #5's Task 7.)

- [ ] **Step 8: Append tool tests**

Append to `tests/tools.test.ts` a new describe block. Reference the existing test setup (it already imports `fakeRedis`, etc.) and add the new ctx fields:

```ts
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { executeTool } from '@/lib/tools';

describe('check_send_limit', () => {
  it('T0 brand-new customer with no spend → within_cap true with day_of_window=1', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const ctx = {
      phone: '15550001111',
      store,
      scheduleStore: createScheduleStore(redis),
      draftStore: createDraftStore(redis),
      turn: { isNewConversation: false },
      customerStore,
      dailyVolumeStore,
      kycProvider,
    };
    const r = await executeTool('check_send_limit', { amount_usd: 100 }, ctx);
    expect(r.within_cap).toBe(true);
    expect(r.tier).toBe('T0');
    expect(r.daily_cap_usd).toBe(500);
    expect(r.today_remaining_usd).toBe(500);
    expect(r.day_of_window).toBe(1);
    expect(r.kyc_url).toBe('https://example.com/dashboard/customers/15550001111');
  });

  it('T0 customer over the per-transfer cap returns reason=over_per_transfer_cap', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const ctx = {
      phone: '15550001111',
      store, scheduleStore: createScheduleStore(redis), draftStore: createDraftStore(redis),
      turn: { isNewConversation: false }, customerStore, dailyVolumeStore, kycProvider,
    };
    const r = await executeTool('check_send_limit', { amount_usd: 700 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_per_transfer_cap');
  });

  it('T0 customer over the daily cap (cumulative) returns reason=over_daily_cap', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const ctx = {
      phone: '15550001111',
      store, scheduleStore: createScheduleStore(redis), draftStore: createDraftStore(redis),
      turn: { isNewConversation: false }, customerStore, dailyVolumeStore, kycProvider,
    };
    await customerStore.upsertOnFirstInbound('15550001111');
    await dailyVolumeStore.addCents('15550001111', 30_000); // already $300 today
    const r = await executeTool('check_send_limit', { amount_usd: 300 }, ctx);
    expect(r.within_cap).toBe(false);
    expect(r.reason).toBe('over_daily_cap');
    expect(r.today_used_usd).toBe(300);
    expect(r.today_remaining_usd).toBe(200);
  });

  it('zero-amount request returns within_cap=true (status-only)', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const ctx = {
      phone: '15550001111',
      store, scheduleStore: createScheduleStore(redis), draftStore: createDraftStore(redis),
      turn: { isNewConversation: false }, customerStore, dailyVolumeStore, kycProvider,
    };
    const r = await executeTool('check_send_limit', { amount_usd: 0 }, ctx);
    expect(r.within_cap).toBe(true);
    expect(r.kyc_url).toBeDefined();
  });
});
```

Then append:

```ts
describe('create_transfer — daily volume increment', () => {
  it('increments daily_volume by the transfer amount in cents on success', async () => {
    resetRateCacheForTests();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }),
    }));
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    // Mark customer grandfathered so the cap doesn't block
    await customerStore.saveCustomer({
      senderPhone: '15551234567',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'grandfathered',
      kycVerifiedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const ctx = {
      phone: '15551234567',
      store, scheduleStore: createScheduleStore(redis), draftStore: createDraftStore(redis),
      turn: { isNewConversation: false }, customerStore, dailyVolumeStore, kycProvider,
    };
    await executeTool('create_transfer', {
      amount_usd: 100,
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
      funding_method: 'bank_transfer',
    }, ctx);
    expect(await dailyVolumeStore.getTodayCents('15551234567')).toBe(10_000);
  });
});
```

Plus a cap-enforcement test on `send_approve_picker`:

```ts
describe('send_approve_picker — cap enforcement', () => {
  it('refuses to send buttons and returns error when over cap', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    await customerStore.upsertOnFirstInbound('15550002222');
    let interactiveSent = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      interactiveSent = true;
      return { ok: true, text: async () => '' };
    }));
    const ctx = {
      phone: '15550002222',
      store, scheduleStore: createScheduleStore(redis), draftStore: createDraftStore(redis),
      turn: { isNewConversation: false }, customerStore, dailyVolumeStore, kycProvider,
    };
    const r = await executeTool('send_approve_picker', {
      amount_usd: 700, // over T0 $500 per-transfer cap
      funding_method: 'bank_transfer',
      recipient_name: 'Mom',
      recipient_phone: '919876543210',
      payout_method: 'upi',
      payout_destination: 'mom@upi',
    }, ctx);
    expect(r.error).toBeDefined();
    expect(interactiveSent).toBe(false); // never reached sendInteractive
  });
});
```

- [ ] **Step 9: Update all existing `executeTool({}, ctx)` test call sites**

In `tests/tools.test.ts`, every existing `ctx` object literal will fail typecheck because `customerStore` / `dailyVolumeStore` / `kycProvider` are now required. Either:

A. Add to each existing ctx literal:
```ts
const customerStore = createCustomerStore(redis, store);
const dailyVolumeStore = createDailyVolumeStore(redis);
const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
// then ctx: { ..., customerStore, dailyVolumeStore, kycProvider }
```

B. Or introduce a helper at the top of the file that returns the full ctx:

```ts
function buildCtx(redis: FakeRedis, phone = '15551234567') {
  const store = createStore(redis);
  const customerStore = createCustomerStore(redis, store);
  const dailyVolumeStore = createDailyVolumeStore(redis);
  const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
  return {
    phone, store,
    scheduleStore: createScheduleStore(redis),
    draftStore: createDraftStore(redis),
    turn: { isNewConversation: false },
    customerStore, dailyVolumeStore, kycProvider,
  };
}
```

Use (B). Then every test rewrites to:

```ts
const redis = fakeRedis();
const ctx = buildCtx(redis);
```

Run: `npm test -- tools`
Expected: PASS — all existing tests plus the new ones.

- [ ] **Step 10: Commit**

```bash
git add src/lib/tools.ts tests/tools.test.ts
git commit -m "tools: check_send_limit + cap enforcement in send_approve_picker/create_transfer + daily-volume incr

Note: agent.ts + remaining test files updated in Task 7; typecheck red
elsewhere until then."
```

---

## Task 7: `agent.ts` — wire new stores + provider into `AgentDeps`, inject system notes

**Files:**
- Modify: `src/lib/agent.ts`
- Modify: `tests/agent.test.ts`
- Modify: `tests/e2e.test.ts`

- [ ] **Step 1: Write the new failing tests**

Append to `tests/agent.test.ts`:

```ts
import { createCustomerStore } from '@/lib/customer-store';
import { createDailyVolumeStore } from '@/lib/daily-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import type { TurnContext } from '@/lib/types';

describe('createAgent — [NEW CUSTOMER] and [TIER_REMINDER] notes', () => {
  function build(redis = fakeRedis()) {
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    return { redis, store, customerStore, dailyVolumeStore, kycProvider };
  }

  it('prepends [NEW CUSTOMER] when turn.isNewCustomer is true', async () => {
    const b = build();
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store: b.store,
      scheduleStore: createScheduleStore(b.redis),
      draftStore: createDraftStore(b.redis),
      customerStore: b.customerStore,
      dailyVolumeStore: b.dailyVolumeStore,
      kycProvider: b.kycProvider,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn('15551234567', 'hi', { isNewConversation: true, isNewCustomer: true });
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content);
    expect(sys.some((s) => typeof s === 'string' && s.includes('[NEW CUSTOMER]'))).toBe(true);
  });

  it('prepends [TIER_REMINDER day 2/3] when turn.tierReminderDayOfWindow is 2', async () => {
    const b = build();
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store: b.store,
      scheduleStore: createScheduleStore(b.redis),
      draftStore: createDraftStore(b.redis),
      customerStore: b.customerStore,
      dailyVolumeStore: b.dailyVolumeStore,
      kycProvider: b.kycProvider,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn('15551234567', 'hi', {
      isNewConversation: true,
      tierReminderDayOfWindow: 2,
    });
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content);
    expect(sys.some((s) => typeof s === 'string' && s.includes('[TIER_REMINDER') && s.includes('2/3'))).toBe(true);
  });

  it('does NOT prepend either when neither flag is set', async () => {
    const b = build();
    const seen: ChatMessage[][] = [];
    const agent = createAgent({
      store: b.store,
      scheduleStore: createScheduleStore(b.redis),
      draftStore: createDraftStore(b.redis),
      customerStore: b.customerStore,
      dailyVolumeStore: b.dailyVolumeStore,
      kycProvider: b.kycProvider,
      chat: async (messages) => { seen.push(messages); return { role: 'assistant', content: 'ok' }; },
    });
    await agent.runAgentTurn('15551234567', 'hi', { isNewConversation: false });
    const sys = seen[0].filter((m) => m.role === 'system').map((m) => m.content);
    expect(sys.some((s) => typeof s === 'string' && (s.includes('[NEW CUSTOMER]') || s.includes('[TIER_REMINDER')))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- agent`
Expected: FAIL — `customerStore` etc. missing from `AgentDeps`.

- [ ] **Step 3: Modify `src/lib/agent.ts`**

Imports at the top — add:

```ts
import type { CustomerStore } from './customer-store';
import type { DailyVolumeStore } from './daily-volume-store';
import type { KycProvider } from './providers/kyc-provider';
```

Extend `AgentDeps`:

```ts
export interface AgentDeps {
  chat: (messages: ChatMessage[], tools: ChatTool[]) => Promise<ChatMessage>;
  store: Store;
  scheduleStore: ScheduleStore;
  draftStore: DraftStore;
  customerStore: CustomerStore;
  dailyVolumeStore: DailyVolumeStore;
  kycProvider: KycProvider;
}
```

Inside `runAgentTurn`, find the existing `[NEW CONVERSATION]` injection block. Right after that block (still inside `if (round === 0)`), add:

```ts
      if (turn.isNewCustomer) {
        messages.push({
          role: 'system',
          content:
            '[NEW CUSTOMER] This is the first message ever from this phone. Greet warmly, mention the $500/day cap for the first 3 days, call check_send_limit({amount_usd: 0}) to fetch the kyc_url, then share that URL and ask how much they want to send.',
        });
      } else if (turn.tierReminderDayOfWindow) {
        messages.push({
          role: 'system',
          content:
            `[TIER_REMINDER day ${turn.tierReminderDayOfWindow}/3] T0 customer in their observation window. Briefly remind them which day they're on and share the kyc_url (from check_send_limit({amount_usd: 0})) before continuing the normal flow.`,
        });
      }
```

In the `executeTool` call inside the loop, extend the ctx:

```ts
          const result = await executeTool(call.function.name, args, {
            phone,
            store: deps.store,
            scheduleStore: deps.scheduleStore,
            draftStore: deps.draftStore,
            customerStore: deps.customerStore,
            dailyVolumeStore: deps.dailyVolumeStore,
            kycProvider: deps.kycProvider,
            turn,
          });
```

- [ ] **Step 4: Update existing `createAgent({...})` callers**

In `tests/agent.test.ts`, every existing `createAgent({...})` needs `customerStore`, `dailyVolumeStore`, `kycProvider` added. Same pattern as the new tests above.

In `tests/e2e.test.ts`, same — extend the existing `createAgent({...})` call inside the returning-customer test.

In `src/app/api/whatsapp/route.ts`, find the existing `createAgent({...})` call and add the three new deps. For now wire `getCustomerStore(store)`, `getDailyVolumeStore()`, and inline:

```ts
const kycProvider = new MockKycProvider(customerStore, env.appBaseUrl);
```

(Real wiring + TurnContext build is Task 9.)

- [ ] **Step 5: Run typecheck + tests**

```bash
npm run typecheck && npm test
```
Expected: PASS. Test count should be ~287 (PR #5's 264 + Task 2's 15 + Task 3's 7 + Task 4's 6 + Task 5's 4 + Task 6's tools ~6 + Task 7's 3 = ~287).

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent.ts tests/agent.test.ts tests/e2e.test.ts src/app/api/whatsapp/route.ts
git commit -m "agent: wire customer/daily-volume/kyc stores; inject [NEW CUSTOMER]/[TIER_REMINDER] notes"
```

---

## Task 8: `prompt.ts` — teach the bot the new flow

**Files:**
- Modify: `src/lib/prompt.ts`

- [ ] **Step 1: Append the new section**

In `src/lib/prompt.ts`, immediately before the closing backtick of `SYSTEM_PROMPT`, insert:

```

NEW-CUSTOMER ONBOARDING & SENDING LIMITS
- The system tells you when a turn involves a new customer or a tier
  reminder via these synthetic prefixes injected as system messages:
    [NEW CUSTOMER]          — first inbound ever from this phone
    [TIER_REMINDER day N/3] — first message of a new conversation (24h+ gap) while still in the 3-day window
- For [NEW CUSTOMER]: greet warmly, mention "you can send up to
  $500/day for your first 3 days while we verify you", call
  check_send_limit({amount_usd: 0}) to get the kyc_url, share that URL,
  then ask "how much would you like to send?".
- For [TIER_REMINDER]: brief reminder of which day they're on (1/3, 2/3,
  3/3) and share the kyc_url (from check_send_limit), then continue the
  normal flow.

- BEFORE you call get_quote, ALWAYS call check_send_limit with the
  amount the user requested. If within_cap is false, do NOT call
  get_quote. Instead reply explaining:
    over_per_transfer_cap → "You can send up to $X per transfer right now; want to send $X?"
    over_daily_cap        → "You have $X left of your $Y daily cap (already sent $Z today); want to send $X?"
    verification_required_after_window → "Your 3-day intro window has ended. Verify here: <kyc_url>"
    verification_rejected → "Your verification didn't succeed. Reply 'help' and a teammate will reach out."

- For Suspended users (check_send_limit returns tier='Suspended'), never
  call get_quote / send_approve_picker / create_transfer. Just send the
  verification message with the kyc_url.
```

- [ ] **Step 2: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/prompt.ts
git commit -m "prompt: teach bot the cap rules + [NEW CUSTOMER]/[TIER_REMINDER] handling"
```

---

## Task 9: `/api/whatsapp/route.ts` — build the real TurnContext

**Files:**
- Modify: `src/app/api/whatsapp/route.ts`

- [ ] **Step 1: Replace the POST handler in `src/app/api/whatsapp/route.ts`**

Keep the GET verify handler unchanged. Replace the POST handler:

```ts
import { after, NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { parseIncoming, sendText } from '@/lib/whatsapp';
import { parseButtonId } from '@/lib/whatsapp-buttons';
import { chat } from '@/lib/ollama';
import { createAgent } from '@/lib/agent';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getDraftStore } from '@/lib/draft-store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { MockKycProvider } from '@/lib/providers/mock-kyc-provider';
import { deriveTier } from '@/lib/tier-rules';
import type { ButtonTap, TurnContext } from '@/lib/types';

// ... GET unchanged ...

function synthesizeButtonText(tap: ButtonTap): string {
  switch (tap.kind) {
    case 'recipient':      return `[Tapped: Send to recipient ${tap.recipientPhone}]`;
    case 'recipient_new':  return '[Tapped: Someone new]';
    case 'approve':        return '[Tapped: Approve & pay]';
    case 'cancel':         return '[Tapped: Cancel]';
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const incoming = parseIncoming(body);
  if (!incoming) return NextResponse.json({ ok: true });

  const store = getStore();
  const isNew = await store.markMessageSeen(incoming.messageId);
  if (!isNew) return NextResponse.json({ ok: true });

  // Build TurnContext deterministically server-side
  const customerStore = getCustomerStore(store);
  const dailyVolumeStore = getDailyVolumeStore();
  const lastInboundAt = await store.getLastInboundAt(incoming.from);
  const isNewConversation = lastInboundAt === null;
  await store.recordInboundNow(incoming.from);

  const { customer, wasCreated } = await customerStore.upsertOnFirstInbound(incoming.from);
  const now = new Date();
  const tier = deriveTier(customer, now);

  // Tier reminder: only on T0, only when starting a new conversation, never on the
  // very first message (that's covered by [NEW CUSTOMER]).
  let tierReminderDayOfWindow: 1 | 2 | 3 | undefined;
  if (tier === 'T0' && isNewConversation && !wasCreated) {
    const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
    const day = Math.min(3, Math.floor(ageMs / (24 * 60 * 60 * 1000)) + 1) as 1 | 2 | 3;
    tierReminderDayOfWindow = day;
  }

  let messageText: string;
  let buttonTap: ButtonTap | undefined;
  if (incoming.kind === 'text') {
    messageText = incoming.text;
  } else {
    const parsed = parseButtonId(incoming.buttonId);
    if (!parsed) {
      messageText = '(unrecognized button)';
    } else {
      buttonTap = parsed;
      messageText = synthesizeButtonText(parsed);
    }
  }

  const turn: TurnContext = {
    isNewConversation,
    buttonTap,
    isNewCustomer: wasCreated,
    tierReminderDayOfWindow,
  };

  after(async () => {
    try {
      const kycProvider = new MockKycProvider(customerStore, env.appBaseUrl);
      const agent = createAgent({
        chat,
        store,
        scheduleStore: getScheduleStore(),
        draftStore: getDraftStore(),
        customerStore,
        dailyVolumeStore,
        kycProvider,
      });
      const reply = await agent.runAgentTurn(incoming.from, messageText, turn);
      await sendText(incoming.from, reply);
    } catch (err) {
      console.error('Failed to process WhatsApp message:', err);
      try {
        await sendText(
          incoming.from,
          'Sorry, something went wrong on our side. Please try again.',
        );
      } catch {
        // best effort
      }
    }
  });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Run typecheck + tests + build**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/whatsapp/route.ts
git commit -m "webhook: compute isNewCustomer + tierReminderDayOfWindow + wire new stores"
```

---

## Task 10: Cron backfill migration

**Files:**
- Create: `src/lib/migration.ts`
- Modify: `src/app/api/cron/route.ts`
- Test: `tests/migration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/migration.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backfillCustomersOnce } from '@/lib/migration';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { createTransfer } from '@/lib/transfer-create';
import { resetRateCacheForTests } from '@/lib/rate';
import { fakeRedis } from './helpers';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ rates: { INR: 85.2 } }),
  }));
});
afterEach(() => vi.restoreAllMocks());

describe('backfillCustomersOnce', () => {
  it('creates grandfathered customers for every phone with transfers', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    for (const phone of ['15551111111', '15552222222']) {
      await createTransfer(store, {
        phone, amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
        payoutMethod: 'upi', payoutDestination: 'm@upi', fundingMethod: 'bank_transfer',
      });
    }
    const result = await backfillCustomersOnce(store, cs);
    expect(result.backfilled).toBe(2);
    const all = await cs.listCustomers();
    expect(all.every((c) => c.kycStatus === 'grandfathered')).toBe(true);
    expect(all.map((c) => c.senderPhone).sort()).toEqual(['15551111111', '15552222222']);
  });

  it('is idempotent — second call returns backfilled=0 and changes nothing', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    await createTransfer(store, {
      phone: '15551111111', amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'm@upi', fundingMethod: 'bank_transfer',
    });
    const first = await backfillCustomersOnce(store, cs);
    const second = await backfillCustomersOnce(store, cs);
    expect(first.backfilled).toBe(1);
    expect(second.backfilled).toBe(0);
    expect(second.skippedSentinel).toBe(true);
  });

  it('does not overwrite an existing Customer record', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const cs = createCustomerStore(redis, store);
    await createTransfer(store, {
      phone: '15551111111', amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
      payoutMethod: 'upi', payoutDestination: 'm@upi', fundingMethod: 'bank_transfer',
    });
    // Pre-existing customer record (e.g. lazy backfill from webhook ran first)
    await cs.saveCustomer({
      senderPhone: '15551111111',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      kycVerifiedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    await backfillCustomersOnce(store, cs);
    const c = await cs.getCustomer('15551111111');
    expect(c?.kycStatus).toBe('verified'); // unchanged
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- migration`
Expected: FAIL — `Cannot find module '@/lib/migration'`.

- [ ] **Step 3: Create `src/lib/migration.ts`**

```ts
import type { Store } from './store';
import type { CustomerStore } from './customer-store';

const SENTINEL_KEY = 'migration:customer-backfill-v1';

export async function backfillCustomersOnce(
  store: Store,
  customerStore: CustomerStore,
): Promise<{ backfilled: number; skippedSentinel: boolean }> {
  // Sentinel guard: once done, never re-run.
  // We read via store.getStore() pattern — but we already accept the store.
  // The sentinel lives on the same RedisLike behind store, accessed via store.markMessageSeen-style pattern.
  // Simpler: pass a generic get/set via the customer store wouldn't work — use redis directly.
  // For this implementation we expose two new methods on Store later; for now, encode via conv key prefix.
  // ACTUALLY: use a dedicated mechanism. The cron is the only caller and Vercel cron is single-process.
  // We rely on Redis SETNX semantics via the existing markMessageSeen pattern.

  const claimed = await store.markMessageSeen(SENTINEL_KEY); // returns true if newly set
  if (!claimed) {
    return { backfilled: 0, skippedSentinel: true };
  }

  const transfers = await store.listTransfers();
  const earliestByPhone = new Map<string, string>();
  for (const t of transfers) {
    const existing = earliestByPhone.get(t.phone);
    if (!existing || t.createdAt < existing) earliestByPhone.set(t.phone, t.createdAt);
  }

  let backfilled = 0;
  for (const [phone, firstSeenAt] of earliestByPhone) {
    if (await customerStore.getCustomer(phone) !== null) continue; // beaten by lazy backfill
    await customerStore.saveCustomer({
      senderPhone: phone,
      firstSeenAt,
      kycStatus: 'grandfathered',
      kycVerifiedAt: new Date().toISOString(),
      createdAt: firstSeenAt,
      updatedAt: new Date().toISOString(),
    });
    backfilled++;
  }
  return { backfilled, skippedSentinel: false };
}
```

**Note:** Reusing `store.markMessageSeen` works because it uses Redis `SET key value NX` semantics and returns true on first-write. The sentinel key `migration:customer-backfill-v1` will be set with a 10-minute TTL (the existing markMessageSeen TTL) — that's a flaw for our purposes (we want forever). Replace the implementation here:

```ts
// First-write semantics: use the underlying redis.set with NX (no TTL — durable)
// Add to src/lib/store.ts an `claimMigrationFlag(key): Promise<boolean>` method.
```

Add to `src/lib/store.ts` inside the returned object (next to `markMessageSeen`):

```ts
    async claimMigrationFlag(key: string): Promise<boolean> {
      const result = await redis.set(`flag:${key}`, '1', { nx: true });
      return result !== null;
    },
```

Update `migration.ts` to call `store.claimMigrationFlag('customer-backfill-v1')` instead of `markMessageSeen`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- migration`
Expected: PASS (3 cases).

- [ ] **Step 5: Modify `src/app/api/cron/route.ts`**

Replace the file:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getCustomerStore } from '@/lib/customer-store';
import { runDueSchedules } from '@/lib/cron-run';
import { backfillCustomersOnce } from '@/lib/migration';
import { sendText } from '@/lib/whatsapp';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (env.cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const store = getStore();
  const customerStore = getCustomerStore(store);

  // Idempotent backfill — runs once, sentinel-guarded.
  const backfill = await backfillCustomersOnce(store, customerStore);

  const result = await runDueSchedules({
    store,
    scheduleStore: getScheduleStore(),
    now: Date.now(),
    sendScheduledLink: async (schedule, _transfer, url) => {
      const text =
        `Your scheduled SendHome transfer of $${schedule.amountUsd.toFixed(2)} ` +
        `to ${schedule.recipientName} is ready. Tap to pay: ${url}`;
      try { await sendText(schedule.phone, text); }
      catch (err) { console.error('Scheduled-link send failed:', schedule.id, err); }
    },
  });

  return NextResponse.json({ ok: true, fired: result.fired, backfill });
}
```

The `?force=true` query param the spec mentioned: not strictly needed because the sentinel makes re-runs cheap. If a manual run is desired, simply hit `/api/cron` with the right `CRON_SECRET` — the backfill is a no-op after the first run anyway. Skip the force param for v1.

- [ ] **Step 6: Run full test suite + typecheck + lint + build**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/migration.ts src/lib/store.ts src/app/api/cron/route.ts tests/migration.test.ts
git commit -m "migration: sentinel-guarded customer backfill, wired into cron"
```

---

## Task 11: Dashboard customers index page + sidebar nav + tier badge on transactions

**Files:**
- Create: `src/app/dashboard/customers/page.tsx`
- Modify: `src/app/dashboard/sidebar.tsx`
- Modify: `src/app/dashboard/transactions/page.tsx`
- Modify: `src/app/dashboard/transactions-tabs.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Extend the sidebar**

In `src/app/dashboard/sidebar.tsx`, find:

```ts
export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'compliance'
  | 'analytics'
  | 'team';
```

Replace with:

```ts
export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'customers'
  | 'compliance'
  | 'analytics'
  | 'team';
```

In the same file, find the `Schedules` link:

```tsx
      <Link
        href="/dashboard/schedules"
        className={`sh-nav-item ${active === 'schedules' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↻</span> Schedules
      </Link>
```

Immediately after it, add:

```tsx
      <Link
        href="/dashboard/customers"
        className={`sh-nav-item ${active === 'customers' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">◉</span> Customers
      </Link>
```

- [ ] **Step 2: Add tier badge CSS**

In `src/app/globals.css`, append:

```css
.sh-tag-tier-t0 {
  background: #fef3c7;
  color: #92400e;
}
.sh-tag-tier-t1 {
  background: #dcfce7;
  color: #166534;
}
.sh-tag-tier-suspended {
  background: #fee2e2;
  color: #991b1b;
}
```

- [ ] **Step 3: Create `src/app/dashboard/customers/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { deriveTier } from '@/lib/tier-rules';
import { Sidebar } from '../sidebar';
import type { Customer, Tier } from '@/lib/types';

function tierBadge(tier: Tier): string {
  if (tier === 'T0') return 'sh-tag sh-tag-tier-t0';
  if (tier === 'T1') return 'sh-tag sh-tag-tier-t1';
  return 'sh-tag sh-tag-tier-suspended';
}

function tierLabel(tier: Tier, c: Customer, now: Date): string {
  if (tier === 'T0') {
    const ageMs = now.getTime() - new Date(c.firstSeenAt).getTime();
    const day = Math.min(3, Math.floor(ageMs / 86400000) + 1);
    return `T0 · day ${day}/3`;
  }
  return tier;
}

export default async function CustomersPage() {
  await requireStaff();
  const store = getStore();
  const customerStore = getCustomerStore(store);
  const [customers, transfers] = await Promise.all([
    customerStore.listCustomers(),
    store.listTransfers(),
  ]);
  const now = new Date();

  // Lifetime sent per phone
  const lifetimeByPhone = new Map<string, { count: number; cents: number; lastAt?: string }>();
  for (const t of transfers) {
    const entry = lifetimeByPhone.get(t.phone) ?? { count: 0, cents: 0 };
    entry.count++;
    entry.cents += Math.round(t.amountUsd * 100);
    if (!entry.lastAt || t.createdAt > entry.lastAt) entry.lastAt = t.createdAt;
    lifetimeByPhone.set(t.phone, entry);
  }

  // Sort: most-recently-active first
  const rows = customers
    .map((c) => ({ c, life: lifetimeByPhone.get(c.senderPhone) ?? { count: 0, cents: 0 } }))
    .sort((a, b) => {
      const aAt = a.life.lastAt ?? a.c.createdAt;
      const bAt = b.life.lastAt ?? b.c.createdAt;
      return bAt.localeCompare(aAt);
    });

  return (
    <>
      <Sidebar active="customers" />
      <main className="sh-main">
        <div className="sh-page-header">
          <div className="sh-page-title">Customers</div>
          <div className="sh-page-subtitle">
            {customers.length} total · {customers.filter((c) => deriveTier(c, now) === 'T0').length} in observation window
          </div>
        </div>
        <div className="sh-card">
          <table className="sh-table">
            <thead>
              <tr>
                <th>Phone</th><th>First seen</th><th>Tier</th><th>KYC</th><th>Lifetime sent</th><th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={6} className="sh-empty">No customers yet.</td></tr>
              )}
              {rows.map(({ c, life }) => {
                const tier = deriveTier(c, now);
                return (
                  <tr key={c.senderPhone}>
                    <td>
                      <Link href={`/dashboard/customers/${c.senderPhone}`}>+{c.senderPhone}</Link>
                    </td>
                    <td>{new Date(c.firstSeenAt).toLocaleDateString()}</td>
                    <td><span className={tierBadge(tier)}>{tierLabel(tier, c, now)}</span></td>
                    <td>{c.kycStatus}</td>
                    <td>${(life.cents / 100).toFixed(2)} ({life.count})</td>
                    <td>{life.lastAt ? new Date(life.lastAt).toLocaleString() : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Wire tier into `/dashboard/transactions`**

In `src/app/dashboard/transactions/page.tsx`, find the `getStore().listTransfers()` call. Add a parallel `listCustomers()` call:

```tsx
const store = getStore();
const customerStore = getCustomerStore(store);
const [transfers, customers] = await Promise.all([
  store.listTransfers(),
  customerStore.listCustomers(),
]);
const now = new Date();
const tierByPhone: Record<string, Tier> = {};
for (const c of customers) tierByPhone[c.senderPhone] = deriveTier(c, now);
```

Pass `tierByPhone` to `<TransactionsExplorer>` (which in turn passes to `<TransactionsTabs>`).

Update the `TransactionsExplorerProps` (or pass-through props) and `TransactionsTabsProps` to include `tierByPhone: Record<string, Tier>`.

In `src/app/dashboard/transactions-tabs.tsx`, find the table headers and rows. Add a `Tier` column between `Phone` and `Amount`:

```tsx
<th>Tier</th>
```

And in the row body:

```tsx
<td>
  {tierByPhone[t.phone] && (
    <span className={tierByPhone[t.phone] === 'T0' ? 'sh-tag sh-tag-tier-t0'
                   : tierByPhone[t.phone] === 'T1' ? 'sh-tag sh-tag-tier-t1'
                   : 'sh-tag sh-tag-tier-suspended'}>
      {tierByPhone[t.phone]}
    </span>
  )}
</td>
```

- [ ] **Step 5: Run typecheck + lint + tests + build**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green. (If lint complains about unused props in the explorer, thread `tierByPhone` through; or import `Tier` and add to the prop type.)

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/sidebar.tsx src/app/dashboard/customers/page.tsx \
        src/app/dashboard/transactions/page.tsx src/app/dashboard/transactions-tabs.tsx \
        src/app/globals.css
git commit -m "dashboard: customers index + tier badge column on transactions"
```

---

## Task 12: Dashboard customer detail page + admin actions

**Files:**
- Create: `src/app/dashboard/customers/[phone]/page.tsx`
- Create: `src/app/dashboard/customers/actions.ts`

- [ ] **Step 1: Create `src/app/dashboard/customers/actions.ts`**

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';

export async function markCustomerVerifiedAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  if (!phone) throw new Error('Phone is required.');

  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(phone);
  if (!customer) throw new Error('Customer not found.');

  const nowIso = new Date().toISOString();
  await cs.saveCustomer({
    ...customer,
    kycStatus: 'verified',
    kycVerifiedAt: nowIso,
    kycRejectedReason: undefined,
    updatedAt: nowIso,
  });
  revalidatePath('/dashboard/customers');
  revalidatePath(`/dashboard/customers/${phone}`);
}

export async function markCustomerRejectedAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const phone = String(formData.get('phone') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim() || 'Manual rejection by staff';
  if (!phone) throw new Error('Phone is required.');

  const cs = getCustomerStore(getStore());
  const customer = await cs.getCustomer(phone);
  if (!customer) throw new Error('Customer not found.');

  const nowIso = new Date().toISOString();
  await cs.saveCustomer({
    ...customer,
    kycStatus: 'rejected',
    kycRejectedReason: reason,
    updatedAt: nowIso,
  });
  revalidatePath('/dashboard/customers');
  revalidatePath(`/dashboard/customers/${phone}`);
}
```

- [ ] **Step 2: Create `src/app/dashboard/customers/[phone]/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { notFound } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { getStore } from '@/lib/store';
import { getCustomerStore } from '@/lib/customer-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { evaluateCap } from '@/lib/tier-rules';
import { Sidebar } from '../../sidebar';
import { markCustomerVerifiedAction, markCustomerRejectedAction } from '../actions';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ phone: string }>;
}) {
  const staff = await requireStaff();
  const isAdmin = staff.role === 'admin';
  const { phone } = await params;

  const store = getStore();
  const customerStore = getCustomerStore(store);
  const dailyVolumeStore = getDailyVolumeStore();
  const customer = await customerStore.getCustomer(phone);
  if (!customer) notFound();

  const [transfers, todayUsedCents] = await Promise.all([
    store.listTransfers(),
    dailyVolumeStore.getTodayCents(phone),
  ]);
  const mine = transfers.filter((t) => t.phone === phone).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const now = new Date();
  const capEval = evaluateCap(customer, now, todayUsedCents, 0);

  return (
    <>
      <Sidebar active="customers" />
      <main className="sh-main">
        <div className="sh-page-header">
          <div className="sh-page-title">+{customer.senderPhone}</div>
          <div className="sh-page-subtitle">Customer · joined {new Date(customer.firstSeenAt).toLocaleDateString()}</div>
        </div>

        <div className="sh-card">
          <h3>Identity & KYC</h3>
          <dl className="sh-dl">
            <dt>Status</dt><dd>{customer.kycStatus}</dd>
            <dt>Verified at</dt><dd>{customer.kycVerifiedAt ?? '—'}</dd>
            <dt>Provider ref</dt><dd>{customer.kycProviderRef ?? '—'}</dd>
            <dt>Full name</dt><dd>{customer.fullName ?? '—'}</dd>
            <dt>DOB</dt><dd>{customer.dateOfBirth ?? '—'}</dd>
            <dt>Country</dt><dd>{customer.country ?? '—'}</dd>
            {customer.kycRejectedReason && (
              <><dt>Rejected reason</dt><dd>{customer.kycRejectedReason}</dd></>
            )}
          </dl>
          {isAdmin && customer.kycStatus !== 'verified' && customer.kycStatus !== 'grandfathered' && (
            <form action={markCustomerVerifiedAction} className="sh-inline-form">
              <input type="hidden" name="phone" value={customer.senderPhone} />
              <button type="submit" className="sh-btn-primary">Mark KYC verified</button>
            </form>
          )}
          {isAdmin && customer.kycStatus !== 'rejected' && (
            <form action={markCustomerRejectedAction} className="sh-inline-form">
              <input type="hidden" name="phone" value={customer.senderPhone} />
              <input type="text" name="reason" placeholder="Rejection reason (optional)" className="sh-input" />
              <button type="submit" className="sh-btn-secondary">Mark KYC rejected</button>
            </form>
          )}
        </div>

        <div className="sh-card">
          <h3>Sending today</h3>
          <dl className="sh-dl">
            <dt>Tier</dt><dd>{capEval.tier}</dd>
            <dt>Daily cap</dt><dd>${(capEval.dailyCapCents / 100).toFixed(2)}</dd>
            <dt>Today used</dt><dd>${(capEval.todayUsedCents / 100).toFixed(2)}</dd>
            <dt>Today remaining</dt><dd>${(capEval.todayRemainingCents / 100).toFixed(2)}</dd>
            {capEval.dayOfWindow && (<><dt>Day of window</dt><dd>{capEval.dayOfWindow}/3</dd></>)}
          </dl>
        </div>

        <div className="sh-card">
          <h3>Recent transfers</h3>
          <table className="sh-table">
            <thead>
              <tr><th>ID</th><th>Amount</th><th>Status</th><th>Created</th></tr>
            </thead>
            <tbody>
              {mine.length === 0 && (
                <tr><td colSpan={4} className="sh-empty">No transfers yet.</td></tr>
              )}
              {mine.slice(0, 50).map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td>
                  <td>${t.amountUsd.toFixed(2)}</td>
                  <td>{t.status}</td>
                  <td>{new Date(t.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
```

- [ ] **Step 3: Run typecheck + lint + build**

```bash
npm run typecheck && npm run lint && npm run build
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/customers/
git commit -m "dashboard: customer detail page + Mark verified/rejected admin actions"
```

---

## Task 13: E2E test — new customer happy path

**Files:**
- Modify: `tests/e2e.test.ts`

- [ ] **Step 1: Append the new e2e test**

Append to `tests/e2e.test.ts`:

```ts
import { evaluateCap } from '@/lib/tier-rules';

describe('end-to-end new customer with cap', () => {
  it('greeted → over-cap → under-cap → approve creates transfer + increments daily volume', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    const dailyVolumeStore = createDailyVolumeStore(redis);
    const kycProvider = new MockKycProvider(customerStore, 'https://example.com');
    const scheduleStore = createScheduleStore(redis);
    const draftStore = createDraftStore(redis);

    // Turn 1: [NEW CUSTOMER] greeting — bot calls check_send_limit({amount_usd: 0})
    const turn1: ChatMessage[] = [
      toolCall('c1', 'check_send_limit', { amount_usd: 0 }),
      { role: 'assistant', content: 'Welcome! $500/day cap for 3 days. Verify: <url>. How much?' },
    ];
    // Turn 2: user asks $700 → bot calls check_send_limit({700}) → over_per_transfer_cap → bot replies
    const turn2: ChatMessage[] = [
      toolCall('c2', 'check_send_limit', { amount_usd: 700 }),
      { role: 'assistant', content: 'You can send up to $500 per transfer right now. Want $500?' },
    ];
    // Turn 3: user agrees to $400 → check_send_limit OK → send_approve_picker → bot waits
    const turn3: ChatMessage[] = [
      toolCall('c3', 'check_send_limit', { amount_usd: 400 }),
      toolCall('c4', 'send_approve_picker', {
        amount_usd: 400, funding_method: 'bank_transfer',
        recipient_name: 'Mom', recipient_phone: '919876543210',
        payout_method: 'upi', payout_destination: 'mom@upi',
      }),
      { role: 'assistant', content: 'Tap Approve to send.' },
    ];
    // Turn 4: user taps Approve → bot calls create_transfer (no args, from ctx) → generate_payment_link
    const turn4: ChatMessage[] = [
      toolCall('c5', 'create_transfer', {}),
      toolCall('c6', 'generate_payment_link', { transfer_id: 'PLACEHOLDER' }),
      { role: 'assistant', content: 'Tap to pay.' },
    ];

    const scripts = [turn1, turn2, turn3, turn4];
    let active: ChatMessage[] = [];
    let idx = 0;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ rates: { INR: 85.2 } }), text: async () => '',
    }));

    const agent = createAgent({
      store, scheduleStore, draftStore, customerStore, dailyVolumeStore, kycProvider,
      async chat() {
        const msg = active.shift()!;
        if (msg.tool_calls?.[0].function.name === 'generate_payment_link') {
          const key = [...redis.dump.keys()].find((k) => k.startsWith('transfer:'))!;
          msg.tool_calls[0].function.arguments = JSON.stringify({
            transfer_id: key.replace('transfer:', ''),
          });
        }
        return msg;
      },
    });

    // Turn 1: NEW CUSTOMER
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, 'hi', { isNewConversation: true, isNewCustomer: true });
    const customerAfterT1 = await customerStore.getCustomer(PHONE);
    expect(customerAfterT1?.kycStatus).toBe('not_started');

    // Turn 2: over-cap
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, 'send 700', { isNewConversation: false });

    // Turn 3: under-cap
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, 'send 400 to mom upi mom@upi 919876543210 via bank', { isNewConversation: false });

    // A draft should now exist
    const draftKey = [...redis.dump.keys()].find((k) => k.startsWith('recipient_draft:'));
    expect(draftKey).toBeDefined();
    const draftId = draftKey!.replace('recipient_draft:', '');

    // Turn 4: approve tap
    active = [...scripts[idx++]];
    await agent.runAgentTurn(PHONE, '[Tapped: Approve & pay]', {
      isNewConversation: false,
      buttonTap: { kind: 'approve', draftId },
    });

    // Transfer must exist
    const transferKey = [...redis.dump.keys()].find((k) => k.startsWith('transfer:'));
    expect(transferKey).toBeDefined();
    // Daily volume must be 40000 cents
    expect(await dailyVolumeStore.getTodayCents(PHONE)).toBe(40_000);

    // Now mark verified mid-window — cap stays $500/day (observation invariant)
    await customerStore.saveCustomer({
      ...(await customerStore.getCustomer(PHONE))!,
      kycStatus: 'verified',
      kycVerifiedAt: new Date().toISOString(),
    });
    // $400 used today + $200 requested = $600 > $500 cap → over_daily_cap
    // (Verifies the observation invariant: KYC verified mid-window does NOT
    //  lift the cap. If verification lifted, $200 would fit in T1's $2,999.)
    const ev = evaluateCap(
      (await customerStore.getCustomer(PHONE))!,
      new Date(),
      await dailyVolumeStore.getTodayCents(PHONE),
      20_000,
    );
    expect(ev.tier).toBe('T0'); // still in window despite verification
    expect(ev.withinCap).toBe(false);
    expect(ev.reason).toBe('over_daily_cap');

    // Asking for $100 (which fits the $100 remaining of the $500 cap) → within
    const within = evaluateCap(
      (await customerStore.getCustomer(PHONE))!,
      new Date(),
      await dailyVolumeStore.getTodayCents(PHONE),
      10_000,
    );
    expect(within.withinCap).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- e2e`
Expected: PASS — both the original happy-path tests and the new one.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.test.ts
git commit -m "test(e2e): new-customer flow with cap enforcement + observation invariant"
```

---

## Task 14: Local CI + dashboard smoke extension + PR + merge + verification

**Files:**
- Modify: `tests/e2e/dashboard-smoke.spec.ts`

This task is verification + delivery through the existing CI/CD pipeline.

- [ ] **Step 1: Extend the Playwright smoke**

In `tests/e2e/dashboard-smoke.spec.ts`, after the existing transactions-table assertion, add:

```ts
  await page.getByRole('link', { name: /customers/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/customers/);
  await expect(
    page.getByRole('table').or(page.getByText(/no customers yet/i)),
  ).toBeVisible();
```

- [ ] **Step 2: Local CI pipeline**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: all four green. Test count should be ~290+.

- [ ] **Step 3: Local Playwright smoke against prod**

```bash
BASE_URL=https://claude-payments.vercel.app npm run e2e
```
Expected: 1 passed. (Note: this runs against CURRENT prod which doesn't have our changes yet — should still pass, the new /dashboard/customers nav-click happens after merge.)

If it fails because `/dashboard/customers` doesn't exist on prod yet, that's expected; the smoke after merge will catch it. You can skip this step if it's a chicken-and-egg.

Better: temporarily comment out the new assertions before pushing, push, merge, then in a follow-up commit re-enable them. Or — easier — leave the assertions and let the post-deploy smoke fail once; fix forward.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/customer-profile-tier
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --head feat/customer-profile-tier \
  --title "feat: customer profile + new-account tier with \$500/day cap" \
  --body "$(cat <<'EOF'
Implements [docs/superpowers/specs/2026-05-24-customer-profile-tier-design.md](docs/superpowers/specs/2026-05-24-customer-profile-tier-design.md) via the 14-task plan at [docs/superpowers/plans/2026-05-24-customer-profile-tier.md](docs/superpowers/plans/2026-05-24-customer-profile-tier.md).

## Summary
- New `Customer` Redis record per sender, lazily created on first inbound.
- Three tiers: T0 (new, \$500/day for 3 days) · T1 (verified, \$2,999/day) · Suspended.
- **Observation invariant:** KYC verification mid-window does NOT lift the cap. Window is a full 3-day observation period.
- New `check_send_limit` agent tool + cap enforcement at `send_approve_picker` + `create_transfer`.
- New \`/dashboard/customers\` index + \`/dashboard/customers/[phone]\` detail with admin-only Mark verified/rejected.
- Tier badge column added to \`/dashboard/transactions\`.
- Existing senders grandfathered via sentinel-guarded cron backfill + lazy webhook fallback.
- `KycProvider` interface ready for B2 (Persona) to swap in.

## Reliability
- LLM cannot fabricate `isNewCustomer` or `tierReminderDayOfWindow` — server-controlled.
- Cap enforcement at three layers (pre-quote, pre-draft, pre-create).
- All money math in cents to avoid float bugs.
- Backfill idempotent via Redis SETNX sentinel.

## Test plan
- [x] `npm run typecheck` / `npm run lint` / `npm test` / `npm run build` — all green
- [x] ~290 tests pass (was 264)
- [ ] Post-merge: `/api/cron` triggers backfill on first run; verify in logs
- [ ] Post-merge: \`/dashboard/customers\` lists every pre-existing sender as T1 grandfathered
- [ ] Post-merge: send WhatsApp from a brand-new phone → \$500/day greeting; trying \$700 → cap reply; \$400 succeeds
- [ ] Post-merge: Playwright smoke navigates to \`/dashboard/customers\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI**

```bash
gh pr checks --watch
```
Expected: `ci` green in ~40s, `Vercel` preview green.

- [ ] **Step 7: Merge through branch protection**

```bash
gh pr merge --squash --delete-branch
git checkout main && git pull --ff-only
```

- [ ] **Step 8: Verify Vercel auto-deployed prod**

```bash
sleep 60
vercel ls claude-payments --yes | head -5
curl -sI https://claude-payments.vercel.app/dashboard/customers | head -2
```
Expected: latest prod deploy is GitHub-driven (from PR merge), `/dashboard/customers` returns 200 (redirects to login if not authenticated — that's fine).

- [ ] **Step 9: Trigger the backfill explicitly**

If `CRON_SECRET` is set in production:

```bash
curl -s "https://claude-payments.vercel.app/api/cron" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expected response: `{"ok":true,"fired":...,"backfill":{"backfilled":N,"skippedSentinel":false}}` on first call. Subsequent calls return `"skippedSentinel":true`.

- [ ] **Step 10: Verify the smoke ran on the prod deploy**

```bash
gh run list --workflow smoke.yml --limit 1 --branch main
```
Expected: most recent run is `success`. If it failed at the new `/dashboard/customers` step, investigate — likely a selector tweak needed.

- [ ] **Step 11: Manual production verification (Task-14-style checklist)**

Do these in the live https://claude-payments.vercel.app dashboard logged in as admin:

- [ ] `/dashboard/customers` renders. Every pre-existing sender (from the past PRs' test transfers) is listed as T1 grandfathered.
- [ ] Click any customer phone → detail page renders; identity panel shows `grandfathered`; sending-today shows T1 / \$2,999 daily cap.
- [ ] `/dashboard/transactions` shows a Tier column with the right tier per row.
- [ ] Send a WhatsApp message from a phone you've never used before → bot greets with the cap message including a URL pointing to `https://claude-payments.vercel.app/dashboard/customers/<your_phone>`.
- [ ] Try to send \$700 → bot says "$500 max per transfer right now."
- [ ] Send \$400 → bot completes the flow including \[Approve & pay] button.
- [ ] In the dashboard, find that customer → click \[Mark KYC verified] → status changes; activity timeline reflects it.
- [ ] Even after marking verified, the customer's daily cap stays \$500 (try sending another \$200 → should hit \$600 > cap → over_daily_cap).
- [ ] All four CI/CD gates from the existing pipeline still pass on the merge commit.

---

## Self-review

**1. Spec coverage**

| Spec section | Task |
|---|---|
| 3-tier rules (T0/T1/Suspended) | Task 2 (tier-rules) |
| `customer:<phone>` Redis record | Task 3 (customer-store) |
| `daily_volume:<phone>:<date>` counter | Task 4 (daily-volume-store) |
| 48h TTL on daily-volume keys | Task 4 step 1 (test asserts ex=172800) |
| `KycProvider` interface + `MockKycProvider` | Task 5 |
| `check_send_limit` tool | Task 6 step 4 |
| `send_approve_picker` cap enforcement | Task 6 step 5 |
| `create_transfer` cap enforcement + daily-volume incr | Task 6 step 6 |
| `TurnContext` extension | Task 1 (types) + Task 9 (compute) |
| `[NEW CUSTOMER]` and `[TIER_REMINDER]` system notes | Task 7 (agent.ts) |
| Prompt addition | Task 8 |
| Webhook `upsertOnFirstInbound` + tier derivation + reminder day | Task 9 |
| Sentinel-guarded backfill cron | Task 10 |
| Lazy backfill in webhook | Task 3 (`upsertOnFirstInbound` peeks at transfers) |
| `/dashboard/customers` index | Task 11 |
| Tier badge column on transactions | Task 11 |
| `/dashboard/customers/[phone]` detail | Task 12 |
| `markCustomerVerifiedAction` / `markCustomerRejectedAction` | Task 12 |
| Observation invariant test (verify mid-window doesn't lift cap) | Task 13 (e2e) |
| Playwright smoke for `/dashboard/customers` | Task 14 |
| Local CI + PR + merge + verification | Task 14 |

All spec sections traced to a task. No gaps.

**2. Placeholder scan**

No `TBD` / `TODO` / `fill in` in the plan. The Task 4 TTL test had a placeholder sentinel — replaced with a real assertion in step 3.

**3. Type consistency**

- `Customer`, `Tier`, `KycStatus`, `CapEvaluation`, `CapReason` defined in Task 1, used consistently in Tasks 2-13.
- `TurnContext` fields (`isNewCustomer`, `tierReminderDayOfWindow`) defined in Task 1, populated in Task 9, consumed in Task 7.
- `CustomerStore`, `DailyVolumeStore`, `KycProvider` defined in Tasks 3/4/5, threaded through `ToolContext` (Task 6) and `AgentDeps` (Task 7), wired in `route.ts` (Task 9).
- `evaluateCap`/`deriveTier` defined in Task 2, used in Tasks 6/9/11/12/13.
- `markCustomerVerifiedAction` defined in Task 12, no later references (it's a server action consumed inline).
- Method names consistent: `getCustomer` / `saveCustomer` / `upsertOnFirstInbound` / `listCustomers`; `addCents` / `getTodayCents`.

No type drift.

**Dependency order** for parallelization (if subagent-driven mode is used):
- Task 1 first (types).
- Tasks 2, 3, 4, 5 depend only on Task 1 (parallelizable in principle, but the skill says serialize implementer subagents).
- Task 6 depends on 2, 3, 4, 5.
- Task 7 depends on 6 (+ types).
- Tasks 8, 10, 11, 12 depend on 7 + their respective subsystems.
- Task 9 depends on 3, 7.
- Task 13 depends on most things.
- Task 14 depends on everything.
