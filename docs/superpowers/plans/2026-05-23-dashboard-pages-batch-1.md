# Dashboard Pages — Batch 1: Per-Feature Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `/dashboard` into focused per-feature routes — Transactions, Schedules, Compliance — with a slimmer Overview landing page; sidebar items become real route links.

**Architecture:** Each new page is a Next.js App Router server component that calls `requireStaff()`, fetches its own slice of data, and renders `<Sidebar active="…">` + `<main>`. The Transactions page wraps the existing `TransactionsTabs` client component with a new `TransactionsExplorer` that adds search + date-range filters. Two new pure aggregator helpers (`schedulesDueInRange`, `topVelocityToday`) feed the Schedules and Compliance pages.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Vitest, plain CSS (existing `sh-*` design tokens).

Reference spec: `docs/superpowers/specs/2026-05-23-dashboard-pages-batch-1-design.md`

---

## File Structure

```
MOD  src/lib/dashboard.ts                          - +nextDueAt, +schedulesDueInRange, +topVelocityToday
MOD  src/app/dashboard/sidebar.tsx                 - expanded SidebarActive union, real route links
NEW  src/app/dashboard/transactions-explorer.tsx   - 'use client'; wraps TransactionsTabs with search + date filter
NEW  src/app/dashboard/transactions/page.tsx       - full transactions ledger
NEW  src/app/dashboard/schedules/page.tsx          - schedules with due-in-7-days callout
NEW  src/app/dashboard/compliance/page.tsx         - flagged + blocked + watchlist + top velocity
MOD  src/app/dashboard/page.tsx                    - slimmer Overview landing page
```

---

## Task 1: Pure aggregator helpers

**Files:**
- Modify: `src/lib/dashboard.ts`
- Test: `tests/dashboard.test.ts`

- [ ] **Step 1: Add tests to `tests/dashboard.test.ts`**

Append the following describe blocks to the existing test file:

