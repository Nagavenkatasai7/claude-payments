# Dashboard Redesign — Stripe-Style Polished SaaS UI (Design)

**Date:** 2026-05-23
**Status:** Approved — proceeding to implementation plan

## Purpose

Replace the current ad-hoc WhatsApp-dark dashboard styling with a polished,
professional Stripe-style admin UI. Pure UI redesign — no new functionality,
no new pages, no data-model changes. The dashboard ecosystem (login + admin
dashboard + team page) all adopt a single consistent design system.

The customer-facing pay page keeps its existing WhatsApp-dark styling (it
serves a different audience and is out of scope for this batch).

## Locked decisions (from visual brainstorm)

| Topic | Decision |
|---|---|
| Visual direction | Stripe-style: white/soft-gray surfaces, indigo `#635bff` accent, subtle shadows, sharp pill badges, refined sans-serif typography |
| Layout | Hybrid: persistent top bar (brand, search, primary action, user) + persistent left sidebar (nav) + main content area |
| Density | Comfortable (Stripe defaults) — generous whitespace, scannable rows |
| Scope of restyle | `/login`, `/dashboard`, `/dashboard/team` only. `/pay` keeps its existing dark theme. |

## Design tokens

```
Background       #f6f9fc       (app surface)
Card             #ffffff
Border           #e6ebf1
Divider          #f0f3f6
Text             #0a2540       (primary)
Text-secondary   #697386
Text-tertiary    #8792a2
Primary          #635bff       (indigo)
Primary-bg       #eef0ff
Primary-hover    #5048e5
Success          #0e6245 on #e7fdf3
Warning          #7a5a00 on #fff8c5
Danger           #b3093c on #fde7eb
Info             #635bff on #eef0ff
Shadow-sm        0 1px 3px rgba(50,50,93,.04)
Shadow-md        0 4px 12px rgba(50,50,93,.08)

Radii            10px (cards) · 8px (buttons / inputs) · 12px (pills)
Font stack       -apple-system, 'SF Pro Text', 'Inter', system-ui, sans-serif
Page title       22px / 700 / -0.4 letter-spacing
Card title       14px / 600
Body             13px / 400
Label            11px / 500 / uppercase / .4 letter-spacing
Spacing scale    8 · 12 · 16 · 20 · 24 · 28 px
```

## Layout

```
+----------------------------------------------------+
|  TOP BAR  [brand] [search]    [live] [user/logout] |
+--------+-------------------------------------------+
|        |  PAGE TITLE   subtitle/breadcrumbs        |
|        |                                           |
|  SIDE  |  [metric][metric][metric][metric][metric] |
|  NAV   |                                           |
|        |  +--------------------------------------+ |
|        |  | NEEDS ATTENTION (red accent)         | |
|        |  +--------------------------------------+ |
|        |                                           |
|        |  +--------------------------------------+ |
|        |  | TRANSACTIONS (table card, tabs)      | |
|        |  +--------------------------------------+ |
|        |                                           |
|        |  +--------------------------------------+ |
|        |  | RECURRING SCHEDULES (card)           | |
|        |  +--------------------------------------+ |
+--------+-------------------------------------------+
```

- **Top bar (h ≈ 56px):** brand (SH mark + name), a decorative search input
  (visual only this batch), a `● Live` indicator (replaces the prior
  free-floating one), the staff's name + avatar + an inline `Log out` form
  button. No `+ New transfer` button this batch — admin-initiated transfers
  were dropped from scope earlier.
- **Sidebar (w = 220px):** nav items with simple glyph + label.
  - **Section 1:** Overview · Transactions · Schedules · Compliance
  - **Section 2 (Account):** Team · Settings
  - Active item rendered with `--sh-primary-bg` background and primary text.
  - The four "Section 1" items all scroll/anchor to the matching section
    on `/dashboard` (single-page; no new routes this batch). `Team` links
    to `/dashboard/team`. `Settings` links to `/dashboard` as a placeholder.

## Main-content surfaces

### Page header
- Title (e.g. "Overview"), subtitle line with today's date and the `● Live`
  indicator. The previously-existing `<LiveRefresh />` polling is kept and
  rendered as the live dot.

### Summary metrics (row of 5 cards)
1. Commission today (indigo value)
2. Volume today
3. Transactions today
4. Flagged today (red value)
5. All-time commission (smaller emphasis)
- Cards: white, 10px radius, 16px padding, label (uppercase 11px) on top, large
  value (22px / 700) below, no trend deltas this batch (we don't track
  historical comparisons yet).

