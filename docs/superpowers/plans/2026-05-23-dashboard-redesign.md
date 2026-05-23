# Dashboard Redesign — Stripe-Style Polished UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current WhatsApp-dark admin styling with a polished Stripe-style design (white/indigo, hybrid top-bar+sidebar layout) across `/login`, `/dashboard`, and `/dashboard/team`, while preserving `/pay`'s existing dark theme.

**Architecture:** New design tokens + classes in `globals.css`; the legacy pay-page styles are scoped under a `.payapp` selector. A new `src/app/dashboard/layout.tsx` provides the top-bar + sidebar shell for every dashboard route. The transactions table becomes a small client component to support tab-based filtering. No new functionality, no new data model — pure UI rewrite.

**Tech Stack:** Next.js 16 (App Router), TypeScript, plain CSS.

Reference spec: `docs/superpowers/specs/2026-05-23-dashboard-redesign-design.md`

---

## File Structure

```
MOD  src/app/globals.css                       - new Stripe-style theme + .payapp legacy scope
MOD  src/app/pay/[transferId]/page.tsx         - wrap main in .payapp class
MOD  src/app/login/page.tsx                    - restyle to new classes
MOD  src/app/login/login-form.tsx              - restyle
NEW  src/app/dashboard/layout.tsx              - shell (TopBar + Sidebar + main)
NEW  src/app/dashboard/top-bar.tsx             - server component
NEW  src/app/dashboard/sidebar.tsx             - server component (active prop)
NEW  src/app/dashboard/transactions-tabs.tsx   - client component (tab filter)
MOD  src/app/dashboard/live-refresh.tsx        - restyle the live dot
MOD  src/app/dashboard/page.tsx                - restyle content; use TransactionsTabs
MOD  src/app/dashboard/team/page.tsx           - restyle to new classes
```

---

## Task 1: Foundation CSS + `.payapp` scope for the pay page

**Files:**
- Modify: `src/app/globals.css` (full rewrite)
- Modify: `src/app/pay/[transferId]/page.tsx` (wrap main in `payapp`)

After this task, `/pay` looks exactly the same as today; `/login` and `/dashboard` will look unstyled until later tasks restyle them. The build stays green and the test suite stays green.

- [ ] **Step 1: Replace `src/app/globals.css` entirely**

