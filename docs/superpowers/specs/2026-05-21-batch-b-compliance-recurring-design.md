# Batch B — Compliance Screening + Recurring Transfers (Design)

**Date:** 2026-05-21
**Status:** Approved — proceeding to implementation plan

## Purpose

Add two "trust & automation" features to the SendHome prototype: a mock
compliance/fraud screening step on every transfer, and customer-configurable
recurring (scheduled) transfers. Everything is mocked where real rails would be
required, stored in Redis, and surfaced on the admin dashboard.

## Locked decisions

| Topic | Decision |
|---|---|
| Compliance action | Two tiers — severe → hard `blocked`; moderate → `flagged` (proceeds) |
| Recurring execution | On each due date, send the customer a WhatsApp payment link to approve |
| Recurrence frequencies | Monthly (day 1–28) and weekly (weekday) |

## Feature 1 — Compliance & fraud screening

### `src/lib/compliance.ts` (new, pure)

```
screenTransfer({ amountUsd, recipientName, transfersToday }): ComplianceResult
```

- `ComplianceResult = { status: 'cleared' | 'flagged' | 'blocked'; reasons: string[] }`
- **blocked** — `recipientName` (case-insensitive, trimmed) matches an entry in a
  small hardcoded mock watchlist (`WATCHLIST`). Reason: "Recipient is on the
  compliance watchlist."
- **flagged** — not blocked, and either: `amountUsd >= 1000` ("Large transfer
  amount") or `transfersToday >= 3` ("High transfer velocity"). Both reasons are
  recorded when both apply.
- **cleared** — none of the above; `reasons` empty.
- `blocked` precedence over `flagged`.

### Data model changes (`src/lib/types.ts`)

- `TransferStatus` gains `'blocked'` → `'awaiting_payment' | 'paid' | 'delivered' | 'cancelled' | 'blocked'`.
- `Transfer` gains: `complianceStatus: 'cleared' | 'flagged' | 'blocked'` and
  `complianceReasons: string[]`.

### Velocity counter (`src/lib/store.ts`)

- `incrementTodayTransferCount(phone)` — atomic `incr` on `velocity:{phone}:{easternDate}`.
- `getTodayTransferCount(phone)` — reads that key, returns a number (0 default).
- `easternDate` = the US-Eastern calendar date string, consistent with `dashboard.ts`.

### Integration (`src/lib/tools.ts`)

`create_transfer` executor:
1. Read `transfersToday` via `getTodayTransferCount(phone)`.
2. `screenTransfer(...)`.
3. Build the `Transfer` with `complianceStatus`/`complianceReasons`. If
   `blocked`, set `status: 'blocked'`; otherwise `status: 'awaiting_payment'`.
4. Save the transfer; `incrementTransferCount` and `incrementTodayTransferCount`.
5. Return a result that includes `compliance_status`. When `blocked`, the result
   makes clear the transfer cannot proceed (the bot relays this; it must not
   call `generate_payment_link`).

`generate_payment_link` executor: if the transfer's `status === 'blocked'`,
return `{ error: 'This transfer did not pass compliance and cannot be paid.' }`.

### Dashboard (`src/app/dashboard/`)

- New **Compliance** column in the ledger (badge: cleared / flagged / blocked).
- `dashboard.ts` — "needs attention" now includes any transfer whose
  `complianceStatus` is `flagged` or `blocked` (in addition to abandoned).
- A summary metric "Flagged / blocked today".

## Feature 2 — Recurring scheduled transfers

### `Schedule` type (`src/lib/types.ts`)

```
Schedule {
  id: string;
  phone: string;                       // the customer's WhatsApp number
  amountUsd: number;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  frequency: 'monthly' | 'weekly';
  dayOfMonth?: number;                 // 1–28, when frequency = monthly
  dayOfWeek?: number;                  // 0–6 (Sun–Sat), when frequency = weekly
  status: 'active' | 'cancelled';
  createdAt: string;
  lastRunAt?: string;                  // ISO date of the last fire
}
```

### `src/lib/schedule-store.ts` (new)

`createScheduleStore(redis)` → `{ getSchedule, saveSchedule, listSchedules,
listActiveSchedules }`. Keys: `schedule:{id}`, set `schedules:ids`. A singleton
`getScheduleStore()`. Cancelling = `saveSchedule` with `status: 'cancelled'`.

### Agent tools (`src/lib/tools.ts`, `src/lib/prompt.ts`)

- `create_schedule({ amount_usd, recipient_name, recipient_phone, payout_method,
  payout_destination, funding_method, frequency, day_of_month?, day_of_week? })`
  — validates the recipient phone (reuse `phone.ts`), validates day ranges
  (monthly 1–28, weekly 0–6), saves the schedule.
- `list_schedules()` — the calling customer's schedules.
- `cancel_schedule({ schedule_id })` — sets status `cancelled` (only the owner's).
- `SYSTEM_PROMPT` updated so the bot can collect recurrence details and explain
  that it will send a payment link on each due date.

### Cron (`src/app/api/cron/route.ts`, new)

- Runs daily via Vercel cron (`vercel.json`). Guarded by a `CRON_SECRET` check
  when that env var is present (Vercel sends it as a Bearer token).
- Logic: for each active schedule, if it is **due today** (monthly:
  `dayOfMonth === today's Eastern day-of-month`; weekly: `dayOfWeek === today's
  Eastern weekday`) **and** `lastRunAt` is not today:
  1. Create a `Transfer` from the schedule (this also runs compliance).
  2. If not blocked, generate the payment link.
  3. Send the customer a WhatsApp **template** message (`scheduled_payment_ready`)
     containing the link.
  4. Set `lastRunAt` to today and save the schedule.
- `vercel.json` adds `{ "crons": [{ "path": "/api/cron", "schedule": "0 13 * * *" }] }`.

### WhatsApp template dependency

The cron's message to the customer is business-initiated outside the 24-hour
window, so it must be a **template**. A new template `scheduled_payment_ready`
must be created and approved in WhatsApp Manager (exact text supplied to the
user during build). `whatsapp.ts` already has `sendTemplate`. Until the template
is approved, scheduled sends fail gracefully (logged, no crash).

### Dashboard

A new **Recurring Schedules** section: recipient, amount, frequency, next due
date, last run, status.

## Testing

- `compliance.ts` — block (watchlist), flag (amount, velocity, both), clear,
  precedence.
- `schedule-store.ts` — CRUD + active filter.
- Schedule due-date logic — monthly and weekly, the `lastRunAt`-today guard.
- The cron handler — due schedules produce transfers + send template; not-due
  skipped; the `CRON_SECRET` guard.
- `store.ts` — velocity counter increment/read.
- Updated `tools.ts` tests for compliance integration and the new schedule tools.

## Out of scope

Real KYC/sanctions providers, real auto-debit (no saved payment method — each
recurrence still uses a payment link), sub-daily cron (plan limit), recurrence
on days 29–31, and customer-facing schedule management UI (managed via chat and
viewable on the dashboard).