```ts
import {
  nextDueAt,
  schedulesDueInRange,
  topVelocityToday,
} from '@/lib/dashboard';
import type { Schedule } from '@/lib/types';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 's',
    phone: 'p',
    amountUsd: 100,
    recipientName: 'R',
    recipientPhone: '91999',
    payoutMethod: 'upi',
    payoutDestination: 'r@upi',
    fundingMethod: 'bank_transfer',
    frequency: 'monthly',
    dayOfMonth: 5,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('nextDueAt', () => {
  // Pick a fixed moment: Friday May 22, 2026 17:00 UTC (~ noon ET, weekday 5 = Fri)
  const NOW = Date.parse('2026-05-22T17:00:00.000Z');

  it('monthly: next due is this month if day is today or later', () => {
    expect(nextDueAt(makeSchedule({ dayOfMonth: 28 }), NOW))
      .toBe(new Date(2026, 4, 28).getTime());
  });

  it('monthly: jumps to next month if day already passed', () => {
    expect(nextDueAt(makeSchedule({ dayOfMonth: 2 }), NOW))
      .toBe(new Date(2026, 5, 2).getTime());
  });

  it('weekly: due today when dayOfWeek matches today', () => {
    const s = makeSchedule({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 5 });
    const start = new Date(NOW);
    start.setHours(0, 0, 0, 0);
    expect(nextDueAt(s, NOW)).toBe(start.getTime());
  });

  it('weekly: due next occurrence when later in week', () => {
    const s = makeSchedule({ frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 1 });
    // From Fri (5), next Mon (1) is 3 days away
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    const expected = new Date(today); expected.setDate(today.getDate() + 3);
    expect(nextDueAt(s, NOW)).toBe(expected.getTime());
  });

  it('weekly: pushes to next week when lastRunAt is today', () => {
    const today = new Date(NOW); today.setHours(0, 0, 0, 0);
    const s = makeSchedule({
      frequency: 'weekly', dayOfMonth: undefined, dayOfWeek: 5,
      lastRunAt: today.toISOString(),
    });
    expect(nextDueAt(s, NOW)).toBe(today.getTime() + 7 * 86400000);
  });
});

describe('schedulesDueInRange', () => {
  const NOW = Date.parse('2026-05-22T17:00:00.000Z');

  it('returns only active schedules whose next due is within N days, sorted soonest first', () => {
    const a = makeSchedule({ id: 'a', dayOfMonth: 23 }); // tomorrow
    const b = makeSchedule({ id: 'b', dayOfMonth: 28 }); // 6 days
    const c = makeSchedule({ id: 'c', dayOfMonth: 1 });  // next month → 10 days
    const cancelled = makeSchedule({ id: 'd', dayOfMonth: 23, status: 'cancelled' });
    const result = schedulesDueInRange([cancelled, c, b, a], NOW, 7).map((s) => s.id);
    expect(result).toEqual(['a', 'b']); // c is out of range; cancelled excluded
  });

  it('returns empty when nothing is due in the window', () => {
    const farOff = makeSchedule({ dayOfMonth: 1 }); // ~10 days
    expect(schedulesDueInRange([farOff], NOW, 3)).toEqual([]);
  });
});

describe('topVelocityToday', () => {
  // Use the test-environment timezone; build createdAt from start-of-today.
  const NOW = Date.now();
  const todayIso = new Date(NOW).toISOString();
  const yesterdayIso = new Date(NOW - 36 * 60 * 60 * 1000).toISOString();

  function t(id: string, phone: string, createdAt: string): import('@/lib/types').Transfer {
    return {
      id, phone, amountUsd: 100, feeUsd: 0, totalChargeUsd: 100,
      fxRate: 85, amountInr: 8500,
      recipientName: 'r', recipientPhone: '91999',
      payoutMethod: 'upi', payoutDestination: 'r@upi',
      fundingMethod: 'bank_transfer',
      complianceStatus: 'cleared', complianceReasons: [],
      status: 'awaiting_payment', createdAt,
    };
  }

  it('groups today transfers by phone and returns top N', () => {
    const transfers = [
      t('1', 'pA', todayIso),
      t('2', 'pA', todayIso),
      t('3', 'pA', todayIso),
      t('4', 'pB', todayIso),
      t('5', 'pB', todayIso),
      t('6', 'pC', todayIso),
      t('7', 'pD', yesterdayIso), // excluded — not today
    ];
    expect(topVelocityToday(transfers, NOW, 10)).toEqual([
      { phone: 'pA', count: 3 },
      { phone: 'pB', count: 2 },
      { phone: 'pC', count: 1 },
    ]);
  });

  it('respects the limit', () => {
    const transfers = [
      t('1', 'pA', todayIso),
      t('2', 'pB', todayIso),
      t('3', 'pC', todayIso),
    ];
    expect(topVelocityToday(transfers, NOW, 2)).toHaveLength(2);
  });

  it('returns empty array when no transfers today', () => {
    expect(topVelocityToday([t('1', 'pA', yesterdayIso)], NOW, 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- dashboard`
Expected: FAIL — `nextDueAt`, `schedulesDueInRange`, `topVelocityToday` are not exported.

- [ ] **Step 3: Add the helpers to `src/lib/dashboard.ts`**

Add these imports at the top (if not already present):

```ts
import type { Schedule } from './types';
```

(Leave existing imports alone.) Append at the end of the file:

```ts
function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function nextDueAt(schedule: Schedule, now: number): number {
  const ref = new Date(now);
  const todayStart = startOfDay(now);

  if (schedule.frequency === 'monthly') {
    const dom = schedule.dayOfMonth ?? 1;
    const d = new Date(ref.getFullYear(), ref.getMonth(), dom);
    if (d.getTime() < todayStart) {
      d.setMonth(d.getMonth() + 1);
    }
    return d.getTime();
  }

  // weekly
  const today = new Date(todayStart);
  const targetDow = schedule.dayOfWeek ?? 0;
  let daysUntil = (targetDow - today.getDay() + 7) % 7;
  if (daysUntil === 0 && schedule.lastRunAt) {
    if (isSameDay(new Date(schedule.lastRunAt), today)) {
      daysUntil = 7;
    }
  }
  const next = new Date(today);
  next.setDate(today.getDate() + daysUntil);
  return next.getTime();
}

export function schedulesDueInRange(
  schedules: Schedule[],
  now: number,
  days: number,
): Schedule[] {
  const cutoff = now + days * 86400000;
  const todayStart = startOfDay(now);
  return schedules
    .filter((s) => s.status === 'active')
    .map((s) => ({ s, due: nextDueAt(s, now) }))
    .filter(({ due }) => due >= todayStart && due <= cutoff)
    .sort((a, b) => a.due - b.due)
    .map(({ s }) => s);
}

export function topVelocityToday(
  transfers: Transfer[],
  now: number,
  limit: number,
): { phone: string; count: number }[] {
  const today = easternDate(now);
  const counts = new Map<string, number>();
  for (const t of transfers) {
    if (easternDate(Date.parse(t.createdAt)) === today) {
      counts.set(t.phone, (counts.get(t.phone) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([phone, count]) => ({ phone, count }))
    .sort((a, b) => b.count - a.count || a.phone.localeCompare(b.phone))
    .slice(0, limit);
}
```

