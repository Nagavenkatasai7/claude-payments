# Batch B — Compliance Screening + Recurring Transfers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mock compliance/fraud screening step to every transfer, and customer-configurable recurring (monthly/weekly) transfers driven by a daily cron.

**Architecture:** A pure `compliance.ts` screens each transfer (block/flag/clear); a shared `transfer-create.ts` builds transfers (used by both the chat tool and the cron). Schedules live in their own Redis-backed store; a daily Vercel cron fires due schedules, creating a transfer and sending the customer a payment-link template. All new state is in Redis and surfaced on the dashboard.

**Tech Stack:** Next.js 16, TypeScript, Vitest, `@upstash/redis`, Vercel Cron.

Reference spec: `docs/superpowers/specs/2026-05-21-batch-b-compliance-recurring-design.md`

---

## File Structure

```
NEW  src/lib/dates.ts            - eastern-timezone date helpers
NEW  src/lib/compliance.ts       - pure screenTransfer() + WATCHLIST
NEW  src/lib/transfer-create.ts  - shared createTransfer() (chat tool + cron)
NEW  src/lib/schedule-store.ts   - Redis store for Schedule records
NEW  src/lib/schedule.ts         - pure isScheduleDueToday()
NEW  src/lib/cron-run.ts         - pure-ish runDueSchedules()
NEW  src/app/api/cron/route.ts   - daily cron endpoint
NEW  vercel.json                 - cron schedule config
MOD  src/lib/types.ts            - TransferStatus +blocked; Transfer +compliance; Schedule types
MOD  src/lib/store.ts            - velocity counters
MOD  src/lib/tools.ts            - compliance in create_transfer; blocked guard; schedule tools
MOD  src/lib/prompt.ts           - recurring-transfer instructions
MOD  src/lib/agent.ts            - ToolContext/AgentDeps gain scheduleStore
MOD  src/lib/whatsapp.ts         - SCHEDULED_TEMPLATE_NAME constant
MOD  src/lib/env.ts              - optional CRON_SECRET
MOD  src/lib/dashboard.ts        - needsAttention() includes flagged/blocked; flagged metric
MOD  src/app/api/whatsapp/route.ts - pass scheduleStore into the agent
MOD  src/app/dashboard/page.tsx  - Compliance column + Recurring Schedules section
```

---

## Task 1: Eastern-timezone date helpers

**Files:**
- Create: `src/lib/dates.ts`
- Modify: `src/lib/dashboard.ts`
- Test: `tests/dates.test.ts`

- [ ] **Step 1: Write the failing test `tests/dates.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { easternDate, easternDayOfMonth, easternDayOfWeek } from '@/lib/dates';

// 2026-05-21T16:00:00Z is noon Eastern on Thu May 21, 2026.
const NOON_ET = Date.parse('2026-05-21T16:00:00.000Z');

describe('dates', () => {
  it('easternDate returns a stable date string', () => {
    const a = easternDate(NOON_ET);
    const b = easternDate(NOON_ET + 60_000);
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
  });

  it('easternDayOfMonth returns the day number', () => {
    expect(easternDayOfMonth(NOON_ET)).toBe(21);
  });

  it('easternDayOfWeek returns 0-6 (Thursday = 4)', () => {
    expect(easternDayOfWeek(NOON_ET)).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dates`
Expected: FAIL — cannot resolve `@/lib/dates`.

- [ ] **Step 3: Create `src/lib/dates.ts`**

```ts
const ET = 'America/New_York';

export function easternDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-US', { timeZone: ET });
}

export function easternDayOfMonth(epochMs: number): number {
  return Number(
    new Date(epochMs).toLocaleString('en-US', { timeZone: ET, day: 'numeric' }),
  );
}

export function easternDayOfWeek(epochMs: number): number {
  const short = new Date(epochMs).toLocaleString('en-US', {
    timeZone: ET,
    weekday: 'short',
  });
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
}
```

- [ ] **Step 4: Update `src/lib/dashboard.ts` to use the shared helper**

`dashboard.ts` currently defines its own eastern-date helper for `summarize`. Delete that local helper and add `import { easternDate } from './dates';` at the top, then use `easternDate` wherever the local helper was called. Do not change any other logic.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — `dates.test.ts` passes and `dashboard.test.ts` still passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dates.ts src/lib/dashboard.ts tests/dates.test.ts
git commit -m "feat: add shared eastern-timezone date helpers"
```

---

## Task 2: Compliance screening engine

**Files:**
- Create: `src/lib/compliance.ts`
- Test: `tests/compliance.test.ts`

- [ ] **Step 1: Write the failing test `tests/compliance.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { screenTransfer } from '@/lib/compliance';