```css
:root {
  --sh-bg: #f6f9fc;
  --sh-card: #ffffff;
  --sh-border: #e6ebf1;
  --sh-divider: #f0f3f6;
  --sh-text: #0a2540;
  --sh-text-secondary: #697386;
  --sh-text-tertiary: #8792a2;
  --sh-primary: #635bff;
  --sh-primary-bg: #eef0ff;
  --sh-primary-hover: #5048e5;
  --sh-success: #0e6245;
  --sh-success-bg: #e7fdf3;
  --sh-warning: #7a5a00;
  --sh-warning-bg: #fff8c5;
  --sh-danger: #b3093c;
  --sh-danger-bg: #fde7eb;
  --sh-info: #635bff;
  --sh-info-bg: #eef0ff;
  --sh-neutral: #697386;
  --sh-neutral-bg: #f0f3f6;
  --sh-shadow-sm: 0 1px 3px rgba(50, 50, 93, 0.04);
  --sh-shadow-md: 0 4px 12px rgba(50, 50, 93, 0.08);
  --sh-radius-card: 10px;
  --sh-radius-button: 8px;
  --sh-radius-pill: 12px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, 'SF Pro Text', 'Inter', system-ui, sans-serif;
  background: var(--sh-bg);
  color: var(--sh-text);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

a { color: inherit; text-decoration: none; }
button { font: inherit; }
input, select, textarea { font: inherit; color: inherit; }

/* === Shell === */
.sh-app { display: grid; grid-template-rows: 56px 1fr; min-height: 100vh; }
.sh-topbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 20px;
  background: var(--sh-card);
  border-bottom: 1px solid var(--sh-border);
  position: sticky; top: 0; z-index: 10;
}
.sh-brand {
  display: flex; align-items: center; gap: 10px;
  font-weight: 700; font-size: 15px; color: var(--sh-primary);
  letter-spacing: -.3px;
}
.sh-brand-mark {
  width: 24px; height: 24px; border-radius: 7px;
  background: linear-gradient(135deg, var(--sh-primary) 0%, #8a82ff 100%);
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 11px; font-weight: 800;
}
.sh-search {
  flex: 1; max-width: 360px; margin: 0 24px;
  background: var(--sh-bg); border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius-button);
  padding: 8px 12px; font-size: 12px; color: var(--sh-text-tertiary);
  display: flex; align-items: center; gap: 8px;
}
.sh-top-right { display: flex; align-items: center; gap: 14px; }
.sh-user { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--sh-text); }
.sh-avatar {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--sh-primary-bg); color: var(--sh-primary);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; text-transform: uppercase;
}
.sh-live {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--sh-success); font-weight: 600;
}
.sh-live-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #16a34a; box-shadow: 0 0 0 3px rgba(22,163,74,0.15);
  animation: sh-pulse 2s infinite;
}
@keyframes sh-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .5 } }

.sh-body { display: grid; grid-template-columns: 220px 1fr; min-height: 0; }
.sh-sidebar { background: var(--sh-card); border-right: 1px solid var(--sh-border); padding: 18px 12px; }
.sh-nav-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: .8px;
  color: var(--sh-text-tertiary); padding: 4px 10px; margin: 16px 0 4px;
}
.sh-nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 7px; margin-bottom: 1px;
  font-size: 13px; color: #425466; cursor: pointer;
}
.sh-nav-item:hover { background: var(--sh-bg); }
.sh-nav-item.active { background: var(--sh-primary-bg); color: var(--sh-primary); font-weight: 600; }
.sh-nav-icon { width: 16px; text-align: center; opacity: .85; font-size: 14px; }

.sh-main { padding: 28px; background: var(--sh-bg); overflow-x: auto; }

.sh-page-head {
  display: flex; justify-content: space-between; align-items: flex-end;
  margin-bottom: 24px; gap: 16px; flex-wrap: wrap;
}
.sh-page-title { font-size: 22px; font-weight: 700; color: var(--sh-text); letter-spacing: -.4px; }
.sh-page-sub {
  font-size: 12px; color: var(--sh-text-secondary); margin-top: 4px;
  display: flex; align-items: center; gap: 8px;
}

/* === Metric cards === */
.sh-metrics { display: grid; grid-template-columns: repeat(5, 1fr); gap: 14px; margin-bottom: 24px; }
.sh-metric {
  background: var(--sh-card); border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius-card); padding: 16px 18px;
  box-shadow: var(--sh-shadow-sm);
}
.sh-metric-label {
  font-size: 11px; color: var(--sh-text-secondary);
  text-transform: uppercase; letter-spacing: .4px; font-weight: 500;
}
.sh-metric-value {
  font-size: 22px; font-weight: 700; color: var(--sh-text);
  margin-top: 6px; letter-spacing: -.3px; font-variant-numeric: tabular-nums;
}
.sh-metric-sub { font-size: 11px; color: var(--sh-text-tertiary); margin-top: 4px; }
.sh-metric-primary .sh-metric-value { color: var(--sh-primary); }
.sh-metric-alert .sh-metric-value { color: var(--sh-danger); }

/* === Cards === */
.sh-card {
  background: var(--sh-card); border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius-card); overflow: hidden;
  box-shadow: var(--sh-shadow-sm); margin-bottom: 24px;
}
.sh-card-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 18px 20px; border-bottom: 1px solid var(--sh-border); gap: 16px; flex-wrap: wrap;
}
.sh-card-title { font-size: 14px; font-weight: 600; color: var(--sh-text); }
.sh-card-sub { font-size: 12px; color: var(--sh-text-secondary); margin-top: 2px; }

/* === Attention panel === */
.sh-attention {
  background: var(--sh-card);
  border: 1px solid var(--sh-border);
  border-left: 3px solid var(--sh-danger);
  border-radius: var(--sh-radius-card);
  padding: 18px 20px; margin-bottom: 24px;
  box-shadow: var(--sh-shadow-sm);
}
.sh-attention-title {
  font-size: 13px; font-weight: 600; color: var(--sh-danger);
  margin-bottom: 10px;
  display: flex; align-items: center; gap: 8px;
}
.sh-attention-count { color: var(--sh-text-secondary); font-weight: 400; font-size: 12px; }
.sh-attention-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 0; border-top: 1px solid var(--sh-divider);
  font-size: 13px; gap: 12px; flex-wrap: wrap;
}
.sh-attention-row:first-of-type { border-top: 0; }
.sh-attention-info { flex: 1; min-width: 0; }
.sh-attention-recipient { color: var(--sh-text); font-weight: 500; }
.sh-attention-meta { color: var(--sh-text-secondary); font-size: 12px; margin-top: 2px; }
.sh-attention-actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* === Buttons === */
.sh-btn-primary {
  background: var(--sh-primary); color: #fff; border: 0;
  padding: 9px 14px; border-radius: var(--sh-radius-button);
  font-size: 13px; font-weight: 600;
  box-shadow: 0 1px 0 rgba(98,91,255,0.4), 0 2px 6px rgba(98,91,255,0.25);
  cursor: pointer;
}
.sh-btn-primary:hover { background: var(--sh-primary-hover); }
.sh-btn-primary:disabled { opacity: .6; cursor: not-allowed; }

.sh-btn-secondary {
  background: var(--sh-card); border: 1px solid var(--sh-border);
  color: #425466; padding: 7px 14px;
  border-radius: var(--sh-radius-button);
  font-size: 12px; font-weight: 500; cursor: pointer;
}
.sh-btn-secondary:hover { background: var(--sh-bg); }

.sh-mini-btn {
  background: var(--sh-card); border: 1px solid var(--sh-border); color: #425466;
  padding: 5px 10px; border-radius: 6px;
  font-size: 12px; font-weight: 500; cursor: pointer;
}
.sh-mini-btn:hover { background: var(--sh-bg); }
.sh-mini-btn-primary { background: var(--sh-primary); color: #fff; border-color: var(--sh-primary); }
.sh-mini-btn-primary:hover { background: var(--sh-primary-hover); }
.sh-mini-btn-danger { color: var(--sh-danger); }
.sh-mini-btn-danger:hover { background: var(--sh-danger-bg); }

/* === Pills === */
.sh-pill {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; border-radius: var(--sh-radius-pill);
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.sh-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.sh-pill-success { background: var(--sh-success-bg); color: var(--sh-success); }
.sh-pill-warning { background: var(--sh-warning-bg); color: var(--sh-warning); }
.sh-pill-danger { background: var(--sh-danger-bg); color: var(--sh-danger); }
.sh-pill-info { background: var(--sh-info-bg); color: var(--sh-info); }
.sh-pill-neutral { background: var(--sh-neutral-bg); color: var(--sh-neutral); }

/* === Tabs === */
.sh-tabs { display: flex; gap: 4px; }
.sh-tab {
  padding: 6px 12px; border-radius: 6px; cursor: pointer;
  font-size: 12px; color: var(--sh-text-secondary); font-weight: 500;
  background: transparent; border: 0;
}
.sh-tab:hover { background: var(--sh-bg); color: var(--sh-text); }
.sh-tab.active { background: var(--sh-primary-bg); color: var(--sh-primary); font-weight: 600; }

/* === Tables === */
.sh-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sh-table th {
  text-align: left; font-weight: 500; font-size: 11px;
  color: var(--sh-text-secondary); text-transform: uppercase; letter-spacing: .4px;
  padding: 10px 18px;
  background: #fafbfc; border-bottom: 1px solid var(--sh-border); white-space: nowrap;
}
.sh-table td {
  padding: 14px 18px; border-top: 1px solid var(--sh-divider);
  color: var(--sh-text); vertical-align: top;
}
.sh-table tr:hover td { background: #fafbfc; }
.sh-recipient { font-weight: 500; }
.sh-recipient-sub { color: var(--sh-text-secondary); font-size: 11px; margin-top: 3px; }
.sh-amount { font-variant-numeric: tabular-nums; font-weight: 500; }
.sh-stage { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--sh-text); }
.sh-stage-pending { color: var(--sh-text-secondary); font-size: 12px; }
.sh-check { color: var(--sh-success); font-weight: 700; }

.sh-empty { padding: 32px; text-align: center; color: var(--sh-text-secondary); font-size: 13px; }
.sh-ledger-wrap { overflow-x: auto; }

/* === Login + forms === */
.sh-login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 32px 16px; }
.sh-login-card {
  background: var(--sh-card); border: 1px solid var(--sh-border);
  border-radius: 14px; padding: 32px; max-width: 380px; width: 100%;
  box-shadow: var(--sh-shadow-md);
}
.sh-login-title {
  font-size: 20px; font-weight: 700; color: var(--sh-text);
  margin-top: 16px; margin-bottom: 24px; letter-spacing: -.3px;
}
.sh-form { display: flex; flex-direction: column; gap: 16px; }
.sh-form-field {
  display: flex; flex-direction: column; gap: 6px;
  font-size: 12px; color: var(--sh-text-secondary); font-weight: 500;
}
.sh-input {
  padding: 10px 12px;
  background: var(--sh-card);
  border: 1px solid var(--sh-border);
  border-radius: var(--sh-radius-button);
  font-size: 14px; color: var(--sh-text);
  outline: none;
  transition: border-color .15s, box-shadow .15s;
}
.sh-input:focus {
  border-color: var(--sh-primary);
  box-shadow: 0 0 0 3px rgba(99,91,255,0.12);
}
.sh-form-error {
  font-size: 12px; color: var(--sh-danger);
  background: var(--sh-danger-bg);
  padding: 8px 12px; border-radius: 6px;
}

/* === Inline forms (dashboard rows) === */
.sh-inline-form { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.sh-inline-input,
.sh-inline-select {
  padding: 5px 9px;
  background: var(--sh-card);
  border: 1px solid var(--sh-border);
  border-radius: 6px;
  font-size: 12px; color: var(--sh-text);
  outline: none;
}
.sh-inline-input { max-width: 110px; }
.sh-inline-input:focus,
.sh-inline-select:focus {
  border-color: var(--sh-primary);
  box-shadow: 0 0 0 2px rgba(99,91,255,0.1);
}

/* === Team page bits === */
.sh-perm { font-size: 12px; color: var(--sh-text); display: inline-flex; gap: 6px; align-items: center; }
.sh-perm-row { display: flex; flex-wrap: wrap; gap: 16px; padding: 0 18px 16px; }
.sh-add-staff-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 16px 20px; }

/* === Legacy /pay (WhatsApp dark theme), scoped === */
.payapp {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0b141a;
  color: #e9edef;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 32px 16px;
}
.payapp .card {
  background: #111b21;
  border-radius: 16px;
  padding: 28px;
  max-width: 420px;
  width: 100%;
}
.payapp .brand { color: #25d366; font-weight: 800; font-size: 20px; margin-bottom: 4px; }
.payapp h1 { font-size: 18px; margin-bottom: 20px; font-weight: 600; }
.payapp .summary { background: #202c33; border-radius: 12px; padding: 14px; margin-bottom: 20px; }
.payapp .row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
.payapp .row span:first-child { color: #8696a0; }
.payapp form label { display: block; font-size: 13px; color: #8696a0; margin-bottom: 12px; }
.payapp form input {
  width: 100%; margin-top: 4px; padding: 10px;
  background: #2a3942; border: 1px solid #2a3942; border-radius: 8px;
  color: #e9edef; font-size: 15px;
}
.payapp .pair { display: flex; gap: 12px; }
.payapp .pair label { flex: 1; }
.payapp button {
  width: 100%; padding: 12px; background: #25d366; color: #0b141a;
  border: none; border-radius: 24px; font-size: 15px; font-weight: 700;
  cursor: pointer;
}
.payapp button:disabled { opacity: 0.6; cursor: default; }
.payapp .done { color: #25d366; font-weight: 600; text-align: center; }
.payapp .err { color: #f15c6d; font-size: 13px; margin-top: 8px; }
```