### Needs Attention panel
- White card with a 3px left border in danger color, panel title in danger
  color. Rows for each attention item with recipient + meta line + inline
  action buttons (Resend link / Cancel / Assign for awaiting; View / Cancel
  for flagged/blocked). The existing `dashboard-ops` actions and the
  permission-gated action forms are reused exactly as-is — only the wrapping
  markup and styling change.

### Transactions table (card)
- Card with a header (title + subtitle) and a tab strip
  `[All] [Awaiting] [Paid] [Delivered] [Cancelled]`.
- Tabs **filter the table client-side** (no server round-trips). Single new
  client component holds the tab state + filtered render. The action `<form>`s
  inside each row still target the existing server actions (server actions can
  be passed into and used from client components).
- Columns: Recipient (name + payout-method line under), Amount (USD + INR
  small), Funding, US Payment (✓ time / pending), India Delivery (✓ time / in
  transit / —), Compliance pill, Assignee, Actions.
- Status pills are pill-shaped with a 6px coloured dot prefix.

### Recurring Schedules (card)
- Card with header. Each schedule row: name + recipient + frequency, next-due
  date, status pill. No actions this batch (current dashboard has none either).

## /dashboard/team

Same shell (top bar + sidebar), `Team` nav item active. Two cards: a Staff
table (Name · Username · Role · Permissions · Actions) and an Add-agent form
card below. Identical pill / button / table styling. Existing actions
unchanged.

## /login

Centred card on the `#f6f9fc` background. White card with logo, "Staff sign
in" heading, two inputs (8px radius), primary indigo "Sign in" button. The
existing `useActionState`-based form is preserved; only styling changes.

## /pay (unchanged)

Wrapped in a `.payapp` class that overrides the body's light background back to
the existing WhatsApp-dark theme, so the pay page renders exactly as it does
today. The legacy `.card` / `.summary` / form styles are kept under that
scope.

## Components / file impact

| File | Action |
|---|---|
| `src/app/dashboard/layout.tsx` | NEW — wraps children in TopBar + Sidebar + main; calls `requireStaff()` and passes the staff down |
| `src/app/dashboard/top-bar.tsx` | NEW — server component (brand, search-placeholder, live dot, user + logout) |
| `src/app/dashboard/sidebar.tsx` | NEW — server component; takes an `active` prop ('overview' / 'team') |
| `src/app/dashboard/transactions-table.tsx` | NEW — client component (tabs + filtered render), receives transfers + staff + viewer |
| `src/app/dashboard/page.tsx` | MODIFY — drop the existing header (now in layout); restructure JSX to new classes; pass data into the new components |
| `src/app/dashboard/team/page.tsx` | MODIFY — drop header (in layout); restyle to new classes |
| `src/app/login/page.tsx` + `login-form.tsx` | MODIFY — restyle to new classes |
| `src/app/pay/[transferId]/page.tsx` | MODIFY — wrap in `<main className="payapp card">` so the legacy dark theme keeps working |
| `src/app/globals.css` | MODIFY — replace base / dashboard styles with the Stripe-style theme; preserve pay-page styles under `.payapp` scope |
| `src/app/dashboard/live-refresh.tsx` | MINOR — restyle the indicator to the new live dot |

## Out of scope (deliberately deferred)

- Functional **search** (the top-bar input is visual only this batch)
- **`+ New transfer`** button (admin-initiated transfers were dropped earlier)
- **Date-range selector** and **Export** button on the page header
- **Trend deltas** on metric cards (require historical data we don't track)
- Restyling **`/pay`** (customer-facing; a separate design pass)
- A real **Settings** page (the sidebar item links back to `/dashboard`)
- Splitting the dashboard into per-section pages (`Overview`, `Transactions`,
  `Schedules`, `Compliance` all live on the single `/dashboard` page; nav
  items scroll to anchors)

## Testing

UI redesign — no logic changes, no new server actions, no new tools. The
existing test suite must stay green after the rewrite. Tests that don't depend
on specific markup (the lib-layer tests) keep working unchanged; the few tests
that touch UI strings will be updated to match the new markup where needed.

## Risks

- The pay page background override (`.payapp` scope) is the one place where
  legacy styling needs to coexist with the new theme — easy to break if the
  class isn't applied. Mitigated by an explicit wrapper on the page and a
  visual verification step in the plan.
