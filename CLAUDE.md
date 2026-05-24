# CLAUDE.md — SendHome Project Context

Project context for any Claude session working in this repo. Keep concise; update when the architecture or stack changes meaningfully.

## What this is

**SendHome** — a working prototype of a WhatsApp-based US→India remittance service, inspired by Felix Pago. Customers chat with an AI agent in WhatsApp to send money; staff manage everything through a Stripe-style admin dashboard. **All real money movement is mocked** — no actual Plaid, FedNow, or UPI integration. Every transfer is realistic on screen but doesn't move a cent.

Live at **https://claude-payments.vercel.app** (admin credentials live in Vercel env vars `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` — never commit literal values).

## Stack

- **Next.js 16** (App Router) on **Vercel** — serverless
- **TypeScript** + **Vitest** (29 test files, ~209 tests at time of writing)
- **Upstash Redis** — primary store (transfers, schedules, conversations, staff, sessions, velocity counters)
- **Ollama Cloud** running **Kimi K2.6** — the conversational agent
- **Meta WhatsApp Cloud API** — chat I/O (test number, see memory `sendhome-meta-state`)
- **Recharts** — dashboard analytics charts
- **Frankfurter API** — live USD→INR FX rate (no key)

## Repo layout

```
src/
  app/
    api/whatsapp/route.ts         - Meta webhook (GET verify, POST receive)
    api/pay/[transferId]/route.ts - Mock card / bank-link payment + stage 1/2 delivery
    api/cron/route.ts             - Daily cron: fires due recurring schedules
    pay/[transferId]/             - Customer-facing pay page (WhatsApp-dark theme, scoped under .payapp)
    login/                        - Staff login (sh-* Stripe-style theme)
    dashboard/                    - Admin dashboard (multi-page, Stripe-style)
      page.tsx                    -   Overview (slim)
      transactions/page.tsx       -   Full ledger with search + date filter + tabs
      schedules/page.tsx          -   Recurring schedules
      compliance/page.tsx         -   Flagged + blocked + watchlist + velocity
      analytics/page.tsx          -   Recharts charts with 7d/30d/90d toggle
      team/page.tsx               -   Staff + permissions (admin only)
      layout.tsx, top-bar.tsx, sidebar.tsx, live-refresh.tsx (5s polling)
  lib/                            - All non-UI logic — most files single-responsibility
    agent.ts, ollama.ts, prompt.ts, tools.ts   - Chat agent + tools
    store.ts                      - Redis access (transfers, conversations, velocity)
    auth-store.ts                 - Redis access (staff, sessions)
    schedule-store.ts             - Redis access (recurring schedules)
    payment.ts                    - Two-stage delivery logic
    transfer-create.ts            - Shared createTransfer() — agent tool + cron both use it
    compliance.ts                 - Mock screening engine (watchlist + amount + velocity)
    fx.ts, rate.ts                - Quote math + live FX
    dashboard.ts, analytics.ts    - Pure aggregator helpers
    permissions.ts, auth.ts, seed.ts, password.ts, session-cookie.ts - Staff auth
    whatsapp.ts                   - Meta Cloud API client (sendText, sendTemplate)
    phone.ts, dates.ts, id.ts, types.ts, env.ts - Utilities
  middleware.ts                   - Gates /dashboard (auth)
tests/                            - Vitest specs (one per lib module)
docs/
  superpowers/specs/              - Design specs (one per batch)
  superpowers/plans/              - Implementation plans (one per batch)
  ROADMAP.md                      - Feature status + path to production
```

## Working conventions

- **Server actions** in `src/app/dashboard/actions.ts` etc. are imported by client components — server actions can cross the server→client boundary, **plain functions cannot** (we've been bitten by this; design accordingly).
- **Pure helpers** (`fx.ts`, `compliance.ts`, `dashboard.ts`, `analytics.ts`, `transfer-create.ts`, etc.) are TDD'd; UI pages are not unit-tested.
- **Live updates** on every dashboard page via `<LiveRefresh>` in the layout's TopBar; pages are `export const dynamic = 'force-dynamic'`; sidebar uses `next/link` for soft navigation so the polling timer stays continuous.
- **CSS** lives entirely in `src/app/globals.css` with two scopes: the `sh-*` Stripe-style theme (login + dashboard) and a legacy `.payapp`-scoped WhatsApp-dark theme (preserved for the pay page).
- **Deploys** are currently manual via `vercel --prod`. The CI/CD batch in `docs/superpowers/plans/2026-05-23-cicd.md` swaps this for GitHub Actions + Vercel auto-deploy.
- **Branches:** `master` (initial state) and `feat/sendhome-prototype` (all the work). CI/CD plan migrates to a `main` branch as the deploy target.

## Key external configuration

Env vars (see `.env.example`):

- `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL` — Ollama Cloud / Kimi K2.6
- `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` — Meta Cloud API (see memory `sendhome-meta-state`)
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — Upstash Redis (provisioned via Vercel Marketplace)
- `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD` — first admin account; only seeds when the staff list is empty (rotation = delete `staff:<username>` in Upstash, change env var, redeploy)
- `APP_BASE_URL` — currently empty in prod; the code self-derives from `VERCEL_PROJECT_PRODUCTION_URL` (auto-injected by Vercel)
- `CRON_SECRET` (optional) — gates `/api/cron`

## Project state

See `docs/ROADMAP.md` for the realistic feature inventory (what's built, what's mocked, what needs real partnerships/licenses) and the proposed forward path.

## Workflow rules

- **Plan first, get approval, then build.** Use `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` for any meaningful change.
- **The literal word "deploy" is required from the user before `vercel --prod`** — the Vercel auto-mode classifier blocks otherwise.
- This is also captured in the `sendhome-user-workflow` memory.