`Transfer` and `easternDate` are already imported in `dashboard.ts` (used by existing `summarize`). Only the `Schedule` import is new.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- dashboard`
Expected: PASS — the new tests pass alongside the existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard.ts tests/dashboard.test.ts
git commit -m "feat(dashboard): add schedulesDueInRange and topVelocityToday helpers"
```

---

## Task 2: Sidebar — expanded active union + real route links

**Files:**
- Modify: `src/app/dashboard/sidebar.tsx`

After this task, the four section nav items link to real routes that don't exist yet (Tasks 4–6 create them). Hitting them will 404 in dev — that's expected mid-batch. Build stays green.

- [ ] **Step 1: Replace `src/app/dashboard/sidebar.tsx`**

```tsx
import { requireStaff } from '@/lib/auth';

export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'compliance'
  | 'team';

export async function Sidebar({ active }: { active: SidebarActive }) {
  const staff = await requireStaff();
  const isAdmin = staff.role === 'admin';

  return (
    <aside className="sh-sidebar">
      <a
        href="/dashboard"
        className={`sh-nav-item ${active === 'overview' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">◾</span> Overview
      </a>
      <a
        href="/dashboard/transactions"
        className={`sh-nav-item ${active === 'transactions' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↔</span> Transactions
      </a>
      <a
        href="/dashboard/schedules"
        className={`sh-nav-item ${active === 'schedules' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↻</span> Schedules
      </a>
      <a
        href="/dashboard/compliance"
        className={`sh-nav-item ${active === 'compliance' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">⚑</span> Compliance
      </a>
      {isAdmin && (
        <>
          <div className="sh-nav-label">Account</div>
          <a
            href="/dashboard/team"
            className={`sh-nav-item ${active === 'team' ? 'active' : ''}`}
          >
            <span className="sh-nav-icon">◉</span> Team
          </a>
          <a href="/dashboard" className="sh-nav-item">
            <span className="sh-nav-icon">⚙</span> Settings
          </a>
        </>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Run the build to confirm type-safety**

Run: `npm run build`
Expected: PASS — the existing `/dashboard` (active='overview') and `/dashboard/team` (active='team') still compile.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/sidebar.tsx
git commit -m "feat(dashboard): sidebar nav uses real routes; expanded active union"
```

---

## Task 3: TransactionsExplorer client component

**Files:**
- Create: `src/app/dashboard/transactions-explorer.tsx`

This is a stand-alone file; nothing imports it yet. Task 4 wires it into the new transactions page.

- [ ] **Step 1: Create `src/app/dashboard/transactions-explorer.tsx`**

```tsx
'use client';

import { useState } from 'react';
import type { Staff, Transfer } from '@/lib/types';
import { TransactionsTabs } from './transactions-tabs';

export interface TransactionsExplorerProps {
  transfers: Transfer[];
  staff: Staff[];
  staffByUsername: Record<string, string>;
  canCancel: boolean;
  canResend: boolean;
  canAssign: boolean;
  cancelAction: (formData: FormData) => void | Promise<void>;
  assignAction: (formData: FormData) => void | Promise<void>;
  resendAction: (formData: FormData) => void | Promise<void>;
  initialSearch?: string;
}

export function TransactionsExplorer(props: TransactionsExplorerProps) {
  const [search, setSearch] = useState(props.initialSearch ?? '');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const q = search.trim().toLowerCase();
  const fromMs = fromDate ? Date.parse(fromDate) : null;
  const toMs = toDate ? Date.parse(toDate) + 86400000 : null; // include the end date

  const filtered = props.transfers.filter((t) => {
    if (q) {
      const hay = `${t.recipientName} ${t.payoutDestination} ${t.phone}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (fromMs !== null && Date.parse(t.createdAt) < fromMs) return false;
    if (toMs !== null && Date.parse(t.createdAt) >= toMs) return false;
    return true;
  });

  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 10,
          padding: '16px 20px',
          borderBottom: '1px solid var(--sh-border)',
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Search recipient, destination, or sender phone…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sh-input"
          style={{ flex: 1, minWidth: 220 }}
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--sh-text-secondary)',
          }}
        >
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="sh-input"
          />
        </label>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'var(--sh-text-secondary)',
          }}
        >
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="sh-input"
          />
        </label>
      </div>
      <TransactionsTabs
        transfers={filtered}
        staff={props.staff}
        staffByUsername={props.staffByUsername}
        canCancel={props.canCancel}
        canResend={props.canResend}
        canAssign={props.canAssign}
        cancelAction={props.cancelAction}
        assignAction={props.assignAction}
        resendAction={props.resendAction}
      />
    </>
  );
}
```

- [ ] **Step 2: Run the build to confirm it compiles**

Run: `npm run build`
Expected: PASS — file is unused but type-checks.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/transactions-explorer.tsx
git commit -m "feat(dashboard): add TransactionsExplorer (search + date filters)"
```

