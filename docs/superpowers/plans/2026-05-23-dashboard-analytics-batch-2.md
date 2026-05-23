# Dashboard Analytics — Batch 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/dashboard/analytics` page with 7 Recharts charts driven by a `?window=7|30|90` time-toggle, plus a new sidebar item.

**Architecture:** Pure aggregator helpers in `src/lib/analytics.ts` compute chart data server-side. The page is a `force-dynamic` server component; charts are small `'use client'` Recharts wrappers receiving plain data props. The toggle is a server-side query param. The dashboard layout's existing `<LiveRefresh>` polling keeps everything fresh.

**Tech Stack:** Next.js 16, TypeScript, Vitest, Recharts (new dep), existing `sh-*` CSS.

Reference spec: `docs/superpowers/specs/2026-05-23-dashboard-analytics-batch-2-design.md`

---

## File Structure

```
NEW  src/lib/analytics.ts                       - 8 pure aggregator helpers
NEW  src/app/dashboard/analytics/page.tsx       - server component (?window= toggle)
NEW  src/app/dashboard/analytics/charts.tsx     - 'use client'; 7 Recharts components
MOD  src/app/dashboard/sidebar.tsx              - +'analytics' to SidebarActive + nav item
MOD  package.json                               - +recharts
```

---

## Task 1: Install Recharts

**Files:**
- Modify: `package.json` (via npm)

- [ ] **Step 1: Install the dependency**

Run from the project root:
```bash
npm install recharts@^2.15.0
```

- [ ] **Step 2: Verify build still works**

Run: `npm test && npm run build`
Expected: PASS — all existing tests green, build compiles. `recharts` and `react-is` (its peer) added to `node_modules`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add recharts dependency"
```

---

## Task 2: Analytics aggregator helpers

**Files:**
- Create: `src/lib/analytics.ts`
- Test: `tests/analytics.test.ts`

- [ ] **Step 1: Write the failing test `tests/analytics.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import {
  transfersInWindow,
  dailyCounts,
  dailyVolume,
  dailyCommission,
  statusDistribution,
  complianceDistribution,
  fundingMethodMix,
  topRecipientsByCount,
  WINDOW_DAYS,
} from '@/lib/analytics';
import type { Transfer } from '@/lib/types';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-05-23T16:00:00.000Z');

