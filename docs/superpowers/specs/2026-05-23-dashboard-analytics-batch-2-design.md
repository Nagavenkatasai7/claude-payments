# Dashboard Analytics — Batch 2: Charts & Trends (Design)

**Date:** 2026-05-23
**Status:** Approved — proceeding to implementation plan
**Batch:** 2 of 2 (Batch 1 was per-feature page splits)

## Purpose

Add a dedicated `/dashboard/analytics` page with traffic + usage charts driven
by the existing transfer data. Read-only — no new endpoints, no new actions,
no data-model changes. Just aggregation helpers plus a charts page.

## Locked decisions

| Topic | Decision |
|---|---|
| Charting library | Recharts (one new dependency, declarative SVG charts) |
| Time window | 7d / 30d / 90d — selectable via tab strip at the top of the page |
| Time toggle scope | Applies to ALL charts on the page (consistent dataset slice) |
| Page lives at | `/dashboard/analytics` — new sidebar item between Compliance and Team |
| Auto-refresh | Inherits the dashboard layout's `<LiveRefresh>` polling (5 s) like every other page |

## Page layout

```
+-----------------------------------------------------------+
|  Analytics                            [ 7d  30d ◾ 90d ]   |
|  Trends over the selected window                          |
+-----------------------------------------------------------+
|  [ Transfers ]  [ Volume USD ]  [ Commission USD ]        |   (3 summary cards)
+-----------------------------------------------------------+
|  Daily transfers (bar chart, full width)                  |
+-----------------------------------------------------------+
|  Daily volume USD     |     Daily commission USD          |   (two area charts side-by-side)
+-----------------------------------------------------------+
|  Status distribution  |    Compliance distribution        |   (two donut charts side-by-side)
+-----------------------------------------------------------+
|  Funding method mix (horizontal bar, full width)          |
+-----------------------------------------------------------+
|  Top 10 recipients by transfer count (bar, full width)    |
+-----------------------------------------------------------+
```

## Time-window toggle

- Implemented as a server-side query param `?window=7|30|90` (default `30`).
- Three `<Link>` "tabs" at the top of the page; the active one styled with
  `.sh-tab.active`.
- Soft navigation (next/link) so the layout + `<LiveRefresh>` stay mounted.

## Summary cards (3, for the selected window)

- **Transfers in window** — count of transfers whose `createdAt` is within the
  window.
- **Volume in window** — sum of `amountUsd` of those transfers (USD format).
- **Commission in window** — sum of `feeUsd` of those transfers whose status
  is `paid` or `delivered`.

## Charts (Recharts)

All charts are small `'use client'` components that receive plain data props
from the server page (no functions cross the boundary).

| Chart | Type | Data shape | Notes |
|---|---|---|---|
| Daily transfers | `BarChart` | `{ date: 'YYYY-MM-DD'; count: number }[]` | N buckets; empty days = 0 |
| Daily volume | `AreaChart` | `{ date; volumeUsd: number }[]` | indigo fill |
| Daily commission | `AreaChart` | `{ date; commissionUsd: number }[]` | green fill (paid/delivered only) |
| Status distribution | `PieChart` (donut) | `{ status: TransferStatus; count: number }[]` | one slice per status; colour map matches the existing pill colours |
| Compliance distribution | `PieChart` (donut) | `{ status: ComplianceStatus; count: number }[]` | cleared green / flagged yellow / blocked red |
| Funding method mix | `BarChart` horizontal | `{ method: FundingMethod; count: number }[]` | three bars |
| Top recipients | `BarChart` horizontal | `{ name: string; count: number }[]` | top 10 by count |

Each chart wraps in `<ResponsiveContainer width="100%" height={…}>` so it
sizes to its container. Heights: 240px for time-series; 200px for donuts;
240px for the two bottom bar charts.

## Aggregation helpers (`src/lib/analytics.ts`, new — pure, testable)

```ts
export const WINDOW_DAYS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

export function transfersInWindow(
  transfers: Transfer[],
  now: number,
  days: number,
): Transfer[];

export function dailyCounts(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; count: number }[];

export function dailyVolume(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; volumeUsd: number }[];

export function dailyCommission(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; commissionUsd: number }[];

export function statusDistribution(
  transfers: Transfer[],
): { status: TransferStatus; count: number }[];

export function complianceDistribution(
  transfers: Transfer[],
): { status: ComplianceStatus; count: number }[];

export function fundingMethodMix(
  transfers: Transfer[],
): { method: FundingMethod; count: number }[];

export function topRecipientsByCount(
  transfers: Transfer[],
  limit: number,
): { name: string; count: number }[];
```

- All time-series helpers return **N day-buckets sorted oldest-first**, with
  zero-filled empty days, dates as US-Eastern `YYYY-MM-DD` strings.
- `transfersInWindow` is the foundational filter; the daily helpers all
  call it internally and group by `easternDate(createdAt)`.
- `dailyCommission` only counts transfers whose status is `paid` or
  `delivered` (commission realised).
- Distributions and mix helpers iterate all transfers passed in (the caller
  decides whether to slice by window first or use the whole dataset).

## Page wiring

`src/app/dashboard/analytics/page.tsx`:

1. `await requireStaff();`
2. Parse `?window` (default `30`), coerce to one of `7|30|90`.
3. `await getStore().listTransfers();`
4. Slice via `transfersInWindow`; compute all chart data via the helpers.
5. Render: `<Sidebar active="analytics">` + `<main>` containing the time-tab
   strip, summary cards, and the chart sections (each chart is one of the
   client components).

`SidebarActive` adds `'analytics'`; nav item appears between Compliance and
the Account section.

## File structure

```
NEW  src/lib/analytics.ts                       - pure aggregator helpers
NEW  src/app/dashboard/analytics/page.tsx       - server component page
NEW  src/app/dashboard/analytics/charts.tsx     - 'use client'; all Recharts components
MOD  src/app/dashboard/sidebar.tsx              - +'analytics' active value, nav item
MOD  package.json                               - +recharts dependency
```

`charts.tsx` exports `DailyBar`, `DailyAreaVolume`, `DailyAreaCommission`,
`StatusDonut`, `ComplianceDonut`, `FundingMix`, `TopRecipients` — keeping all
Recharts imports + chart configuration in one file so we don't sprinkle
`'use client'` across many files.

## Auto-refresh

The page is `export const dynamic = 'force-dynamic'`; the layout's
`<LiveRefresh>` polls `router.refresh()` every 5 s; Recharts re-renders
with the new data. Switching the time window navigates softly via
`<Link>`, so the timer + layout remain mounted.

## Out of scope

- Custom date ranges (only the three preset windows)
- Drilldowns from chart clicks
- Export / CSV download
- Per-recipient or per-customer analytics page (top-10 list only)
- Caching of aggregations (recomputed each request — fine at prototype volumes)
- Real-time WebSocket updates (5-second polling is sufficient)

## Testing

The 8 helper functions in `src/lib/analytics.ts` get full unit tests in
`tests/analytics.test.ts` (TDD). UI page + chart components follow the
existing pattern of no unit tests — verified by build + manual sanity check.

## Risks

- **Recharts bundle size:** ~30 kB gzipped; acceptable. Loaded only on the
  analytics page (Next.js code-splitting handles this since it's only
  imported by `charts.tsx`).
- **In-memory aggregation:** `listTransfers()` loads every transfer; at
  hundreds of transfers this is trivial, at hundreds of thousands it would
  need pre-aggregation. Out of scope for the prototype.