---

## Task 4: Transactions page

**Files:**
- Create: `src/app/dashboard/transactions/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/transactions/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { Sidebar } from '../sidebar';
import { TransactionsExplorer } from '../transactions-explorer';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from '../actions';

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ phone?: string }>;
}) {
  const viewer = await requireStaff();
  const transfers = await getStore().listTransfers();
  const staff = await getAuthStore().listStaff();
  const params = await searchParams;
  const initialSearch = params.phone ?? '';

  return (
    <>
      <Sidebar active="transactions" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Transactions</div>
            <div className="sh-page-sub">All transfers, newest first</div>
          </div>
        </div>
        <section className="sh-card">
          <TransactionsExplorer
            transfers={transfers}
            staff={staff}
            staffByUsername={Object.fromEntries(
              staff.map((s) => [s.username, s.name]),
            )}
            canCancel={hasPermission(viewer, 'canCancel')}
            canResend={hasPermission(viewer, 'canResend')}
            canAssign={hasPermission(viewer, 'canAssign')}
            cancelAction={cancelTransferAction}
            assignAction={assignTransferAction}
            resendAction={resendPaymentLinkAction}
            initialSearch={initialSearch}
          />
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Build + tests**

Run: `npm test`
Expected: PASS — all existing + Task 1's new tests green.
Run: `npm run build`
Expected: PASS — `/dashboard/transactions` appears as a dynamic route.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/transactions/page.tsx
git commit -m "feat(dashboard): add /dashboard/transactions page"
```

---

## Task 5: Schedules page

**Files:**
- Create: `src/app/dashboard/schedules/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/schedules/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { getScheduleStore } from '@/lib/schedule-store';
import { requireStaff } from '@/lib/auth';
import { schedulesDueInRange } from '@/lib/dashboard';
import { Sidebar } from '../sidebar';
import type { Schedule } from '@/lib/types';

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

function scheduleWhen(s: Schedule): string {
  if (s.frequency === 'monthly') return `Monthly · day ${s.dayOfMonth}`;
  return `Weekly · ${WEEKDAYS[s.dayOfWeek ?? 0]}`;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export default async function SchedulesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  await requireStaff();
  const params = await searchParams;
  const showAll = params.show === 'all';
  const all = await getScheduleStore().listSchedules();
  const visible = showAll ? all : all.filter((s) => s.status === 'active');
  const now = Date.now();
  const dueIn7 = schedulesDueInRange(
    all.filter((s) => s.status === 'active'),
    now,
    7,
  );

  return (
    <>
      <Sidebar active="schedules" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Schedules</div>
            <div className="sh-page-sub">Recurring transfers</div>
          </div>
        </div>

        <section
          className="sh-attention"
          style={{ borderLeftColor: 'var(--sh-warning)' }}
        >
          <div
            className="sh-attention-title"
            style={{ color: 'var(--sh-warning)' }}
          >
            📅 Due in the next 7 days
            <span className="sh-attention-count">
              {dueIn7.length} {dueIn7.length === 1 ? 'schedule' : 'schedules'}
            </span>
          </div>
          {dueIn7.length === 0 ? (
            <div className="sh-attention-meta">
              Nothing due in the next 7 days.
            </div>
          ) : (
            dueIn7.map((s) => (
              <div key={s.id} className="sh-attention-row">
                <div className="sh-attention-info">
                  <div className="sh-attention-recipient">{s.recipientName}</div>
                  <div className="sh-attention-meta">
                    {usd(s.amountUsd)} · {scheduleWhen(s)}
                  </div>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">All Schedules</div>
              <div className="sh-card-sub">
                {visible.length} of {all.length}
                {' '}{all.length === 1 ? 'schedule' : 'schedules'}
              </div>
            </div>
            <div className="sh-tabs">
              <a
                href="/dashboard/schedules"
                className={`sh-tab ${!showAll ? 'active' : ''}`}
              >
                Active
              </a>
              <a
                href="/dashboard/schedules?show=all"
                className={`sh-tab ${showAll ? 'active' : ''}`}
              >
                All
              </a>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {visible.length === 0 ? (
              <div className="sh-empty">No schedules.</div>
            ) : (
              <table className="sh-table">
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
                  {visible.map((s) => (
                    <tr key={s.id}>
                      <td><div className="sh-recipient">{s.recipientName}</div></td>
                      <td className="sh-amount">{usd(s.amountUsd)}</td>
                      <td>{scheduleWhen(s)}</td>
                      <td>
                        {s.lastRunAt
                          ? new Date(s.lastRunAt).toLocaleDateString()
                          : <span className="sh-recipient-sub">—</span>}
                      </td>
                      <td>
                        <span className={`sh-pill ${
                          s.status === 'active' ? 'sh-pill-info' : 'sh-pill-neutral'
                        }`}>
                          <span className="sh-pill-dot"></span>{s.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — `/dashboard/schedules` appears as a dynamic route.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/schedules/page.tsx
git commit -m "feat(dashboard): add /dashboard/schedules page with due-soon callout"
```

