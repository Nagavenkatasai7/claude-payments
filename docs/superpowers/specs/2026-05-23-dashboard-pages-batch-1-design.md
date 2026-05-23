# Dashboard Pages — Batch 1: Per-Feature Pages (Design)

**Date:** 2026-05-23
**Status:** Approved — proceeding to implementation plan
**Batch:** 1 of 2 (Batch 2 is Analytics with Recharts; separate spec/plan)

## Purpose

Split the current single-page `/dashboard` into focused per-feature pages so
each area of the product has room to grow. No new functionality, no new server
actions, no data-model changes — pure UI re-organization plus two pure
aggregator helpers.

## Locked decisions

| Topic | Decision |
|---|---|
| Scope this batch | 4 pages: slimmer Overview + new Transactions, Schedules, Compliance |
| Analytics | Deferred to Batch 2 (Recharts + 7d/30d/90d toggle) |
| Watchlist display | Read-only on Compliance page (no edit UI) |
| Settings | Sidebar stub, links to `/dashboard` for now |
| Permissions | Existing `requireStaff()` + per-action `hasPermission()` gating preserved on every page |

## Page specifications

### Overview — `/dashboard` (modify)

The landing page; intentionally lighter than today.

**Sections (top to bottom):**
1. Page head: title "Overview", today's date, live indicator.
2. Four metric cards in a row: Commission today (indigo) · Volume today · Transactions today · Flagged today (red). Drop the "All-time commission" card here — moves to Analytics.
3. Needs-attention strip — a small card showing the count and a "View on Compliance →" link (no row details on this page; details live on `/dashboard/compliance`).
4. Recent transactions card — table of the **last 5** transfers (newest first), no tabs/filters, with a "View all →" link to `/dashboard/transactions`.
5. Next due schedules card — the **next 3** active schedules sorted by next due date, with a "View all →" link to `/dashboard/schedules`.

### Transactions — `/dashboard/transactions` (new)

Full transactions ledger.

A new client component **`TransactionsExplorer`** wraps the existing
`TransactionsTabs` and adds:
- A **search input** that filters by `recipientName` or `payoutDestination`
  (case-insensitive substring match).
- A **date-range** filter — `from` and `to` date inputs that filter on
  `Date.parse(createdAt)`.

The card head shows the filtered count vs total, plus the tab strip
(All / Awaiting / Paid / Delivered / Cancelled / Blocked). Row actions
(cancel / assign / resend) preserved exactly as today.

### Schedules — `/dashboard/schedules` (new)

**Sections:**
1. **Due in the next 7 days** callout (yellow-bordered card if there are any;
   otherwise muted "Nothing due in the next 7 days" message). Each row:
   recipient + amount + next-due date.
2. **All schedules** table — same columns as today's dashboard schedules
   section. Add a small toggle: "Active only" / "Show cancelled" (default
   active-only).

### Compliance — `/dashboard/compliance` (new)

**Sections:**
1. **Flagged transfers** — full table of every transfer with
   `complianceStatus === 'flagged'`. Same columns as the main ledger.
2. **Blocked transfers** — full table of every transfer with
   `complianceStatus === 'blocked'`.
3. **Watchlist** — read-only panel listing the names in `WATCHLIST` from
   `compliance.ts`. Plus a short explanation that matches block these.
4. **Top velocity today** — table of phones with the most transfers today
   (computed from the per-day velocity counters via a new `topVelocityToday`
   aggregator), top 10, with their count and a "transfers from this number
   today" link to `/dashboard/transactions?phone=…` (search box auto-fills
   from a query param).

### Sidebar — `src/app/dashboard/sidebar.tsx` (modify)

- `SidebarActive` becomes `'overview' | 'transactions' | 'schedules' |
  'compliance' | 'team'`.
- Nav items become real route links instead of anchors:
  - Overview → `/dashboard`
  - Transactions → `/dashboard/transactions`
  - Schedules → `/dashboard/schedules`
  - Compliance → `/dashboard/compliance`
  - Team → `/dashboard/team` (admin only, as today)
  - Settings → `/dashboard` (admin only, stub — unchanged)
- Each page passes its `active` value when rendering `<Sidebar>`.

## Components / file structure

```
NEW  src/app/dashboard/transactions/page.tsx
NEW  src/app/dashboard/schedules/page.tsx
NEW  src/app/dashboard/compliance/page.tsx
NEW  src/app/dashboard/transactions-explorer.tsx   - 'use client', wraps TransactionsTabs
MOD  src/app/dashboard/page.tsx                    - slimmer Overview
MOD  src/app/dashboard/sidebar.tsx                 - new active values, real route links
MOD  src/lib/dashboard.ts                          - +schedulesDueInRange, +topVelocityToday
```

The existing `transactions-tabs.tsx` client component is reused unchanged for
the full ledger (`TransactionsExplorer` wraps it and injects already-filtered
`transfers`).

## New pure helpers (testable, in `src/lib/dashboard.ts`)

```ts
export function schedulesDueInRange(
  schedules: Schedule[],
  now: number,
  days: number,
): Schedule[];

export function topVelocityToday(
  transfers: Transfer[],
  now: number,
  limit: number,
): { phone: string; count: number }[];
```

`schedulesDueInRange` — for each active schedule, compute the next-due epoch
(monthly: next dayOfMonth occurrence; weekly: next dayOfWeek occurrence) and
return those whose next-due is within `now + days`. Sorted by soonest first.

`topVelocityToday` — group transfers whose `createdAt` is today (Eastern
date) by `phone`, count per phone, return top `limit`, sorted desc.

## Auth and permissions

Every new page server component calls `requireStaff()` (existing helper).
Every row action keeps its existing per-permission gating via
`hasPermission(viewer, …)`. Settings + Team remain admin-only.

## Out of scope (intentionally deferred)

- Analytics page with charts (Batch 2)
- Real settings page (sidebar stub)
- Watchlist editing (read-only this batch)
- Search/filter functionality on Schedules or Compliance pages
- Pagination on tables (prototype volumes are small)
- URL-state persistence for filters on the Transactions page (the `?phone=…`
  prefill from Compliance is the one exception)

## Testing

Two pure helpers (`schedulesDueInRange`, `topVelocityToday`) get unit tests.
UI pages have no unit tests (matches the rest of this codebase).