describe('screenTransfer', () => {
  it('clears an ordinary transfer', () => {
    const r = screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 0 });
    expect(r.status).toBe('cleared');
    expect(r.reasons).toEqual([]);
  });

  it('blocks a recipient on the watchlist (case-insensitive)', () => {
    const r = screenTransfer({ amountUsd: 200, recipientName: '  John Doe ', transfersToday: 0 });
    expect(r.status).toBe('blocked');
    expect(r.reasons[0]).toMatch(/watchlist/i);
  });

  it('flags a large amount', () => {
    const r = screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 0 });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /amount/i.test(x))).toBe(true);
  });

  it('flags high velocity', () => {
    const r = screenTransfer({ amountUsd: 200, recipientName: 'Mom', transfersToday: 3 });
    expect(r.status).toBe('flagged');
    expect(r.reasons.some((x) => /velocity/i.test(x))).toBe(true);
  });

  it('records both reasons when amount and velocity both trip', () => {
    const r = screenTransfer({ amountUsd: 1500, recipientName: 'Mom', transfersToday: 4 });
    expect(r.status).toBe('flagged');
    expect(r.reasons).toHaveLength(2);
  });

  it('blocked takes precedence over flagged', () => {
    const r = screenTransfer({ amountUsd: 2000, recipientName: 'John Doe', transfersToday: 9 });
    expect(r.status).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- compliance`
Expected: FAIL — cannot resolve `@/lib/compliance`.

- [ ] **Step 3: Create `src/lib/compliance.ts`**

```ts
import type { ComplianceStatus } from './types';

// Mock sanctions/watchlist — clearly fake names for the prototype.
export const WATCHLIST = ['john doe', 'jane roe', 'test blocked'];
export const LARGE_AMOUNT_USD = 1000;
export const VELOCITY_LIMIT = 3;

export interface ComplianceResult {
  status: ComplianceStatus;
  reasons: string[];
}

export function screenTransfer(input: {
  amountUsd: number;
  recipientName: string;
  transfersToday: number;
}): ComplianceResult {
  const name = input.recipientName.trim().toLowerCase();
  if (WATCHLIST.includes(name)) {
    return {
      status: 'blocked',
      reasons: ['Recipient is on the compliance watchlist.'],
    };
  }
  const reasons: string[] = [];
  if (input.amountUsd >= LARGE_AMOUNT_USD) {
    reasons.push('Large transfer amount.');
  }
  if (input.transfersToday >= VELOCITY_LIMIT) {
    reasons.push('High transfer velocity.');
  }
  if (reasons.length > 0) return { status: 'flagged', reasons };
  return { status: 'cleared', reasons: [] };
}
```

Note: `ComplianceStatus` is added to `types.ts` in Task 4. Until then this file
will not type-check on its own — that is expected; Task 2 Step 4 only runs the
`compliance.test.ts` file, and the import is type-only. If the test runner
errors on the missing type, temporarily inline `type ComplianceStatus =
'cleared' | 'flagged' | 'blocked'` in this file and remove it in Task 4. (Prefer
adding the type in Task 4 and accepting a type-only forward reference.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- compliance`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/compliance.ts tests/compliance.test.ts
git commit -m "feat: add mock compliance screening engine"
```

---

## Task 3: Per-day velocity counters in the store

**Files:**
- Modify: `src/lib/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: Add tests to `tests/store.test.ts`**

Append this describe block:

```ts
import { easternDate } from '@/lib/dates';

describe('store velocity counter', () => {
  it('defaults today count to 0 and increments', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTodayTransferCount('p')).toBe(0);
    await store.incrementTodayTransferCount('p');
    await store.incrementTodayTransferCount('p');
    expect(await store.getTodayTransferCount('p')).toBe(2);
  });

  it('velocity is isolated per phone', async () => {
    const store = createStore(fakeRedis());
    await store.incrementTodayTransferCount('p1');
    expect(await store.getTodayTransferCount('p1')).toBe(1);
    expect(await store.getTodayTransferCount('p2')).toBe(0);
  });

  it('uses an eastern-date-keyed velocity key', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    await store.incrementTodayTransferCount('p');
    expect(redis.dump.has(`velocity:p:${easternDate(Date.now())}`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- store.test`
Expected: FAIL — `store.getTodayTransferCount is not a function`.

- [ ] **Step 3: Add the methods to `createStore` in `src/lib/store.ts`**

Add `import { easternDate } from './dates';` at the top. Inside the object returned by `createStore`, add:

```ts
    async incrementTodayTransferCount(phone: string): Promise<void> {
      await redis.incr(`velocity:${phone}:${easternDate(Date.now())}`);
    },
    async getTodayTransferCount(phone: string): Promise<number> {
      const raw = await redis.get(`velocity:${phone}:${easternDate(Date.now())}`);
      return raw ? Number(raw) : 0;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- store.test`
Expected: PASS — the 3 new velocity tests plus all existing store tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.ts tests/store.test.ts
git commit -m "feat: add per-day transfer velocity counters"
```

---

## Task 4: Compliance types + shared createTransfer + tool integration

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/tools.ts`
- Create: `src/lib/transfer-create.ts`
- Test: `tests/transfer-create.test.ts`, `tests/tools.test.ts`, and Transfer literals across `tests/`

This task bundles the `Transfer` type change with every consumer so the build
never breaks mid-task.

- [ ] **Step 1: Update `src/lib/types.ts`**

Change `TransferStatus` and add compliance types/fields:

```ts
export type TransferStatus =
  | 'awaiting_payment'
  | 'paid'
  | 'delivered'
  | 'cancelled'
  | 'blocked';

export type ComplianceStatus = 'cleared' | 'flagged' | 'blocked';
```

In the `Transfer` interface, add these two fields (after `fundingMethod`):

```ts
  complianceStatus: ComplianceStatus;
  complianceReasons: string[];
```

- [ ] **Step 2: Update every `Transfer` object literal so the suite compiles**

Search `src/` and `tests/` for objects typed as `Transfer` (test helpers like
`sampleTransfer`, `awaitingTransfer`, and any inline literal in
`tests/store.test.ts`, `tests/payment.test.ts`, `tests/dashboard.test.ts`,
`tests/dashboard-ops.test.ts`, `tests/e2e.test.ts`). Add to each:

```ts
  complianceStatus: 'cleared',
  complianceReasons: [],
```

- [ ] **Step 3: Write the failing test `tests/transfer-create.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTransfer } from '@/lib/transfer-create';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }),
  );
});
afterEach(() => vi.restoreAllMocks());

const base = {
  phone: '15551234567',
  amountUsd: 200,
  recipientName: 'Mom',
  recipientPhone: '919133001840',
  payoutMethod: 'upi' as const,
  payoutDestination: 'mom@upi',
  fundingMethod: 'bank_transfer' as const,
};

describe('createTransfer', () => {
  it('creates a cleared transfer in awaiting_payment', async () => {
    const store = createStore(fakeRedis());
    const t = await createTransfer(store, base);
    expect(t.status).toBe('awaiting_payment');
    expect(t.complianceStatus).toBe('cleared');
    expect(await store.getTransfer(t.id)).not.toBeNull();
  });

  it('blocks a watchlisted recipient and sets status blocked', async () => {
    const store = createStore(fakeRedis());
    const t = await createTransfer(store, { ...base, recipientName: 'John Doe' });
    expect(t.complianceStatus).toBe('blocked');
    expect(t.status).toBe('blocked');
  });

  it('flags a large amount but stays awaiting_payment', async () => {
    const store = createStore(fakeRedis());
    const t = await createTransfer(store, { ...base, amountUsd: 1500 });
    expect(t.complianceStatus).toBe('flagged');
    expect(t.status).toBe('awaiting_payment');
  });

  it('increments the all-time and today counters', async () => {
    const store = createStore(fakeRedis());
    await createTransfer(store, base);
    expect(await store.getTransferCount(base.phone)).toBe(1);
    expect(await store.getTodayTransferCount(base.phone)).toBe(1);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- transfer-create`
Expected: FAIL — cannot resolve `@/lib/transfer-create`.

- [ ] **Step 5: Create `src/lib/transfer-create.ts`**

```ts
import { quote } from './fx';
import { getFxRate } from './rate';
import { screenTransfer } from './compliance';
import { newTransferId } from './id';
import type { Store } from './store';
import type { FundingMethod, PayoutMethod, Transfer } from './types';

export interface CreateTransferInput {
  phone: string;
  amountUsd: number;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
}

export async function createTransfer(
  store: Store,
  input: CreateTransferInput,
): Promise<Transfer> {
  const transferCount = await store.getTransferCount(input.phone);
  const fxRate = await getFxRate();
  const q = quote(input.amountUsd, fxRate, input.fundingMethod, transferCount);
  const transfersToday = await store.getTodayTransferCount(input.phone);
  const compliance = screenTransfer({
    amountUsd: input.amountUsd,
    recipientName: input.recipientName,
    transfersToday,
  });
  const transfer: Transfer = {
    id: newTransferId(),
    phone: input.phone,
    amountUsd: q.amountUsd,
    feeUsd: q.feeUsd,
    totalChargeUsd: q.totalChargeUsd,
    fxRate: q.fxRate,
    amountInr: q.amountInr,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    payoutMethod: input.payoutMethod,
    payoutDestination: input.payoutDestination,
    fundingMethod: input.fundingMethod,
    complianceStatus: compliance.status,
    complianceReasons: compliance.reasons,
    status: compliance.status === 'blocked' ? 'blocked' : 'awaiting_payment',
    createdAt: new Date().toISOString(),
  };
  await store.saveTransfer(transfer);
  await store.incrementTransferCount(input.phone);
  await store.incrementTodayTransferCount(input.phone);
  return transfer;
}
```

- [ ] **Step 6: Refactor the `create_transfer` executor in `src/lib/tools.ts`**

Add `import { createTransfer } from './transfer-create';` at the top. Replace the body of the `create_transfer` executor (`createTransferTool`) with:

```ts
async function createTransferTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return {
      error:
        'A valid recipient WhatsApp number with country code is required before creating the transfer. Ask the user for it (e.g. 919876543210).',
    };
  }
  try {
    const transfer = await createTransfer(ctx.store, {
      phone: ctx.phone,
      amountUsd: Number(args.amount_usd),
      recipientName: String(args.recipient_name),
      recipientPhone,
      payoutMethod: args.payout_method as PayoutMethod,
      payoutDestination: String(args.payout_destination),
      fundingMethod: args.funding_method as FundingMethod,
    });
    return {
      transfer_id: transfer.id,
      status: transfer.status,
      compliance_status: transfer.complianceStatus,
      compliance_reasons: transfer.complianceReasons,
      amount_inr: transfer.amountInr,
      total_charge_usd: transfer.totalChargeUsd,
      recipient_name: transfer.recipientName,
    };
  } catch (err) {
    if (err instanceof QuoteError) return { error: err.message };
    throw err;
  }
}
```

- [ ] **Step 7: Add the blocked guard to `generate_payment_link`**

In the `generatePaymentLinkTool` executor in `src/lib/tools.ts`, after loading
the transfer and the not-found check, add:

```ts
  if (transfer.status === 'blocked') {
    return {
      error: 'This transfer did not pass compliance and cannot be paid.',
    };
  }
```

- [ ] **Step 8: Update `tests/tools.test.ts`**

The `create_transfer` tests must stub `global.fetch` for `getFxRate` (see the
pattern in `tests/transfer-create.test.ts` Step 3 — `beforeEach` stub + cache
reset) and assert the result now includes `compliance_status`. Add a test: a
`create_transfer` with `recipient_name: 'John Doe'` returns
`compliance_status: 'blocked'` and `status: 'blocked'`, and a follow-up
`generate_payment_link` for that transfer returns an `{ error }`.

- [ ] **Step 9: Run the full suite and build**

Run: `npm test`
Expected: PASS — all files green.
Run: `npm run build`
Expected: PASS — no type errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/types.ts src/lib/transfer-create.ts src/lib/tools.ts tests/
git commit -m "feat: screen every transfer for compliance, block/flag accordingly"
```

---

## Task 5: Surface compliance on the dashboard

**Files:**
- Modify: `src/lib/dashboard.ts`, `src/app/dashboard/page.tsx`
- Test: `tests/dashboard.test.ts`

- [ ] **Step 1: Add tests to `tests/dashboard.test.ts`**

```ts
import { needsAttention } from '@/lib/dashboard';

describe('needsAttention', () => {
  const baseNow = Date.parse('2026-05-21T16:00:00.000Z');
  function t(overrides: Partial<Transfer>): Transfer {
    return {
      id: 'x', phone: 'p', amountUsd: 100, feeUsd: 0, totalChargeUsd: 100,
      fxRate: 85, amountInr: 8500, recipientName: 'R', recipientPhone: '91999',
      payoutMethod: 'upi', payoutDestination: 'r@upi', fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared', complianceReasons: [],
      status: 'awaiting_payment', createdAt: new Date(baseNow).toISOString(),
      ...overrides,
    };
  }

  it('is false for a fresh cleared transfer', () => {
    expect(needsAttention(t({}), baseNow)).toBe(false);
  });
  it('is true for a flagged transfer', () => {
    expect(needsAttention(t({ complianceStatus: 'flagged' }), baseNow)).toBe(true);
  });
  it('is true for a blocked transfer', () => {
    expect(needsAttention(t({ complianceStatus: 'blocked', status: 'blocked' }), baseNow)).toBe(true);
  });
  it('is true for an abandoned (old awaiting_payment) transfer', () => {
    const old = baseNow - 60 * 60 * 1000;
    expect(needsAttention(t({ createdAt: new Date(old).toISOString() }), baseNow)).toBe(true);
  });
});
```

Also extend the existing `summarize` tests: assert the returned summary has a
numeric `flaggedToday` field.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dashboard.test`
Expected: FAIL — `needsAttention` is not exported.

- [ ] **Step 3: Update `src/lib/dashboard.ts`**

Add an exported `needsAttention` function:

```ts
export function needsAttention(transfer: Transfer, now: number): boolean {
  if (transfer.complianceStatus === 'flagged') return true;
  if (transfer.complianceStatus === 'blocked') return true;
  return isAbandoned(transfer, now);
}
```

Add `flaggedToday` to the `DashboardSummary` interface and compute it in
`summarize`: the count of today's transfers (same "today" rule already used
for `countToday`) whose `complianceStatus` is `'flagged'` or `'blocked'`.

- [ ] **Step 4: Update `src/app/dashboard/page.tsx`**

- Add a **Compliance** column header and cell to the ledger table. The cell
  renders a badge: `<span className={`status-badge compliance-${t.complianceStatus}`}>{t.complianceStatus}</span>`.
- Replace the `abandoned` filter for the Needs Attention panel and the
  `row-abandoned` row class with `needsAttention(t, now)` (import it from
  `@/lib/dashboard`).
- Add a fifth summary metric card "Flagged today" showing `summary.flaggedToday`.

- [ ] **Step 5: Run the suite and build**

Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard.ts src/app/dashboard/page.tsx tests/dashboard.test.ts
git commit -m "feat: show compliance status on the dashboard"
```

---

## Task 6: Schedule types + schedule store

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/lib/schedule-store.ts`
- Test: `tests/schedule-store.test.ts`

- [ ] **Step 1: Append schedule types to `src/lib/types.ts`**

```ts
export type ScheduleFrequency = 'monthly' | 'weekly';
export type ScheduleStatus = 'active' | 'cancelled';

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
}
```

- [ ] **Step 2: Write the failing test `tests/schedule-store.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { fakeRedis } from './helpers';
import type { Schedule } from '@/lib/types';

function schedule(id: string, status: Schedule['status'] = 'active'): Schedule {
  return {
    id, phone: '15551234567', amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 2, status,
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('schedule-store', () => {
  it('round-trips a schedule', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a'));
    expect((await s.getSchedule('a'))?.amountUsd).toBe(200);
  });

  it('returns null for an unknown schedule', async () => {
    expect(await createScheduleStore(fakeRedis()).getSchedule('nope')).toBeNull();
  });

  it('lists all schedules', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('b'));
    expect(await s.listSchedules()).toHaveLength(2);
  });

  it('listActiveSchedules excludes cancelled', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a', 'active'));
    await s.saveSchedule(schedule('b', 'cancelled'));
    const active = await s.listActiveSchedules();
    expect(active.map((x) => x.id)).toEqual(['a']);
  });

  it('re-saving a schedule does not duplicate it in the index', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('a'));
    expect(await s.listSchedules()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- schedule-store`
Expected: FAIL — cannot resolve `@/lib/schedule-store`.

- [ ] **Step 4: Create `src/lib/schedule-store.ts`**

```ts
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';
import type { Schedule } from './types';

export function createScheduleStore(redis: RedisLike) {
  return {
    async getSchedule(id: string): Promise<Schedule | null> {
      const raw = await redis.get(`schedule:${id}`);
      return raw ? (JSON.parse(raw) as Schedule) : null;
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
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    cached = createScheduleStore(redis as unknown as RedisLike);
  }
  return cached;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- schedule-store`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/schedule-store.ts tests/schedule-store.test.ts
git commit -m "feat: add Schedule type and schedule store"
```

---

## Task 7: Schedule due-date logic

**Files:**
- Create: `src/lib/schedule.ts`
- Test: `tests/schedule.test.ts`

- [ ] **Step 1: Write the failing test `tests/schedule.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { isScheduleDueToday } from '@/lib/schedule';
import type { Schedule } from '@/lib/types';

// 2026-05-21T16:00:00Z = Thursday May 21, 2026 (day-of-month 21, weekday 4).
const NOW = Date.parse('2026-05-21T16:00:00.000Z');

function sched(overrides: Partial<Schedule>): Schedule {
  return {
    id: 's', phone: 'p', amountUsd: 100,
    recipientName: 'R', recipientPhone: '91999',
    payoutMethod: 'upi', payoutDestination: 'r@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 21, status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isScheduleDueToday', () => {
  it('monthly: due when dayOfMonth matches today', () => {
    expect(isScheduleDueToday(sched({ dayOfMonth: 21 }), NOW)).toBe(true);
  });
  it('monthly: not due on a different day', () => {
    expect(isScheduleDueToday(sched({ dayOfMonth: 5 }), NOW)).toBe(false);
  });
  it('weekly: due when dayOfWeek matches today', () => {
    expect(isScheduleDueToday(
      sched({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 4 }), NOW,
    )).toBe(true);
  });
  it('weekly: not due on a different weekday', () => {
    expect(isScheduleDueToday(
      sched({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 1 }), NOW,
    )).toBe(false);
  });
  it('cancelled schedules are never due', () => {
    expect(isScheduleDueToday(sched({ status: 'cancelled' }), NOW)).toBe(false);
  });
  it('not due again if it already ran today', () => {
    expect(isScheduleDueToday(
      sched({ lastRunAt: new Date(NOW).toISOString() }), NOW,
    )).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- schedule.test`
Expected: FAIL — cannot resolve `@/lib/schedule`.

- [ ] **Step 3: Create `src/lib/schedule.ts`**

```ts
import { easternDate, easternDayOfMonth, easternDayOfWeek } from './dates';
import type { Schedule } from './types';

export function isScheduleDueToday(schedule: Schedule, now: number): boolean {
  if (schedule.status !== 'active') return false;
  if (
    schedule.lastRunAt &&
    easternDate(Date.parse(schedule.lastRunAt)) === easternDate(now)
  ) {
    return false;
  }
  if (schedule.frequency === 'monthly') {
    return schedule.dayOfMonth === easternDayOfMonth(now);
  }
  return schedule.dayOfWeek === easternDayOfWeek(now);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- schedule.test`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule.ts tests/schedule.test.ts
git commit -m "feat: add schedule due-date logic"
```

---

## Task 8: Schedule agent tools + agent wiring + prompt

**Files:**
- Modify: `src/lib/tools.ts`, `src/lib/agent.ts`, `src/lib/prompt.ts`, `src/app/api/whatsapp/route.ts`
- Test: `tests/tools.test.ts`, `tests/agent.test.ts`

- [ ] **Step 1: Extend `ToolContext` and add schedule tools — write failing tests**

Add to `tests/tools.test.ts` a describe block. The tools need a schedule store
in `ToolContext`; tests build one with `createScheduleStore(fakeRedis())`:

```ts
import { createScheduleStore } from '@/lib/schedule-store';

describe('schedule tools', () => {
  function ctx() {
    return {
      phone: '15551234567',
      store: createStore(fakeRedis()),
      scheduleStore: createScheduleStore(fakeRedis()),
    };
  }

  it('create_schedule saves a monthly schedule', async () => {
    const c = ctx();
    const r = await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '+91 9133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 2,
    }, c);
    expect(r.schedule_id).toBeTruthy();
    const saved = await c.scheduleStore.getSchedule(r.schedule_id as string);
    expect(saved?.frequency).toBe('monthly');
    expect(saved?.recipientPhone).toBe('919133001840');
  });

  it('create_schedule rejects an out-of-range day_of_month', async () => {
    const r = await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 31,
    }, ctx());
    expect(r.error).toMatch(/day of the month/i);
  });

  it('list_schedules returns only this customer active schedules', async () => {
    const c = ctx();
    await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'weekly', day_of_week: 5,
    }, c);
    const r = await executeTool('list_schedules', {}, c);
    expect((r.schedules as unknown[]).length).toBe(1);
  });

  it('cancel_schedule cancels an existing schedule', async () => {
    const c = ctx();
    const created = await executeTool('create_schedule', {
      amount_usd: 200, recipient_name: 'Mom', recipient_phone: '919133001840',
      payout_method: 'upi', payout_destination: 'mom@upi', funding_method: 'bank_transfer',
      frequency: 'monthly', day_of_month: 2,
    }, c);
    await executeTool('cancel_schedule', { schedule_id: created.schedule_id }, c);
    const saved = await c.scheduleStore.getSchedule(created.schedule_id as string);
    expect(saved?.status).toBe('cancelled');
  });
});
```

Also update the existing `toolSchemas` names test to expect the three new tool
names (`create_schedule`, `list_schedules`, `cancel_schedule`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools.test`
Expected: FAIL — `executeTool` does not handle `create_schedule`; `ToolContext`
has no `scheduleStore`.

- [ ] **Step 3: Update `ToolContext` and add the schedule tools in `src/lib/tools.ts`**

Add imports:

```ts
import type { ScheduleStore } from './schedule-store';
import type { Schedule } from './types';
import { newTransferId } from './id';
```

Change `ToolContext` to:

```ts
export interface ToolContext {
  phone: string;
  store: Store;
  scheduleStore: ScheduleStore;
}
```

Add three entries to `toolSchemas` (`create_schedule`, `list_schedules`,
`cancel_schedule`):

```ts
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description:
        'Set up a recurring transfer that repeats monthly or weekly. Collect all recipient details first, just like create_transfer.',
      parameters: {
        type: 'object',
        properties: {
          amount_usd: { type: 'number' },
          recipient_name: { type: 'string' },
          recipient_phone: { type: 'string', description: "Recipient's WhatsApp number with country code." },
          payout_method: { type: 'string', enum: ['upi', 'bank'] },
          payout_destination: { type: 'string' },
          funding_method: { type: 'string', enum: ['credit_card', 'debit_card', 'bank_transfer'] },
          frequency: { type: 'string', enum: ['monthly', 'weekly'] },
          day_of_month: { type: 'number', description: 'Day 1-28, required when frequency is monthly.' },
          day_of_week: { type: 'number', description: 'Day 0 (Sunday) to 6 (Saturday), required when frequency is weekly.' },
        },
        required: ['amount_usd', 'recipient_name', 'recipient_phone', 'payout_method', 'payout_destination', 'funding_method', 'frequency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_schedules',
      description: "List the customer's active recurring transfer schedules.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_schedule',
      description: 'Cancel a recurring transfer schedule by its id.',
      parameters: {
        type: 'object',
        properties: { schedule_id: { type: 'string' } },
        required: ['schedule_id'],
      },
    },
  },
```

Add three cases to the `executeTool` switch (`create_schedule`,
`list_schedules`, `cancel_schedule`) and these executor functions:

```ts
async function createScheduleTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const recipientPhone = normalizePhone(args.recipient_phone);
  if (!isValidPhone(recipientPhone)) {
    return { error: 'A valid recipient WhatsApp number with country code is required.' };
  }
  const frequency = args.frequency === 'weekly' ? 'weekly' : 'monthly';
  let dayOfMonth: number | undefined;
  let dayOfWeek: number | undefined;
  if (frequency === 'monthly') {
    dayOfMonth = Number(args.day_of_month);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
      return { error: 'For a monthly schedule, pick a day of the month between 1 and 28.' };
    }
  } else {
    dayOfWeek = Number(args.day_of_week);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      return { error: 'For a weekly schedule, pick a day of the week from 0 (Sunday) to 6 (Saturday).' };
    }
  }
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
  };
  await ctx.scheduleStore.saveSchedule(schedule);
  return {
    schedule_id: schedule.id,
    frequency: schedule.frequency,
    day_of_month: schedule.dayOfMonth ?? null,
    day_of_week: schedule.dayOfWeek ?? null,
  };
}

async function listSchedulesTool(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const all = await ctx.scheduleStore.listActiveSchedules();
  const mine = all.filter((s) => s.phone === ctx.phone);
  return {
    schedules: mine.map((s) => ({
      schedule_id: s.id,
      amount_usd: s.amountUsd,
      recipient_name: s.recipientName,
      frequency: s.frequency,
      day_of_month: s.dayOfMonth ?? null,
      day_of_week: s.dayOfWeek ?? null,
    })),
  };
}

async function cancelScheduleTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const schedule = await ctx.scheduleStore.getSchedule(String(args.schedule_id));
  if (!schedule || schedule.phone !== ctx.phone) {
    return { error: 'Schedule not found.' };
  }
  schedule.status = 'cancelled';
  await ctx.scheduleStore.saveSchedule(schedule);
  return { schedule_id: schedule.id, status: schedule.status };
}
```

- [ ] **Step 4: Wire `scheduleStore` through the agent — `src/lib/agent.ts`**

Add `import type { ScheduleStore } from './schedule-store';`. Add
`scheduleStore: ScheduleStore;` to the `AgentDeps` interface. In `runAgentTurn`,
where `executeTool` is called, pass `scheduleStore: deps.scheduleStore` in the
context object alongside `phone` and `store`.

- [ ] **Step 5: Update `tests/agent.test.ts`**

Every `createAgent({ ... })` call in the test file must now also pass
`scheduleStore: createScheduleStore(fakeRedis())` (import `createScheduleStore`
from `@/lib/schedule-store`). The existing assertions are unchanged.

- [ ] **Step 6: Wire `scheduleStore` in the webhook route — `src/app/api/whatsapp/route.ts`**

Add `import { getScheduleStore } from '@/lib/schedule-store';`. In the `after()`
callback where `createAgent({ chat, store })` is called, change it to
`createAgent({ chat, store, scheduleStore: getScheduleStore() })`.

- [ ] **Step 7: Update `src/lib/prompt.ts`**

Add a section to `SYSTEM_PROMPT`: the assistant can set up **recurring
transfers**. If a customer asks to send money on a repeating schedule, collect
the same recipient details as a normal transfer plus the frequency (monthly or
weekly) and the day (day-of-month 1–28 for monthly, or weekday for weekly), then
call `create_schedule`. Use `list_schedules` / `cancel_schedule` when the
customer asks to see or stop their schedules. Explain to the customer that on
each scheduled date they will receive a WhatsApp payment link to approve that
transfer.

- [ ] **Step 8: Run the full suite and build**

Run: `npm test`
Expected: PASS — all green.
Run: `npm run build`
Expected: PASS — no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/tools.ts src/lib/agent.ts src/lib/prompt.ts src/app/api/whatsapp/route.ts tests/
git commit -m "feat: add recurring-transfer scheduling tools to the chat agent"
```

---

## Task 9: Cron run logic

**Files:**
- Create: `src/lib/cron-run.ts`
- Modify: `src/lib/whatsapp.ts`
- Test: `tests/cron-run.test.ts`

- [ ] **Step 1: Add the scheduled-template constant to `src/lib/whatsapp.ts`**

Alongside `RECIPIENT_TEMPLATE_NAME`, add:

```ts
export const SCHEDULED_TEMPLATE_NAME = 'scheduled_payment_ready';
```

- [ ] **Step 2: Write the failing test `tests/cron-run.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDueSchedules } from '@/lib/cron-run';
import { createStore } from '@/lib/store';
import { createScheduleStore } from '@/lib/schedule-store';
import { fakeRedis } from './helpers';
import { resetRateCacheForTests } from '@/lib/rate';
import type { Schedule } from '@/lib/types';

beforeEach(() => {
  resetRateCacheForTests();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rates: { INR: 85 } }) }),
  );
});
afterEach(() => vi.restoreAllMocks());

const NOW = Date.parse('2026-05-21T16:00:00.000Z'); // day-of-month 21

function sched(id: string, dayOfMonth: number): Schedule {
  return {
    id, phone: '15551234567', amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth, status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('runDueSchedules', () => {
  it('fires a due schedule: creates a transfer, notifies, records lastRunAt', async () => {
    const store = createStore(fakeRedis());
    const scheduleStore = createScheduleStore(fakeRedis());
    await scheduleStore.saveSchedule(sched('due', 21));
    await scheduleStore.saveSchedule(sched('notdue', 5));
    const notified: string[] = [];

    const result = await runDueSchedules({
      store, scheduleStore, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('/pay/');
    expect((await store.listTransfers())).toHaveLength(1);
    expect((await scheduleStore.getSchedule('due'))?.lastRunAt).toBeTruthy();
    expect((await scheduleStore.getSchedule('notdue'))?.lastRunAt).toBeUndefined();
  });

  it('does not notify when the created transfer is compliance-blocked', async () => {
    const store = createStore(fakeRedis());
    const scheduleStore = createScheduleStore(fakeRedis());
    const blocked = sched('b', 21);
    blocked.recipientName = 'John Doe'; // on the watchlist
    await scheduleStore.saveSchedule(blocked);
    const notified: string[] = [];

    const result = await runDueSchedules({
      store, scheduleStore, now: NOW,
      sendScheduledLink: async (_s, _t, url) => { notified.push(url); },
    });

    expect(result.fired).toBe(1);
    expect(notified).toHaveLength(0); // blocked → no payment link sent
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- cron-run`
Expected: FAIL — cannot resolve `@/lib/cron-run`.

- [ ] **Step 4: Create `src/lib/cron-run.ts`**

```ts
import { isScheduleDueToday } from './schedule';
import { createTransfer } from './transfer-create';
import { env } from './env';
import type { Store } from './store';
import type { ScheduleStore } from './schedule-store';
import type { Schedule, Transfer } from './types';

export interface CronDeps {
  store: Store;
  scheduleStore: ScheduleStore;
  now: number;
  sendScheduledLink: (
    schedule: Schedule,
    transfer: Transfer,
    url: string,
  ) => Promise<void>;
}

export async function runDueSchedules(
  deps: CronDeps,
): Promise<{ fired: number }> {
  const schedules = await deps.scheduleStore.listActiveSchedules();
  let fired = 0;
  for (const schedule of schedules) {
    if (!isScheduleDueToday(schedule, deps.now)) continue;
    try {
      const transfer = await createTransfer(deps.store, {
        phone: schedule.phone,
        amountUsd: schedule.amountUsd,
        recipientName: schedule.recipientName,
        recipientPhone: schedule.recipientPhone,
        payoutMethod: schedule.payoutMethod,
        payoutDestination: schedule.payoutDestination,
        fundingMethod: schedule.fundingMethod,
      });
      if (transfer.status !== 'blocked') {
        const url = `${env.appBaseUrl}/pay/${transfer.id}`;
        await deps.sendScheduledLink(schedule, transfer, url);
      }
      schedule.lastRunAt = new Date(deps.now).toISOString();
      await deps.scheduleStore.saveSchedule(schedule);
      fired++;
    } catch (err) {
      console.error('Schedule run failed:', schedule.id, err);
    }
  }
  return { fired };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- cron-run`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cron-run.ts src/lib/whatsapp.ts tests/cron-run.test.ts
git commit -m "feat: add recurring-schedule cron run logic"
```

---

## Task 10: Cron route + Vercel cron config

**Files:**
- Create: `src/app/api/cron/route.ts`, `vercel.json`
- Modify: `src/lib/env.ts`

- [ ] **Step 1: Add an optional `cronSecret` getter to `src/lib/env.ts`**

Add to the `env` object (it is optional — uses a plain read, not `required`):

```ts
  get cronSecret() {
    return process.env.CRON_SECRET ?? '';
  },
```

- [ ] **Step 2: Create `src/app/api/cron/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { runDueSchedules } from '@/lib/cron-run';
import {
  sendTemplate,
  SCHEDULED_TEMPLATE_NAME,
  RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  // When CRON_SECRET is configured, Vercel sends it as a Bearer token.
  if (env.cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const result = await runDueSchedules({
    store: getStore(),
    scheduleStore: getScheduleStore(),
    now: Date.now(),
    sendScheduledLink: async (schedule, _transfer, url) => {
      try {
        await sendTemplate(
          schedule.phone,
          SCHEDULED_TEMPLATE_NAME,
          RECIPIENT_TEMPLATE_LANG,
          [
            `$${schedule.amountUsd.toFixed(2)}`,
            schedule.recipientName,
            url,
          ],
        );
      } catch (err) {
        console.error('Scheduled-link send failed:', schedule.id, err);
      }
    },
  });

  return NextResponse.json({ ok: true, fired: result.fired });
}
```

- [ ] **Step 3: Create `vercel.json`**

```json
{
  "crons": [
    {
      "path": "/api/cron",
      "schedule": "0 13 * * *"
    }
  ]
}
```

(`0 13 * * *` = 13:00 UTC daily — once per day, which is the only cron frequency
the current Vercel plan allows.)

- [ ] **Step 4: Run the suite and build**

Run: `npm test`
Expected: PASS — all green.
Run: `npm run build`
Expected: PASS — the `/api/cron` route appears in the build output.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/route.ts vercel.json src/lib/env.ts
git commit -m "feat: add daily cron route for recurring transfers"
```

---

## Task 11: Recurring Schedules section on the dashboard

**Files:**
- Modify: `src/app/dashboard/page.tsx`, `src/app/globals.css`

- [ ] **Step 1: Add the Recurring Schedules section to `src/app/dashboard/page.tsx`**

Add `import { getScheduleStore } from '@/lib/schedule-store';` and
`import { easternDayOfMonth, easternDayOfWeek } from '@/lib/dates';`.

In `DashboardPage`, after loading transfers, load schedules:

```ts
  const schedules = await getScheduleStore().listSchedules();
```

Add a helper and a section component (place the helpers near the other
formatting helpers, and render the section after the ledger section):

```tsx
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function scheduleWhen(s: import('@/lib/types').Schedule): string {
  if (s.frequency === 'monthly') return `Monthly · day ${s.dayOfMonth}`;
  return `Weekly · ${WEEKDAYS[s.dayOfWeek ?? 0]}`;
}
```

Section JSX (rendered inside `<main className="dashboard">`, after the ledger
`<section>`):

```tsx
      <section className="ledger-section">
        <h2>Recurring Schedules</h2>
        {schedules.length === 0 ? (
          <p className="empty-state">No recurring schedules yet.</p>
        ) : (
          <div className="ledger-wrapper">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Recipient</th>
                  <th>Amount</th>
                  <th>When</th>
                  <th>Last run</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id}>
                    <td>{s.recipientName}</td>
                    <td>{usd(s.amountUsd)}</td>
                    <td>{scheduleWhen(s)}</td>
                    <td>
                      {s.lastRunAt
                        ? new Date(s.lastRunAt).toLocaleDateString()
                        : '—'}
                    </td>
                    <td>
                      <span className={`status-badge status-${s.status}`}>
                        {s.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
```

- [ ] **Step 2: Add compliance badge styles to `src/app/globals.css`**

```css
.compliance-cleared { background: #1f3a2a; color: #25d366; }
.compliance-flagged { background: #4a3a1a; color: #f0c000; }
.compliance-blocked { background: #4a1f1f; color: #f15c6d; }
```

- [ ] **Step 3: Run the suite and build**

Run: `npm test`
Expected: PASS — all green.
Run: `npm run build`
Expected: PASS — `/dashboard` compiles, no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/page.tsx src/app/globals.css
git commit -m "feat: show recurring schedules on the dashboard"
```

---

## Manual Verification (after deployment)

1. Create the WhatsApp template `scheduled_payment_ready` (Utility, English (US)),
   body: *"Hi! Your scheduled SendHome transfer of {{1}} to {{2}} is ready. Tap to pay securely: {{3}}"* — samples: `$200.00`, `Mom`, a URL. Submit for approval.
2. Set `CRON_SECRET` on Vercel (any random string); deploy.
3. In WhatsApp, send a normal transfer with a large amount (≥ $1000) → confirm it
   shows **flagged** on the dashboard and appears in Needs Attention.
4. Send a transfer to recipient name "John Doe" → confirm it is **blocked**, no
   payment link is offered.
5. Ask the bot to set up a recurring transfer; confirm it appears in the
   dashboard's Recurring Schedules section.
6. Trigger the cron manually: `curl -H "Authorization: Bearer <CRON_SECRET>" https://claude-payments.vercel.app/api/cron` — confirm a transfer is created for any schedule whose day matches today.

---

## Self-Review Notes

- **Spec coverage:** compliance engine (Task 2), velocity (Task 3), block/flag +
  status `blocked` + `Transfer` fields + `generate_payment_link` guard (Task 4),
  dashboard compliance surface + needs-attention (Task 5), `Schedule` + store
  (Task 6), due-date logic (Task 7), chat tools + prompt (Task 8), cron run
  (Task 9), cron route + `vercel.json` + template constant (Tasks 9–10),
  dashboard schedules section (Task 11). All spec sections map to a task.
- **Type consistency:** `ComplianceStatus`, `Transfer.complianceStatus/
  complianceReasons`, `Schedule`, `ScheduleStore`, `CreateTransferInput`,
  `CronDeps` defined once and reused; `createTransfer(store, input)` signature
  consistent across Tasks 4 and 9; `ToolContext` gains `scheduleStore` in Task 8
  and the agent + webhook are updated in the same task so the build stays green.
- **No placeholders:** every step has complete code or an exact command. The
  watchlist names and `scheduled_payment_ready` template text are concrete.