---

## Task 6: Compliance page

**Files:**
- Create: `src/app/dashboard/compliance/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/compliance/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { requireStaff } from '@/lib/auth';
import { topVelocityToday } from '@/lib/dashboard';
import { WATCHLIST } from '@/lib/compliance';
import { Sidebar } from '../sidebar';
import type { Transfer } from '@/lib/types';

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
function inr(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}

function TransferRow({ t }: { t: Transfer }) {
  return (
    <tr>
      <td>
        <div className="sh-recipient">{t.recipientName}</div>
        <div className="sh-recipient-sub">
          {t.payoutMethod.toUpperCase()} · {t.payoutDestination}
        </div>
      </td>
      <td>
        <div className="sh-amount">{usd(t.amountUsd)}</div>
        <div className="sh-recipient-sub">{inr(t.amountInr)}</div>
      </td>
      <td>{t.complianceReasons.join(', ') || '—'}</td>
      <td>{new Date(t.createdAt).toLocaleString()}</td>
      <td><span className="sh-recipient-sub">{t.phone}</span></td>
    </tr>
  );
}

export default async function CompliancePage() {
  await requireStaff();
  const transfers = await getStore().listTransfers();
  const flagged = transfers.filter((t) => t.complianceStatus === 'flagged');
  const blocked = transfers.filter((t) => t.complianceStatus === 'blocked');
  const topVel = topVelocityToday(transfers, Date.now(), 10);

  return (
    <>
      <Sidebar active="compliance" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Compliance</div>
            <div className="sh-page-sub">
              Flagged + blocked transfers · watchlist · velocity
            </div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Flagged transfers</div>
              <div className="sh-card-sub">
                {flagged.length} {flagged.length === 1 ? 'transfer' : 'transfers'}
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {flagged.length === 0 ? (
              <div className="sh-empty">No flagged transfers.</div>
            ) : (
              <table className="sh-table">
                <thead><tr>
                  <th>Recipient</th><th>Amount</th><th>Reasons</th>
                  <th>Created</th><th>Sender</th>
                </tr></thead>
                <tbody>
                  {flagged.map((t) => <TransferRow key={t.id} t={t} />)}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Blocked transfers</div>
              <div className="sh-card-sub">
                {blocked.length} {blocked.length === 1 ? 'transfer' : 'transfers'}
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {blocked.length === 0 ? (
              <div className="sh-empty">No blocked transfers.</div>
            ) : (
              <table className="sh-table">
                <thead><tr>
                  <th>Recipient</th><th>Amount</th><th>Reasons</th>
                  <th>Created</th><th>Sender</th>
                </tr></thead>
                <tbody>
                  {blocked.map((t) => <TransferRow key={t.id} t={t} />)}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Watchlist</div>
              <div className="sh-card-sub">
                Recipient names that hard-block a transfer (read-only)
              </div>
            </div>
          </div>
          <div
            style={{
              padding: '16px 20px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            {WATCHLIST.map((name) => (
              <span key={name} className="sh-pill sh-pill-danger">
                <span className="sh-pill-dot"></span>{name}
              </span>
            ))}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Top velocity today</div>
              <div className="sh-card-sub">
                Phones with the most transfers today
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {topVel.length === 0 ? (
              <div className="sh-empty">No activity today yet.</div>
            ) : (
              <table className="sh-table">
                <thead><tr>
                  <th>Phone</th><th>Transfers today</th><th></th>
                </tr></thead>
                <tbody>
                  {topVel.map(({ phone, count }) => (
                    <tr key={phone}>
                      <td>{phone}</td>
                      <td className="sh-amount">{count}</td>
                      <td>
                        <a
                          href={`/dashboard/transactions?phone=${encodeURIComponent(phone)}`}
                          className="sh-mini-btn"
                        >
                          View transfers
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — `/dashboard/compliance` appears as a dynamic route.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/compliance/page.tsx
git commit -m "feat(dashboard): add /dashboard/compliance page (flagged, blocked, watchlist, velocity)"
```