- [ ] **Step 2: Wrap `/pay` main in `payapp` class**

In `src/app/pay/[transferId]/page.tsx`, find every `<main className="card">` and replace with `<main className="payapp"><div className="card">…</div></main>`. Concretely there are two returns in that file (the "transfer not found" branch and the main branch). Update both:

```tsx
  if (!transfer) {
    return (
      <main className="payapp">
        <div className="card">
          <div className="brand">SendHome</div>
          <h1>Transfer not found</h1>
        </div>
      </main>
    );
  }

  return (
    <main className="payapp">
      <div className="card">
        <div className="brand">SendHome</div>
        <h1>Secure payment</h1>
        <div className="summary">
          {/* … existing Row components unchanged … */}
        </div>
        {/* … existing PayForm conditional unchanged … */}
      </div>
    </main>
  );
```

- [ ] **Step 3: Run the suite and build**

Run: `npm test`
Expected: PASS — every test file green (logic-only tests; no UI assertions).
Run: `npm run build`
Expected: PASS — compiles cleanly.

- [ ] **Step 4: Visual sanity check (manual, optional)**

Run `npm run dev` and visit `/pay/anyid` — the page should look identical to its current production appearance (dark WhatsApp theme). `/login` and `/dashboard` will look unstyled; that's expected for now.

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css src/app/pay/[transferId]/page.tsx
git commit -m "feat(ui): introduce Stripe-style theme; scope legacy /pay under .payapp"
```

---

## Task 2: Restyle `/login` to the new theme

**Files:**
- Modify: `src/app/login/page.tsx`
- Modify: `src/app/login/login-form.tsx`

- [ ] **Step 1: Replace `src/app/login/page.tsx`**

```tsx
import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="sh-login-page">
      <div className="sh-login-card">
        <div className="sh-brand">
          <div className="sh-brand-mark">SH</div>
          SendHome
        </div>
        <h1 className="sh-login-title">Staff sign in</h1>
        <LoginForm />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Replace `src/app/login/login-form.tsx`**