function makeTransfer(overrides: Partial<Transfer>): Transfer {
  return {
    id: 't',
    phone: 'p',
    amountUsd: 100,
    feeUsd: 5,
    totalChargeUsd: 105,
    fxRate: 85,
    amountInr: 8500,
    recipientName: 'R',
    recipientPhone: '91999',
    payoutMethod: 'upi',
    payoutDestination: 'r@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'delivered',
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('WINDOW_DAYS', () => {
  it('exports the three supported windows', () => {
    expect(WINDOW_DAYS).toEqual([7, 30, 90]);
  });
});

describe('transfersInWindow', () => {
  it('includes transfers within the window', () => {
    const t = [
      makeTransfer({ id: 'a', createdAt: new Date(NOW - 1 * DAY_MS).toISOString() }),
      makeTransfer({ id: 'b', createdAt: new Date(NOW - 5 * DAY_MS).toISOString() }),
      makeTransfer({ id: 'c', createdAt: new Date(NOW - 10 * DAY_MS).toISOString() }),
    ];
    expect(transfersInWindow(t, NOW, 7).map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
});

describe('dailyCounts', () => {
  it('zero-fills empty days and groups by eastern date', () => {
    const t = [
      makeTransfer({ id: 'a', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'b', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'c', createdAt: new Date(NOW - 2 * DAY_MS).toISOString() }),
    ];
    const result = dailyCounts(t, NOW, 3);
    expect(result).toHaveLength(3);
    // Oldest first
    expect(result[0].count).toBe(1); // 2 days ago
    expect(result[1].count).toBe(0); // 1 day ago
    expect(result[2].count).toBe(2); // today
  });

  it('returns zero buckets when no transfers', () => {
    const result = dailyCounts([], NOW, 5);
    expect(result.map((b) => b.count)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('dailyVolume', () => {
  it('sums amountUsd per day, rounded to cents', () => {
    const t = [
      makeTransfer({ id: 'a', amountUsd: 100, createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'b', amountUsd: 250.5, createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'c', amountUsd: 75, createdAt: new Date(NOW - 1 * DAY_MS).toISOString() }),
    ];
    const result = dailyVolume(t, NOW, 2);
    expect(result[0].volumeUsd).toBe(75);
    expect(result[1].volumeUsd).toBe(350.5);
  });
});

describe('dailyCommission', () => {
  it('only counts feeUsd of paid/delivered transfers', () => {
    const t = [
      makeTransfer({ id: 'a', feeUsd: 3, status: 'delivered', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'b', feeUsd: 2, status: 'paid', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'c', feeUsd: 9, status: 'cancelled', createdAt: new Date(NOW).toISOString() }),
      makeTransfer({ id: 'd', feeUsd: 9, status: 'awaiting_payment', createdAt: new Date(NOW).toISOString() }),
    ];
    const result = dailyCommission(t, NOW, 1);
    expect(result[0].commissionUsd).toBe(5);
  });
});

describe('statusDistribution', () => {
  it('groups by status sorted by count desc', () => {
    const t = [
      makeTransfer({ id: '1', status: 'delivered' }),
      makeTransfer({ id: '2', status: 'delivered' }),
      makeTransfer({ id: '3', status: 'paid' }),
      makeTransfer({ id: '4', status: 'cancelled' }),
    ];
    expect(statusDistribution(t)).toEqual([
      { status: 'delivered', count: 2 },
      { status: 'paid', count: 1 },
      { status: 'cancelled', count: 1 },
    ]);
  });

  it('returns empty array for no transfers', () => {
    expect(statusDistribution([])).toEqual([]);
  });
});

describe('complianceDistribution', () => {
  it('groups by complianceStatus sorted by count desc', () => {
    const t = [
      makeTransfer({ id: '1', complianceStatus: 'cleared' }),
      makeTransfer({ id: '2', complianceStatus: 'cleared' }),
      makeTransfer({ id: '3', complianceStatus: 'flagged' }),
    ];
    expect(complianceDistribution(t)).toEqual([
      { status: 'cleared', count: 2 },
      { status: 'flagged', count: 1 },
    ]);
  });
});

describe('fundingMethodMix', () => {
  it('groups by funding method sorted by count desc', () => {
    const t = [
      makeTransfer({ id: '1', fundingMethod: 'bank_transfer' }),
      makeTransfer({ id: '2', fundingMethod: 'bank_transfer' }),
      makeTransfer({ id: '3', fundingMethod: 'credit_card' }),
    ];
    expect(fundingMethodMix(t)).toEqual([
      { method: 'bank_transfer', count: 2 },
      { method: 'credit_card', count: 1 },
    ]);
  });
});

describe('topRecipientsByCount', () => {
  it('returns top N by count, sorted desc with name tiebreaker', () => {
    const t = [
      makeTransfer({ id: '1', recipientName: 'A' }),
      makeTransfer({ id: '2', recipientName: 'A' }),
      makeTransfer({ id: '3', recipientName: 'B' }),
      makeTransfer({ id: '4', recipientName: 'C' }),
    ];
    expect(topRecipientsByCount(t, 2)).toEqual([
      { name: 'A', count: 2 },
      { name: 'B', count: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- analytics`
Expected: FAIL — cannot resolve `@/lib/analytics`.

- [ ] **Step 3: Create `src/lib/analytics.ts`**

```ts
import { easternDate } from './dates';
import type {
  ComplianceStatus,
  FundingMethod,
  Transfer,
  TransferStatus,
} from './types';

export const WINDOW_DAYS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

const DAY_MS = 86_400_000;

export function transfersInWindow(
  transfers: Transfer[],
  now: number,
  days: number,
): Transfer[] {
  const cutoff = now - days * DAY_MS;
  return transfers.filter((t) => Date.parse(t.createdAt) >= cutoff);
}

function buildDateBuckets(now: number, days: number): string[] {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dates.push(easternDate(now - i * DAY_MS));
  }
  return dates;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function dailyCounts(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; count: number }[] {
  const dates = buildDateBuckets(now, days);
  const counts = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const t of transfersInWindow(transfers, now, days)) {
    const d = easternDate(Date.parse(t.createdAt));
    if (counts.has(d)) counts.set(d, counts.get(d)! + 1);
  }
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export function dailyVolume(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; volumeUsd: number }[] {
  const dates = buildDateBuckets(now, days);
  const volume = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const t of transfersInWindow(transfers, now, days)) {
    const d = easternDate(Date.parse(t.createdAt));
    if (volume.has(d)) volume.set(d, volume.get(d)! + t.amountUsd);
  }
  return dates.map((date) => ({
    date,
    volumeUsd: round2(volume.get(date) ?? 0),
  }));
}

export function dailyCommission(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; commissionUsd: number }[] {
  const dates = buildDateBuckets(now, days);
  const commission = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const t of transfersInWindow(transfers, now, days)) {
    if (t.status !== 'paid' && t.status !== 'delivered') continue;
    const d = easternDate(Date.parse(t.createdAt));
    if (commission.has(d)) commission.set(d, commission.get(d)! + t.feeUsd);
  }
  return dates.map((date) => ({
    date,
    commissionUsd: round2(commission.get(date) ?? 0),
  }));
}

export function statusDistribution(
  transfers: Transfer[],
): { status: TransferStatus; count: number }[] {
  const counts = new Map<TransferStatus, number>();
  for (const t of transfers) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

export function complianceDistribution(
  transfers: Transfer[],
): { status: ComplianceStatus; count: number }[] {
  const counts = new Map<ComplianceStatus, number>();
  for (const t of transfers) {
    counts.set(t.complianceStatus, (counts.get(t.complianceStatus) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

export function fundingMethodMix(
  transfers: Transfer[],
): { method: FundingMethod; count: number }[] {
  const counts = new Map<FundingMethod, number>();
  for (const t of transfers) {
    counts.set(t.fundingMethod, (counts.get(t.fundingMethod) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count || a.method.localeCompare(b.method));
}

export function topRecipientsByCount(
  transfers: Transfer[],
  limit: number,
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of transfers) {
    counts.set(t.recipientName, (counts.get(t.recipientName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- analytics`
Expected: PASS — 10 tests across 8 describe blocks.

- [ ] **Step 5: Commit**

```bash
git add src/lib/analytics.ts tests/analytics.test.ts
git commit -m "feat(analytics): add pure aggregator helpers for charts"
```

---

## Task 3: Sidebar — add Analytics nav item

**Files:**
- Modify: `src/app/dashboard/sidebar.tsx`

Mid-batch: clicking the new Analytics nav item will 404 until Task 5 creates the page. Build stays green because the new union member isn't referenced anywhere yet.

- [ ] **Step 1: Replace `src/app/dashboard/sidebar.tsx`**

```tsx
import Link from 'next/link';
import { requireStaff } from '@/lib/auth';

export type SidebarActive =
  | 'overview'
  | 'transactions'
  | 'schedules'
  | 'compliance'
  | 'analytics'
  | 'team';

export async function Sidebar({ active }: { active: SidebarActive }) {
  const staff = await requireStaff();
  const isAdmin = staff.role === 'admin';

  return (
    <aside className="sh-sidebar">
      <Link
        href="/dashboard"
        className={`sh-nav-item ${active === 'overview' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">◾</span> Overview
      </Link>
      <Link
        href="/dashboard/transactions"
        className={`sh-nav-item ${active === 'transactions' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↔</span> Transactions
      </Link>
      <Link
        href="/dashboard/schedules"
        className={`sh-nav-item ${active === 'schedules' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">↻</span> Schedules
      </Link>
      <Link
        href="/dashboard/compliance"
        className={`sh-nav-item ${active === 'compliance' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">⚑</span> Compliance
      </Link>
      <Link
        href="/dashboard/analytics"
        className={`sh-nav-item ${active === 'analytics' ? 'active' : ''}`}
      >
        <span className="sh-nav-icon">▦</span> Analytics
      </Link>
      {isAdmin && (
        <>
          <div className="sh-nav-label">Account</div>
          <Link
            href="/dashboard/team"
            className={`sh-nav-item ${active === 'team' ? 'active' : ''}`}
          >
            <span className="sh-nav-icon">◉</span> Team
          </Link>
          <Link href="/dashboard" className="sh-nav-item">
            <span className="sh-nav-icon">⚙</span> Settings
          </Link>
        </>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — existing pages (`active` values `'overview'`, `'transactions'`, `'schedules'`, `'compliance'`, `'team'`) are all still valid; the new `'analytics'` literal is unused so far.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/sidebar.tsx
git commit -m "feat(dashboard): add Analytics sidebar item"
```

---

## Task 4: Chart client components (`charts.tsx`)

**Files:**
- Create: `src/app/dashboard/analytics/charts.tsx`

A single `'use client'` file exporting all 7 chart components. Keeps Recharts imports in one place; the analytics page imports specific charts as needed.

- [ ] **Step 1: Create `src/app/dashboard/analytics/charts.tsx`**

```tsx
'use client';

import {
  ResponsiveContainer,
  BarChart,
  AreaChart,
  PieChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  Bar,
  Area,
  Pie,
  Cell,
} from 'recharts';

const COLORS = {
  primary: '#635bff',
  success: '#16a34a',
  warning: '#f0c000',
  danger: '#df1b41',
  info: '#635bff',
  neutral: '#697386',
  bgGrid: '#e6ebf1',
  text: '#697386',
};

const STATUS_COLORS: Record<string, string> = {
  delivered: COLORS.success,
  paid: COLORS.primary,
  awaiting_payment: COLORS.neutral,
  cancelled: COLORS.warning,
  blocked: COLORS.danger,
};

const COMPLIANCE_COLORS: Record<string, string> = {
  cleared: COLORS.success,
  flagged: COLORS.warning,
  blocked: COLORS.danger,
};

const FUNDING_LABELS: Record<string, string> = {
  credit_card: 'Credit card',
  debit_card: 'Debit card',
  bank_transfer: 'Bank transfer',
};

const tickStyle = { fontSize: 10, fill: COLORS.text };

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ─── Daily transfers (bar) ────────────────────────────────────────────

export function DailyTransfers({
  data,
}: {
  data: { date: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis dataKey="date" tick={tickStyle} />
        <YAxis tick={tickStyle} allowDecimals={false} />
        <Tooltip />
        <Bar dataKey="count" fill={COLORS.primary} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Daily volume (area) ──────────────────────────────────────────────

export function DailyVolume({
  data,
}: {
  data: { date: string; volumeUsd: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis dataKey="date" tick={tickStyle} />
        <YAxis tick={tickStyle} tickFormatter={(v: number) => formatUsd(v)} />
        <Tooltip formatter={(v: number) => formatUsd(v)} />
        <Area
          type="monotone"
          dataKey="volumeUsd"
          stroke={COLORS.primary}
          fill={COLORS.primary}
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Daily commission (area) ──────────────────────────────────────────

export function DailyCommission({
  data,
}: {
  data: { date: string; commissionUsd: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis dataKey="date" tick={tickStyle} />
        <YAxis tick={tickStyle} tickFormatter={(v: number) => formatUsd(v)} />
        <Tooltip formatter={(v: number) => formatUsd(v)} />
        <Area
          type="monotone"
          dataKey="commissionUsd"
          stroke={COLORS.success}
          fill={COLORS.success}
          fillOpacity={0.2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Status distribution (donut) ──────────────────────────────────────

export function StatusDonut({
  data,
}: {
  data: { status: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="status"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
        >
          {data.map((d) => (
            <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? COLORS.neutral} />
          ))}
        </Pie>
        <Tooltip />
        <Legend
          formatter={(value: string) => value.replace('_', ' ')}
          wrapperStyle={{ fontSize: 11 }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── Compliance distribution (donut) ──────────────────────────────────

export function ComplianceDonut({
  data,
}: {
  data: { status: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="status"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
        >
          {data.map((d) => (
            <Cell
              key={d.status}
              fill={COMPLIANCE_COLORS[d.status] ?? COLORS.neutral}
            />
          ))}
        </Pie>
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ─── Funding method mix (horizontal bar) ──────────────────────────────

export function FundingMix({
  data,
}: {
  data: { method: string; count: number }[];
}) {
  const display = data.map((d) => ({
    label: FUNDING_LABELS[d.method] ?? d.method,
    count: d.count,
  }));
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={display}
        layout="vertical"
        margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis type="number" tick={tickStyle} allowDecimals={false} />
        <YAxis dataKey="label" type="category" tick={tickStyle} width={110} />
        <Tooltip />
        <Bar dataKey="count" fill={COLORS.primary} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Top recipients (horizontal bar) ──────────────────────────────────

export function TopRecipients({
  data,
}: {
  data: { name: string; count: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 32 + 40)}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={COLORS.bgGrid} />
        <XAxis type="number" tick={tickStyle} allowDecimals={false} />
        <YAxis dataKey="name" type="category" tick={tickStyle} width={140} />
        <Tooltip />
        <Bar dataKey="count" fill={COLORS.primary} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS — `charts.tsx` is unused so far, but compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/analytics/charts.tsx
git commit -m "feat(analytics): add Recharts client components for all 7 charts"
```

---

## Task 5: Analytics page

**Files:**
- Create: `src/app/dashboard/analytics/page.tsx`

- [ ] **Step 1: Create `src/app/dashboard/analytics/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { getStore } from '@/lib/store';
import { requireStaff } from '@/lib/auth';
import {
  WINDOW_DAYS,
  type WindowDays,
  transfersInWindow,
  dailyCounts,
  dailyVolume,
  dailyCommission,
  statusDistribution,
  complianceDistribution,
  fundingMethodMix,
  topRecipientsByCount,
} from '@/lib/analytics';
import { Sidebar } from '../sidebar';
import {
  DailyTransfers,
  DailyVolume,
  DailyCommission,
  StatusDonut,
  ComplianceDonut,
  FundingMix,
  TopRecipients,
} from './charts';

function coerceWindow(raw: string | undefined): WindowDays {
  const n = Number(raw);
  return (WINDOW_DAYS as readonly number[]).includes(n) ? (n as WindowDays) : 30;
}

function usd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  await requireStaff();
  const params = await searchParams;
  const windowDays = coerceWindow(params.window);
  const now = Date.now();

  const allTransfers = await getStore().listTransfers();
  const inWindow = transfersInWindow(allTransfers, now, windowDays);

  const counts = dailyCounts(allTransfers, now, windowDays);
  const volume = dailyVolume(allTransfers, now, windowDays);
  const commission = dailyCommission(allTransfers, now, windowDays);
  const statusDist = statusDistribution(inWindow);
  const complianceDist = complianceDistribution(inWindow);
  const funding = fundingMethodMix(inWindow);
  const topReci = topRecipientsByCount(inWindow, 10);

  const totalTransfers = inWindow.length;
  const totalVolume = inWindow.reduce((sum, t) => sum + t.amountUsd, 0);
  const totalCommission = inWindow
    .filter((t) => t.status === 'paid' || t.status === 'delivered')
    .reduce((sum, t) => sum + t.feeUsd, 0);

  return (
    <>
      <Sidebar active="analytics" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Analytics</div>
            <div className="sh-page-sub">Trends over the selected window</div>
          </div>
          <div className="sh-tabs">
            {WINDOW_DAYS.map((d) => (
              <Link
                key={d}
                href={`/dashboard/analytics?window=${d}`}
                className={`sh-tab ${windowDays === d ? 'active' : ''}`}
              >
                {d}d
              </Link>
            ))}
          </div>
        </div>

        <section
          className="sh-metrics"
          style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}
        >
          <div className="sh-metric sh-metric-primary">
            <div className="sh-metric-label">Transfers in window</div>
            <div className="sh-metric-value">{totalTransfers}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Volume in window</div>
            <div className="sh-metric-value">{usd(totalVolume)}</div>
          </div>
          <div className="sh-metric">
            <div className="sh-metric-label">Commission in window</div>
            <div className="sh-metric-value">{usd(totalCommission)}</div>
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Daily transfers</div>
              <div className="sh-card-sub">Last {windowDays} days</div>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            <DailyTransfers data={counts} />
          </div>
        </section>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 16,
            marginBottom: 16,
          }}
        >
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Daily volume (USD)</div>
                <div className="sh-card-sub">Total amount sent per day</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <DailyVolume data={volume} />
            </div>
          </section>
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Daily commission (USD)</div>
                <div className="sh-card-sub">Fees on paid/delivered transfers</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <DailyCommission data={commission} />
            </div>
          </section>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: 16,
            marginBottom: 16,
          }}
        >
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Status distribution</div>
                <div className="sh-card-sub">Transfers in window by lifecycle status</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <StatusDonut data={statusDist} />
            </div>
          </section>
          <section className="sh-card" style={{ marginBottom: 0 }}>
            <div className="sh-card-head">
              <div>
                <div className="sh-card-title">Compliance distribution</div>
                <div className="sh-card-sub">Cleared / flagged / blocked breakdown</div>
              </div>
            </div>
            <div style={{ padding: 16 }}>
              <ComplianceDonut data={complianceDist} />
            </div>
          </section>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Funding method mix</div>
              <div className="sh-card-sub">How customers paid</div>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            <FundingMix data={funding} />
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Top 10 recipients</div>
              <div className="sh-card-sub">By number of transfers in window</div>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            {topReci.length === 0 ? (
              <div className="sh-empty">No transfers in window.</div>
            ) : (
              <TopRecipients data={topReci} />
            )}
          </div>
        </section>
      </main>
    </>
  );
}
```

- [ ] **Step 2: Run the full suite and build**

Run: `npm test`
Expected: PASS — every test file green.
Run: `npm run build`
Expected: PASS — `/dashboard/analytics` appears as a dynamic route.

- [ ] **Step 3: Visual sanity check (optional, manual)**

`npm run dev`, log in, click **Analytics** in the sidebar. Confirm:
- Time-tab strip shows 7d / 30d / 90d with `30d` active by default.
- Three summary cards show counts/USD for the window.
- All 7 charts render (bar, area×2, donut×2, horizontal bar×2).
- Clicking a tab navigates softly (no full page reload) and re-renders charts with the new window.
- Sidebar's **Analytics** item stays highlighted.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/analytics/page.tsx
git commit -m "feat(dashboard): add /dashboard/analytics page with Recharts and time-window toggle"
```

---

## Manual Verification (after deployment)

1. Deploy to Vercel.
2. Open `https://claude-payments.vercel.app/dashboard/analytics`.
3. Confirm all seven charts render with real data.
4. Click each time-window tab (7d / 30d / 90d) — chart datasets re-render.
5. Click between Analytics and other sidebar items — the layout stays mounted (no full reload, LiveRefresh dot keeps pulsing).
6. Trigger a fresh transfer (via the bot, if possible) — within 5 seconds the analytics counts update.

---

## Self-Review Notes

- **Spec coverage:** time-window toggle (Task 5), summary cards (Task 5), seven charts (Tasks 4–5), aggregator helpers (Task 2), sidebar item (Task 3), Recharts dep (Task 1), auto-refresh inherited from existing layout (no change needed). All spec sections map to a task.
- **Type consistency:** `WindowDays` defined in `analytics.ts` and consumed by the page; chart data props match each helper's return shape exactly; `SidebarActive` extended in Task 3 to cover Task 5's `active="analytics"`.
- **No placeholders:** every step has complete code or an exact command.
- **Risks:** Recharts requires client-side rendering — handled by the `'use client'` directive in `charts.tsx`; the server page passes only plain data to chart components, so no "Functions cannot be passed" bug. Recharts adds ~30 kB gzip to the analytics page bundle only (code-split by Next.js).