---

## Task 7: Slim Overview page

**Files:**
- Modify: `src/app/dashboard/page.tsx`

- [ ] **Step 1: Replace `src/app/dashboard/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { getScheduleStore } from '@/lib/schedule-store';
import { requireStaff } from '@/lib/auth';
import {
  summarize,
  needsAttention,
  schedulesDueInRange,
} from '@/lib/dashboard';
import type { Schedule, Transfer } from '@/lib/types';
import { Sidebar } from './sidebar';

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
function inr(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}

function humanizeFunding(method: Transfer['fundingMethod']): string {
  if (method === 'credit_card') return 'Credit card';
  if (method === 'debit_card') return 'Debit card';
  return 'Bank transfer';
}

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday',
  'Thursday', 'Friday', 'Saturday',
];

function scheduleWhen(s: Schedule): string {
  if (s.frequency === 'monthly') return `Monthly · day ${s.dayOfMonth}`;
  return `Weekly · ${WEEKDAYS[s.dayOfWeek ?? 0]}`;
}

function statusPillClass(status: Transfer['status']): string {
  if (status === 'delivered') return 'sh-pill-success';
  if (status === 'paid') return 'sh-pill-info';
  if (status === 'awaiting_payment') return 'sh-pill-neutral';
  if (status === 'cancelled') return 'sh-pill-warning';
  return 'sh-pill-danger';
}

export default async function DashboardPage() {
  await requireStaff();
  const transfers = await getStore().listTransfers();
  const schedules = await getScheduleStore().listSchedules();
  const now = Date.now();
  const summary = summarize(transfers, now);
  const attentionCount = transfers.filter((t) => needsAttention(t, now)).length;
  const recent = transfers.slice(0, 5);
  const nextDue = schedulesDueInRange(
    schedules.filter((s) => s.status === 'active'),
    now,
    365,
  ).slice(0, 3);
  const todayLabel = new Date(now).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <>
      <Sidebar active="overview" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Overview</div>
            <div className="sh-page-sub">{todayLabel}</div>
          </div>
        </div>

        <section
          className="sh-metrics"
          style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}
        >
          <div className="sh-metric sh-metric-primary">
            <div className="sh-metric-label">Commission today</div>
            <div className="sh-metric-value">{usd(summary.commissionToday)}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Volume today</div>
            <div className="sh-metric-value">{usd(summary.volumeToday)}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Transactions today</div>
            <div className="sh-metric-value">{summary.countToday}</div>
          </div>
          <div className="sh-metric sh-metric-alert">
            <div className="sh-metric-label">Flagged today</div>
            <div className="sh-metric-value">{summary.flaggedToday}</div>
          </div>
        </section>

        {attentionCount > 0 && (
          <section className="sh-attention" style={{ marginBottom: 24 }}>
            <div className="sh-attention-title" style={{ alignItems: 'center' }}>
              ⚠ {attentionCount}{' '}
              {attentionCount === 1
                ? 'transfer needs'
                : 'transfers need'}{' '}
              attention
              <a
                href="/dashboard/compliance"
                className="sh-recipient-sub"
                style={{ marginLeft: 'auto' }}
              >
                View on Compliance →
              </a>
            </div>
          </section>
        )}

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Recent transactions</div>
              <div className="sh-card-sub">Last 5</div>
            </div>
            <a href="/dashboard/transactions" className="sh-btn-secondary">
              View all →
            </a>
          </div>
          <div className="sh-ledger-wrap">
            {recent.length === 0 ? (
              <div className="sh-empty">No transactions yet.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Amount</th>
                    <th>Funding</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div className="sh-recipient">{t.recipientName}</div>
                      </td>
                      <td>
                        <div className="sh-amount">{usd(t.amountUsd)}</div>
                        <div className="sh-recipient-sub">{inr(t.amountInr)}</div>
                      </td>
                      <td>{humanizeFunding(t.fundingMethod)}</td>
                      <td>
                        <span className={`sh-pill ${statusPillClass(t.status)}`}>
                          <span className="sh-pill-dot"></span>
                          {t.status.replace('_', ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Next due schedules</div>
              <div className="sh-card-sub">Next 3</div>
            </div>
            <a href="/dashboard/schedules" className="sh-btn-secondary">
              View all →
            </a>
          </div>
          <div className="sh-ledger-wrap">
            {nextDue.length === 0 ? (
              <div className="sh-empty">No schedules due soon.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr><th>Recipient</th><th>Amount</th><th>When</th></tr>
                </thead>
                <tbody>
                  {nextDue.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <div className="sh-recipient">{s.recipientName}</div>
                      </td>
                      <td className="sh-amount">{usd(s.amountUsd)}</td>
                      <td>{scheduleWhen(s)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Full suite + build**

Run: `npm test`
Expected: PASS — all tests green.
Run: `npm run build`
Expected: PASS — all routes (`/login`, `/dashboard`, `/dashboard/transactions`, `/dashboard/schedules`, `/dashboard/compliance`, `/dashboard/team`, `/pay/[transferId]`, `/api/whatsapp`, `/api/pay/[transferId]`, `/api/cron`) compile cleanly.

- [ ] **Step 3: Visual sanity check (manual, optional)**

Run `npm run dev`, log in, and click through each sidebar item:
- **Overview** — 4 metric cards, optional attention strip, recent 5 transactions, next 3 schedules with "View all →" links.
- **Transactions** — search box + From/To date inputs above the tabs; tabs filter; row actions work.
- **Schedules** — yellow "Due in 7 days" callout, then the table with Active/All toggle.
- **Compliance** — flagged + blocked tables, watchlist pills, top-velocity list with "View transfers" links that prefill the transactions search.
- **Team** — unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat(dashboard): slim Overview landing page"
```