```tsx
'use client';

import { useActionState } from 'react';
import { login } from './actions';

export function LoginForm() {
  const [error, formAction, pending] = useActionState(login, null);
  return (
    <form action={formAction} className="sh-form">
      <label className="sh-form-field">
        Username
        <input
          name="username"
          required
          autoComplete="username"
          className="sh-input"
        />
      </label>
      <label className="sh-form-field">
        Password
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="sh-input"
        />
      </label>
      <button type="submit" disabled={pending} className="sh-btn-primary">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <p className="sh-form-error">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 3: Run the suite and build**

Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx src/app/login/login-form.tsx
git commit -m "feat(ui): restyle login to Stripe-style theme"
```

---

## Task 3: Dashboard shell — layout + TopBar + Sidebar

**Files:**
- Create: `src/app/dashboard/layout.tsx`
- Create: `src/app/dashboard/top-bar.tsx`
- Create: `src/app/dashboard/sidebar.tsx`

After this task, `/dashboard` and `/dashboard/team` will both render the shell. Their inner content (still using old classes) will look unstyled until Tasks 4 and 6.

- [ ] **Step 1: Create `src/app/dashboard/top-bar.tsx`**

```tsx
import { requireStaff } from '@/lib/auth';
import { logout } from '../login/actions';
import { LiveRefresh } from './live-refresh';

export async function TopBar() {
  const staff = await requireStaff();
  const initial = staff.name.charAt(0).toUpperCase();
  return (
    <header className="sh-topbar">
      <div className="sh-brand">
        <div className="sh-brand-mark">SH</div>
        SendHome
      </div>
      <div className="sh-search" aria-hidden="true">
        🔍 &nbsp;Search transactions, recipients, schedules…
      </div>
      <div className="sh-top-right">
        <LiveRefresh />
        <div className="sh-user">
          <div className="sh-avatar">{initial}</div>
          <span>{staff.name}</span>
        </div>
        <form action={logout}>
          <button type="submit" className="sh-btn-secondary">
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Create `src/app/dashboard/sidebar.tsx`**

```tsx
import { requireStaff } from '@/lib/auth';