---

## Manual Verification (after deployment)

1. Deploy to Vercel.
2. Log in at `https://claude-payments.vercel.app/dashboard`.
3. Confirm the Overview is now lighter (4 metrics, recent-5, next-3).
4. Click each sidebar item — Transactions, Schedules, Compliance, Team — each loads its own page with the active highlight.
5. On Compliance → Top velocity → click "View transfers" → transactions page opens with the phone pre-filled in the search.
6. Confirm WhatsApp webhook, pay route, and cron are all still 200.

---

## Self-Review Notes

- **Spec coverage:** helpers (Task 1), sidebar wiring (Task 2), TransactionsExplorer + Transactions page (Tasks 3-4), Schedules page (Task 5), Compliance page (Task 6), slim Overview (Task 7). All spec sections map to a task.
- **Type consistency:** `SidebarActive` extended in Task 2 to include all values the later page tasks pass; `TransactionsExplorerProps` mirrors `TransactionsTabsProps` exactly (plus `initialSearch`); `schedulesDueInRange` and `topVelocityToday` signatures consistent across Task 1 definitions and Tasks 5, 6, 7 callers.
- **No placeholders:** every step has complete code or an exact command.
- **Risks:** the `nextDueAt` helper uses the runtime timezone for date arithmetic rather than US Eastern explicitly. For the 7-day / 365-day windows used here, the timezone drift is irrelevant. If we ever need exact-day "due today" semantics matching the cron's Eastern-zone logic, we'd reuse `easternDayOfMonth` / `easternDayOfWeek` from `lib/dates.ts` instead — out of scope for this batch.