export type SidebarActive = 'overview' | 'team';

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
      <a href="/dashboard#transactions" className="sh-nav-item">
        <span className="sh-nav-icon">↔</span> Transactions
      </a>
      <a href="/dashboard#schedules" className="sh-nav-item">
        <span className="sh-nav-icon">↻</span> Schedules
      </a>
      <a href="/dashboard#attention" className="sh-nav-item">
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

- [ ] **Step 3: Create `src/app/dashboard/layout.tsx`**

```tsx
import type { ReactNode } from 'react';
import { TopBar } from './top-bar';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sh-app">
      <TopBar />
      <div className="sh-body">{children}</div>
    </div>
  );
}
```

The `Sidebar` is rendered by each page (not the layout) because it takes the `active` prop. The layout only owns the shell wrappers + the top bar.

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: PASS — `/dashboard` and `/dashboard/team` compile; the new `TopBar` is server-rendered.

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/layout.tsx src/app/dashboard/top-bar.tsx src/app/dashboard/sidebar.tsx
git commit -m "feat(ui): add dashboard shell (TopBar + Sidebar + layout)"
```

---

## Task 4: Restyle the dashboard page content (metrics, attention, schedules — table still inline)

**Files:**
- Modify: `src/app/dashboard/page.tsx`

The transactions table stays inline for one more task; Task 5 extracts it into the client component with tab filtering.

- [ ] **Step 1: Replace `src/app/dashboard/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { getScheduleStore } from '@/lib/schedule-store';
import { requireStaff } from '@/lib/auth';
import { hasPermission } from '@/lib/permissions';
import { summarize, needsAttention } from '@/lib/dashboard';
import type { Schedule, Staff, Transfer } from '@/lib/types';
import { Sidebar } from './sidebar';
import {
  cancelTransferAction,
  assignTransferAction,
  resendPaymentLinkAction,
} from './actions';

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
function inr(amount: number): string {
  return `₹${amount.toLocaleString('en-IN')}`;
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

function StatusPill({ status }: { status: Transfer['status'] }) {
  const klass =
    status === 'delivered' ? 'sh-pill-success' :
    status === 'paid' ? 'sh-pill-info' :
    status === 'awaiting_payment' ? 'sh-pill-neutral' :
    status === 'cancelled' ? 'sh-pill-warning' :
    'sh-pill-danger';
  return (
    <span className={`sh-pill ${klass}`}>
      <span className="sh-pill-dot"></span>{status.replace('_', ' ')}
    </span>
  );
}

function ComplianceBadge({ status }: { status: Transfer['complianceStatus'] }) {
  const klass =
    status === 'cleared' ? 'sh-pill-success' :
    status === 'flagged' ? 'sh-pill-warning' :
    'sh-pill-danger';
  return (
    <span className={`sh-pill ${klass}`}>
      <span className="sh-pill-dot"></span>{status}
    </span>
  );
}

function Stage({ at, fallback }: { at?: string; fallback: string }) {
  if (at) {
    return (
      <span className="sh-stage">
        <span className="sh-check">✓</span>
        {new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    );
  }
  return <span className="sh-stage-pending">{fallback}</span>;
}

function AssignForm({ id, staff }: { id: string; staff: Staff[] }) {
  return (
    <form action={assignTransferAction} className="sh-inline-form">
      <input type="hidden" name="id" value={id} />
      <select name="assignee" className="sh-inline-select" required>
        <option value="">Assign…</option>
        {staff.map((s) => (
          <option key={s.username} value={s.username}>{s.name}</option>
        ))}
      </select>
      <input type="text" name="note" placeholder="Note" className="sh-inline-input" />
      <button type="submit" className="sh-mini-btn">Save</button>
    </form>
  );
}

function RowActions({
  transfer, viewer, staff,
}: { transfer: Transfer; viewer: Staff; staff: Staff[] }) {
  const { status, id } = transfer;
  const canCancel = hasPermission(viewer, 'canCancel');
  const canResend = hasPermission(viewer, 'canResend');
  const canAssign = hasPermission(viewer, 'canAssign');

  return (
    <div className="sh-attention-actions">
      {status === 'awaiting_payment' && canResend && (
        <form action={resendPaymentLinkAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="sh-mini-btn">Resend link</button>
        </form>
      )}
      {(status === 'awaiting_payment' || status === 'paid') && canCancel && (
        <form action={cancelTransferAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Cancel</button>
        </form>
      )}
      {canAssign && <AssignForm id={id} staff={staff} />}
    </div>
  );
}

export default async function DashboardPage() {
  const viewer = await requireStaff();
  const transfers = await getStore().listTransfers();
  const staff = await getAuthStore().listStaff();
  const schedules = await getScheduleStore().listSchedules();
  const now = Date.now();
  const summary = summarize(transfers, now);
  const attention = transfers.filter((t) => needsAttention(t, now));
  const staffByUsername = new Map(staff.map((s) => [s.username, s.name]));
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

        <section className="sh-metrics">
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
          <div className="sh-metric">
            <div className="sh-metric-label">All-time commission</div>
            <div className="sh-metric-value">{usd(summary.commissionAllTime)}</div>
            <div className="sh-metric-sub">Across {transfers.length} transfers</div>
          </div>
        </section>

        <section id="attention" className="sh-attention">
          <div className="sh-attention-title">
            ⚠ Needs Attention
            <span className="sh-attention-count">{attention.length} items</span>
          </div>
          {attention.length === 0 ? (
            <div className="sh-attention-meta">Nothing needs attention right now.</div>
          ) : (
            attention.map((t) => (
              <div key={t.id} className="sh-attention-row">
                <div className="sh-attention-info">
                  <div className="sh-attention-recipient">
                    {t.recipientName}
                    {t.complianceStatus !== 'cleared' && ` — ${t.complianceStatus}`}
                  </div>
                  <div className="sh-attention-meta">
                    {usd(t.amountUsd)} · {t.payoutMethod.toUpperCase()} ·{' '}
                    {t.complianceReasons.length > 0
                      ? t.complianceReasons.join(' · ')
                      : `awaiting payment since ${new Date(t.createdAt).toLocaleString()}`}
                  </div>
                </div>
                <RowActions transfer={t} viewer={viewer} staff={staff} />
              </div>
            ))
          )}
        </section>

        <section id="transactions" className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Transactions</div>
              <div className="sh-card-sub">All transfers, newest first</div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {transfers.length === 0 ? (
              <div className="sh-empty">No transactions yet.</div>
            ) : (
              <table className="sh-table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Amount</th>
                    <th>Funding</th>
                    <th>US Payment</th>
                    <th>India Delivery</th>
                    <th>Compliance</th>
                    <th>Status</th>
                    <th>Assignee</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((t) => (
                    <tr key={t.id}>
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
                      <td>{humanizeFunding(t.fundingMethod)}</td>
                      <td><Stage at={t.paidAt} fallback="pending" /></td>
                      <td>
                        <Stage
                          at={t.deliveredAt}
                          fallback={t.status === 'paid' ? 'in transit' : '—'}
                        />
                      </td>
                      <td><ComplianceBadge status={t.complianceStatus} /></td>
                      <td><StatusPill status={t.status} /></td>
                      <td>
                        {t.assignedTo
                          ? staffByUsername.get(t.assignedTo) ?? t.assignedTo
                          : <span className="sh-recipient-sub">—</span>}
                      </td>
                      <td><RowActions transfer={t} viewer={viewer} staff={staff} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section id="schedules" className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Recurring Schedules</div>
              <div className="sh-card-sub">
                {schedules.filter((s) => s.status === 'active').length} active
              </div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            {schedules.length === 0 ? (
              <div className="sh-empty">No recurring schedules yet.</div>
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
                  {schedules.map((s) => (
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

- [ ] **Step 2: Run the suite and build**

Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: PASS — `/dashboard` compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/page.tsx
git commit -m "feat(ui): restyle dashboard page content (metrics, attention, table, schedules)"
```

---

## Task 5: Transactions table with tab filtering (client component)

**Files:**
- Create: `src/app/dashboard/transactions-tabs.tsx`
- Modify: `src/app/dashboard/page.tsx` (use the new component)

- [ ] **Step 1: Create `src/app/dashboard/transactions-tabs.tsx`**

```tsx
'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Transfer } from '@/lib/types';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_payment', label: 'Awaiting' },
  { key: 'paid', label: 'Paid' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'blocked', label: 'Blocked' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function TransactionsTabs({
  transfers,
  renderRow,
}: {
  transfers: Transfer[];
  renderRow: (t: Transfer) => ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>('all');
  const visible =
    tab === 'all' ? transfers : transfers.filter((t) => t.status === tab);

  return (
    <>
      <div className="sh-card-head">
        <div>
          <div className="sh-card-title">Transactions</div>
          <div className="sh-card-sub">
            {visible.length} of {transfers.length} transfers
          </div>
        </div>
        <div className="sh-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`sh-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="sh-ledger-wrap">
        {visible.length === 0 ? (
          <div className="sh-empty">No transactions in this view.</div>
        ) : (
          <table className="sh-table">
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Amount</th>
                <th>Funding</th>
                <th>US Payment</th>
                <th>India Delivery</th>
                <th>Compliance</th>
                <th>Status</th>
                <th>Assignee</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>{visible.map((t) => renderRow(t))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
```

The component accepts a `renderRow` function so the server-side row JSX (with server-action `<form>`s and the staff map for assignee names) stays in `page.tsx` — only the tab state lives client-side. React server components can pass server-rendered children/render-props into client components.

- [ ] **Step 2: Use it in `src/app/dashboard/page.tsx`**

Add the import at the top:

```tsx
import { TransactionsTabs } from './transactions-tabs';
```

Replace the entire `<section id="transactions" className="sh-card"> … </section>` block in `page.tsx` (the whole transactions card from Task 4) with:

```tsx
        <section id="transactions" className="sh-card">
          <TransactionsTabs
            transfers={transfers}
            renderRow={(t) => (
              <tr key={t.id}>
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
                <td>{humanizeFunding(t.fundingMethod)}</td>
                <td><Stage at={t.paidAt} fallback="pending" /></td>
                <td>
                  <Stage
                    at={t.deliveredAt}
                    fallback={t.status === 'paid' ? 'in transit' : '—'}
                  />
                </td>
                <td><ComplianceBadge status={t.complianceStatus} /></td>
                <td><StatusPill status={t.status} /></td>
                <td>
                  {t.assignedTo
                    ? staffByUsername.get(t.assignedTo) ?? t.assignedTo
                    : <span className="sh-recipient-sub">—</span>}
                </td>
                <td><RowActions transfer={t} viewer={viewer} staff={staff} /></td>
              </tr>
            )}
          />
        </section>
```

- [ ] **Step 3: Run the suite and build**

Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: PASS — `/dashboard` compiles; the tabs component is reported as a client component.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/transactions-tabs.tsx src/app/dashboard/page.tsx
git commit -m "feat(ui): tabbed client-side filtering on the transactions table"
```

---

## Task 6: Restyle `/dashboard/team`

**Files:**
- Modify: `src/app/dashboard/team/page.tsx`

- [ ] **Step 1: Replace `src/app/dashboard/team/page.tsx`**

```tsx
export const dynamic = 'force-dynamic';

import { getAuthStore } from '@/lib/auth-store';
import { requireAdmin } from '@/lib/auth';
import {
  addStaffAction,
  updatePermissionsAction,
  removeStaffAction,
} from './actions';
import type { Staff } from '@/lib/types';
import { Sidebar } from '../sidebar';

function PermissionCheckbox({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked: boolean;
}) {
  return (
    <label className="sh-perm">
      <input type="checkbox" name={name} defaultChecked={checked} /> {label}
    </label>
  );
}

function StaffRow({ staff }: { staff: Staff }) {
  if (staff.role === 'admin') {
    return (
      <tr>
        <td>{staff.name}</td>
        <td>{staff.username}</td>
        <td>
          <span className="sh-pill sh-pill-info">
            <span className="sh-pill-dot"></span>admin
          </span>
        </td>
        <td colSpan={2}>
          <span className="sh-recipient-sub">Full access (all permissions)</span>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{staff.name}</td>
      <td>{staff.username}</td>
      <td>
        <span className="sh-pill sh-pill-neutral">
          <span className="sh-pill-dot"></span>agent
        </span>
      </td>
      <td>
        <form action={updatePermissionsAction} className="sh-inline-form">
          <input type="hidden" name="username" value={staff.username} />
          <PermissionCheckbox name="canCancel" label="Cancel/refund" checked={staff.permissions.canCancel} />
          <PermissionCheckbox name="canResend" label="Resend" checked={staff.permissions.canResend} />
          <PermissionCheckbox name="canAssign" label="Assign" checked={staff.permissions.canAssign} />
          <button type="submit" className="sh-mini-btn">Save</button>
        </form>
      </td>
      <td>
        <form action={removeStaffAction}>
          <input type="hidden" name="username" value={staff.username} />
          <button type="submit" className="sh-mini-btn sh-mini-btn-danger">Remove</button>
        </form>
      </td>
    </tr>
  );
}

export default async function TeamPage() {
  await requireAdmin();
  const staff = await getAuthStore().listStaff();

  return (
    <>
      <Sidebar active="team" />
      <main className="sh-main">
        <div className="sh-page-head">
          <div>
            <div className="sh-page-title">Team &amp; Permissions</div>
            <div className="sh-page-sub">Manage staff accounts and per-agent permissions</div>
          </div>
        </div>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Staff</div>
              <div className="sh-card-sub">{staff.length} member{staff.length === 1 ? '' : 's'}</div>
            </div>
          </div>
          <div className="sh-ledger-wrap">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => <StaffRow key={s.username} staff={s} />)}
              </tbody>
            </table>
          </div>
        </section>

        <section className="sh-card">
          <div className="sh-card-head">
            <div>
              <div className="sh-card-title">Add a team agent</div>
              <div className="sh-card-sub">Agents log in with their own credentials and the permissions you select</div>
            </div>
          </div>
          <form id="add-staff-form" action={addStaffAction} className="sh-add-staff-form">
            <input name="name" placeholder="Full name" required className="sh-input" />
            <input name="username" placeholder="Username" required className="sh-input" />
            <input name="password" type="password" placeholder="Password" required className="sh-input" />
          </form>
          <div className="sh-perm-row">
            <label className="sh-perm">
              <input type="checkbox" name="canCancel" form="add-staff-form" /> Cancel/refund
            </label>
            <label className="sh-perm">
              <input type="checkbox" name="canResend" form="add-staff-form" /> Resend link
            </label>
            <label className="sh-perm">
              <input type="checkbox" name="canAssign" form="add-staff-form" /> Assign
            </label>
          </div>
          <div style={{ padding: '0 20px 20px' }}>
            <button type="submit" form="add-staff-form" className="sh-btn-primary">
              Add agent
            </button>
          </div>
        </section>
      </main>
    </>
  );
}
```

Note: the add-agent form is split across three visual blocks (text inputs in the first `<form>` element, permission checkboxes outside it, submit button below). The `form="add-staff-form"` attribute on the checkboxes and submit button associates them with the form by id, so they're all submitted together. This lets the form span the card's layout cleanly without restructuring the markup.

- [ ] **Step 2: Run the suite and build**

Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: PASS — `/dashboard/team` compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/dashboard/team/page.tsx
git commit -m "feat(ui): restyle Team & Permissions page"
```

---

## Task 7: Polish the LiveRefresh indicator + final verification

**Files:**
- Modify: `src/app/dashboard/live-refresh.tsx`

- [ ] **Step 1: Replace `src/app/dashboard/live-refresh.tsx`**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function LiveRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return (
    <span className="sh-live">
      <span className="sh-live-dot"></span>Live
    </span>
  );
}
```

- [ ] **Step 2: Run the full suite and a fresh build**

Run: `npm test`
Expected: PASS — every test file green.
Run: `npm run build`
Expected: PASS — all routes (`/login`, `/dashboard`, `/dashboard/team`, `/pay/[transferId]`, `/api/whatsapp`, `/api/pay/[transferId]`, `/api/cron`) compile with no type errors.

- [ ] **Step 3: Visual sanity check (manual)**

Run `npm run dev` and visit each page:
- `/login` — Stripe-style centered card on light background.
- `/dashboard` — top bar (with brand, search placeholder, live dot, user, logout) and left sidebar (Overview active); 5 metric cards; Needs Attention panel; tabbed transactions table; recurring schedules card. Click each tab and confirm filtering works.
- `/dashboard/team` — same shell, Team active in sidebar, staff table, add-agent form.
- `/pay/<anyid>` — original WhatsApp-dark theme, unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/app/dashboard/live-refresh.tsx
git commit -m "feat(ui): restyle live-refresh indicator to match dashboard theme"
```

---

## Manual Verification (after deployment)

1. Deploy to Vercel.
2. Open `https://claude-payments.vercel.app/dashboard` → redirected to `/login`. Sign in.
3. Confirm the polished Stripe-style dashboard loads — top bar, sidebar, all five metric cards, attention panel, tabbed transactions table, recurring schedules.
4. Click each tab on the transactions table — table filters client-side without reload.
5. Click **Team & Permissions** in the sidebar → loads the restyled team page.
6. Open `/pay/<any-id>` from a known transfer → still the WhatsApp-dark theme.
7. Click **Log out** → returns to the styled login screen.

---

## Self-Review Notes

- **Spec coverage:** design tokens + base theme (Task 1), `.payapp` scope for legacy /pay (Task 1), login restyle (Task 2), dashboard shell with top bar + sidebar (Task 3), restyled dashboard content with the five metric cards / needs-attention / schedules (Task 4), tabbed transactions table client component (Task 5), team page restyle (Task 6), live-refresh polish (Task 7). All in-scope items covered. Out-of-scope items (search wired up, "+ New transfer", date range, export, trend deltas, /pay restyle, separate Settings page) are intentionally absent.
- **Type consistency:** `Staff`, `Transfer`, `Schedule` types reused unchanged from existing `@/lib/types`. `SidebarActive` union (`'overview' | 'team'`) defined once in `sidebar.tsx`. `TabKey` derived from the `TABS` const in `transactions-tabs.tsx`. `LiveRefresh` props unchanged (`intervalMs`).
- **No placeholders:** every step has complete code or an exact command. Visual sanity checks are explicit. No "add appropriate styling" — every CSS rule is written out.
- **Risks:** the Task 6 add-agent form changed from a single `<form>` wrapping checkboxes + submit to a form/button pair using `form="add-staff-form"` to allow the visual layout. The submit-by-id pattern is HTML-standard. If the build fails or the form doesn't submit, the simpler fallback is to put the checkboxes + submit inside the same `<form>` tag (sacrifices some visual layout).
