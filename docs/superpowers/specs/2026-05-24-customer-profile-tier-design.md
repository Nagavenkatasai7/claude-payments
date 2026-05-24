# Customer Profile + New-Account Tier — Design

**Date:** 2026-05-24
**Status:** Awaiting review
**Owner:** SendHome
**Batch:** Lane B step 1 (B1) — architectural prep for KYC

## Why

Today every customer can immediately send up to $2,999 from their first message, with no identity check beyond a WhatsApp number. That's the prototype model. To become a real product we need three things landed together:

1. **Trust-graduated onboarding.** New senders cap at $500/day for a 3-day observation period. Standard fintech practice (Wise, Remitly, WU all variants).
2. **Customer profile.** A durable per-sender record holding KYC status, tier, lifetime stats. Distinct from per-transfer records.
3. **KYC abstraction.** An interface (`KycProvider`) the rest of the code talks to. Mock implementation now; Persona swaps in behind it in B2 without rewriting the agent.

Shipping this batch produces real safety value immediately (caps the blast radius of a stolen account) and unblocks B2's KYC integration to drop in cleanly.

## Scope

**In:**

1. New `Customer` Redis record per sender, lazily created on first inbound, idempotently.
2. New tier rules (T0 / T1 / Suspended) derived purely from `Customer` + `now`.
3. New per-day cumulative-volume counter in Redis, denominated in cents (`daily_volume:<phone>:<easternDate>`).
4. New `KycProvider` interface + `MockKycProvider` implementation. `MockKycProvider.startVerification` returns a dashboard URL the staff use to manually mark verified.
5. New agent tool `check_send_limit(amount_usd)` — bot calls before quoting.
6. Cap enforcement at three layers: agent pre-check, `send_approve_picker` gate, `create_transfer` final gate.
7. `TurnContext` gains `isNewCustomer` + `tierReminderDayOfWindow` flags that drive system-note injection. The LLM cannot fabricate either.
8. System prompt teaches the bot the cap UX, the four surface points, and how to read the new context flags.
9. New dashboard page `/dashboard/customers` (list) + `/dashboard/customers/[phone]` (detail) with admin-only `[Mark KYC verified]` action.
10. Tier badge column added to `/dashboard/transactions`.
11. Backfill migration: any phone with at least one pre-existing `transfer:*` becomes a `kycStatus: 'grandfathered'` customer on first cron run (or first inbound, whichever happens earlier).

**Out:**

- Real KYC provider integration (Persona / Onfido / Veriff) — that's batch B2.
- Real sanctions screening — batch B3.
- Adaptive tier system (T2+ based on lifetime stats) — defer until we have data on what to adapt to.
- Per-customer override of cap (e.g. "give this trusted user T1 early") — defer.
- Bulk operations / CSV export / staff notes on the dashboard.
- Source-of-funds / EDD threshold workflow — batch B5.
- Webhook receiver for KYC provider — wired in B2.

## User-visible behaviour

### Three customer states

| State | Trigger | Daily cap | Per-transfer cap |
|---|---|---|---|
| **T0 (observing)** | `kycStatus !== 'rejected'` AND `now − firstSeenAt < 3 days` | $500/day cumulative | $500 |
| **T1 (verified)** | `kycStatus ∈ {'verified', 'grandfathered'}` AND `now − firstSeenAt ≥ 3 days` | $2,999/day | $2,999 |
| **Suspended** | `kycStatus === 'rejected'`, OR `now − firstSeenAt ≥ 3 days` AND `kycStatus ∉ {'verified', 'grandfathered'}` | $0 | $0 |

**Critical invariant:** KYC verification *during* the 3-day window does NOT lift the cap. The window is a full observation period. KYC verification just guarantees the user transitions to T1 (not Suspended) on day 4. This is stricter than the typical "verify-to-unlock" model and is an explicit product decision.

Existing senders with prior transfers get `kycStatus: 'grandfathered'` → treated as T1 with no observation period, so they see no behavior change after the deploy.

### Four in-chat surface moments

```
1. First-ever message from a phone (firstSeenAt = now):
   "Hey 👋 Welcome to SendHome. Quick heads-up:
    For your first 3 days, you can send up to $500/day while we
    verify you. Verify here to lift the cap on day 4: <kyc_url>
    Ready when you are — how much would you like to send?"

2. First message of each new conversation (24h+ gap) in the 3-day window:
   "Welcome back 👋 You're on day 2 of your 3-day intro period
    ($500/day cap). Verify any time: <kyc_url>
    Who are we sending to? [Mom] [Brother] [Someone new]"

3. User asks to send more than today's remaining cap:
   "Your daily cap is $500 right now (you've already sent $300 today,
    so you have $200 left). Want to send $200, or wait until tomorrow
    when the cap resets?"

4. Day 4+, KYC not verified (Suspended):
   "Your 3-day intro period has ended. To continue sending, please
    complete verification: <kyc_url>
    Once you're verified you can send up to $2,999/day."
```

The actual prose is the model's — we test that the right system-context flag is set and the right tool was called, not the exact wording.

### Time semantics

- The 3-day window is measured in milliseconds (`now − firstSeenAt < 3 * 24 * 60 * 60 * 1000`). A sender who signs up at 11:50 PM gets the full 72 hours, not "a few minutes of day 1 then day 2 the next morning."
- The cumulative daily cap resets at **calendar midnight Eastern Time** (matches the existing `easternDate` convention used by the velocity counter). All senders are US-based for now; revisit when we expand corridors.
- Day-of-window for surface text is `Math.floor(ageMs / 86_400_000) + 1`, capped at 3.

## Data model

### `customer:<senderPhone>` — Redis string (JSON)

```ts
interface Customer {
  senderPhone: string;
  firstSeenAt: string;                            // ISO-8601, set once on first inbound
  kycStatus:
    | 'not_started'                                // brand new, no KYC attempt yet
    | 'pending'                                    // KYC initiated, provider hasn't returned
    | 'verified'                                   // KYC passed (mock admin action or B2 webhook)
    | 'rejected'                                   // KYC explicitly failed
    | 'grandfathered';                             // existed before this batch shipped → treat as verified
  kycVerifiedAt?: string;                          // ISO-8601 when status became verified/grandfathered
  kycProviderRef?: string;                         // opaque ID from KYC provider (B2 populates)
  kycRejectedReason?: string;                      // populated when kycStatus === 'rejected'
  // populated by KYC provider webhook (B2):
  fullName?: string;
  dateOfBirth?: string;
  country?: string;
  createdAt: string;                               // === firstSeenAt at creation
  updatedAt: string;                               // bumped on any mutation
}
```

No TTL — Customer records are durable.

### `daily_volume:<senderPhone>:<easternDate>` — Redis string (integer cents)

```
Key:    daily_volume:15551234567:2026-05-24
Type:   string (integer USD cents)
TTL:    48h (yesterday's data survives one day for late audits, then drops)
```

`INCRBY` integer-only — money math stays in cents to avoid float bugs. Conversion `Math.round(amountUsd * 100)` at the input boundary; dollars only at the output boundary.

### `migration:customer-backfill-v1` — Redis string (sentinel)

Value: `'done'` once the backfill has run. Cheap idempotency guard.

### KYC provider abstraction — new file `src/lib/providers/kyc-provider.ts`

```ts
export type KycStatus = 'pending' | 'verified' | 'rejected';

export interface KycStartResult {
  url: string;         // hosted URL the sender is sent to
  providerRef: string; // opaque ID we persist on the Customer
}

export interface KycVerifiedFields {
  fullName?: string;
  dateOfBirth?: string;
  country?: string;
}

export interface KycProvider {
  startVerification(input: { customerId: string; senderPhone: string }): Promise<KycStartResult>;
  getStatus(providerRef: string): Promise<KycStatus>;
  handleWebhook(body: unknown): Promise<{
    providerRef: string;
    status: KycStatus;
    fields?: KycVerifiedFields;
    rejectedReason?: string;
  } | null>;
}
```

B1 ships `MockKycProvider`:
- `startVerification` returns `{ url: '<APP_BASE_URL>/dashboard/customers/<phone>', providerRef: 'mock-<phone>' }`. The URL goes to the staff dashboard so staff can manually flip the customer to verified for testing.
- `getStatus` reads the live status from the Customer record (round-trip back through `customerStore`).
- `handleWebhook` returns `null` — no real webhooks in mock mode.

B2 replaces with `PersonaKycProvider` behind the same interface.

### Two new stores — new files

```ts
// src/lib/customer-store.ts
export interface CustomerStore {
  getCustomer(senderPhone: string): Promise<Customer | null>;
  saveCustomer(customer: Customer): Promise<void>;
  upsertOnFirstInbound(senderPhone: string): Promise<{ customer: Customer; wasCreated: boolean }>;
  listCustomers(): Promise<Customer[]>;
}
// src/lib/daily-volume-store.ts
export interface DailyVolumeStore {
  addCents(senderPhone: string, cents: number): Promise<void>;
  getTodayCents(senderPhone: string): Promise<number>;
}
```

`upsertOnFirstInbound` consults `store.listTransfers()` for any pre-existing transfers on the phone. If found, the new Customer is grandfathered with `firstSeenAt = oldest transfer.createdAt`. Otherwise it's a genuine new customer with `firstSeenAt = now()`. `wasCreated` is `true` only for genuine new customers — never for grandfathered ones.

`addCents` uses Redis `INCRBY` + `EXPIRE 172800` (48h). `getTodayCents` reads the current value or 0 if missing.

## Architecture

```
inbound webhook (WhatsApp Cloud API)
        │
        ▼
parseIncoming(body)
   ├─ text       → IncomingMessage { kind: 'text', ... }
   └─ interactive→ IncomingMessage { kind: 'button', ... }
        │
        ▼
/api/whatsapp/route.ts
   │  1. markMessageSeen (dedup)
   │  2. lastmsg gap check → isNewConversation
   │  3. customerStore.upsertOnFirstInbound(senderPhone) → {customer, wasCreated}
   │  4. recordInboundNow
   │  5. tier = deriveTier(customer, now)
   │  6. dayOfWindow = (tier === 'T0' && isNewConversation && !wasCreated) ? compute : undefined
   │  7. Build TurnContext { isNewConversation, isNewCustomer: wasCreated, tierReminderDayOfWindow: dayOfWindow, buttonTap }
   ▼
agent.runAgentTurn(senderPhone, message, turn)
   │  System notes injected on round 0 only:
   │    if (turn.isNewCustomer)              → "[NEW CUSTOMER] ..."
   │    else if (turn.tierReminderDayOfWindow) → "[TIER_REMINDER day N/3] ..."
   │    if (turn.isNewConversation)          → "[NEW CONVERSATION] ..." (from PR #5)
   │
   ▼
LLM (Kimi K2.6) chooses tools, the new + modified ones being:
   ┌──────────────────────────────────────────────────────────────────────┐
   │  check_send_limit(amount_usd)                                        │
   │    → reads customer + dailyVolume → tier-rules.evaluateCap(...)      │
   │    → returns CapEvaluation                                           │
   │                                                                      │
   │  send_approve_picker(args)                                           │
   │    → evaluateCap(); if !withinCap return { error, cap_eval }         │
   │    → else: createDraft + sendInteractive [Approve][Cancel]           │
   │                                                                      │
   │  create_transfer(args | draftId from ctx)                            │
   │    → consumeDraft (approve-tap) or validate args (legacy/cron)       │
   │    → evaluateCap(); if !withinCap return error                       │
   │    → createTransfer in store                                         │
   │    → dailyVolume.addCents(amountCents)                               │
   │    → store.upsertRecipient (PR #5)                                   │
   └──────────────────────────────────────────────────────────────────────┘
```

The cap check is **idempotent on read** (`evaluateCap` is pure) and **transactional on write** (the dailyVolume INCR happens after a successful `saveTransfer`). Redis `INCRBY` is atomic. A sender can't have concurrent transfers in-flight (WhatsApp serializes per-user) so we don't need a lock around the read-modify-write.

## File-level plan

| Path | Action | Responsibility |
|---|---|---|
| `src/lib/types.ts` | Modify | Add `Customer`, `KycStatus` (re-export from provider), `Tier`, `CapEvaluation`. Extend `TurnContext` with `isNewCustomer` + `tierReminderDayOfWindow`. |
| `src/lib/tier-rules.ts` | **Create** | Pure functions: `deriveTier(customer, now)`, `evaluateCap(customer, now, todayUsedCents, requestedCents)`. Constants for caps + window. |
| `src/lib/customer-store.ts` | **Create** | `getCustomer`, `saveCustomer`, `upsertOnFirstInbound` (with grandfather detection), `listCustomers`. |
| `src/lib/daily-volume-store.ts` | **Create** | `addCents`, `getTodayCents`. |
| `src/lib/providers/kyc-provider.ts` | **Create** | `KycProvider` interface + types. |
| `src/lib/providers/mock-kyc-provider.ts` | **Create** | `MockKycProvider` impl. |
| `src/lib/tools.ts` | Modify | Add `check_send_limit` schema + impl. Modify `send_approve_picker` + `create_transfer` to evaluate cap and (for create_transfer) increment daily volume on success. Extend `ToolContext` with `customerStore`, `dailyVolumeStore`, `kycProvider`. |
| `src/lib/agent.ts` | Modify | Inject `[NEW CUSTOMER]` and `[TIER_REMINDER day N/3]` system notes on round 0 (alongside existing `[NEW CONVERSATION]`). Add `customerStore`, `dailyVolumeStore`, `kycProvider` to `AgentDeps` + ctx. |
| `src/lib/prompt.ts` | Modify | Append `NEW-CUSTOMER ONBOARDING & SENDING LIMITS` section. |
| `src/app/api/whatsapp/route.ts` | Modify | Call `customerStore.upsertOnFirstInbound`, compute `isNewCustomer` + `tierReminderDayOfWindow`, pass into `TurnContext`. Wire `customerStore` / `dailyVolumeStore` / `getKycProvider()` into `createAgent`. |
| `src/app/api/cron/route.ts` | Modify | Add `backfillCustomersOnce(store, customerStore)` step. `?force=true` query param (guarded by `CRON_SECRET`) bypasses the schedule for manual runs. |
| `src/app/dashboard/sidebar.tsx` | Modify | Add `Customers` nav item between Schedules and Compliance. Extend `SidebarActive` with `'customers'`. |
| `src/app/dashboard/customers/page.tsx` | **Create** | List view: table of all customers with tier badge, KYC status, lifetime sent, last activity. Sortable, search by phone. `force-dynamic`. |
| `src/app/dashboard/customers/[phone]/page.tsx` | **Create** | Detail view: identity panel, today's sending panel, activity timeline. Includes admin-only `[Mark KYC verified]` / `[Mark KYC rejected]` forms. |
| `src/app/dashboard/customers/actions.ts` | **Create** | `markCustomerVerifiedAction(formData)`, `markCustomerRejectedAction(formData)` — `requireAdmin`. Update `Customer.kycStatus`, `kycVerifiedAt`/`kycRejectedReason`, `updatedAt`. `revalidatePath('/dashboard/customers')` + `revalidatePath('/dashboard/customers/[phone]')`. |
| `src/app/dashboard/transactions-tabs.tsx` | Modify | Add `Tier` column between `Phone` and `Amount`. Render the badge from a per-row lookup result threaded through props (the page fetches customer records once and zips them with transfers). |
| `src/app/dashboard/transactions/page.tsx` | Modify | After `listTransfers()`, also `listCustomers()`, build a `Map<phone, tier>`, pass to `TransactionsExplorer`. |
| `src/app/globals.css` | Modify | Three small additions: `.sh-tag-tier-t0`, `.sh-tag-tier-t1`, `.sh-tag-tier-suspended` color variants. |
| `tests/tier-rules.test.ts` | **Create** | ~15 cases for the pure tier math. |
| `tests/customer-store.test.ts` | **Create** | CRUD, idempotency, grandfather detection. |
| `tests/daily-volume-store.test.ts` | **Create** | addCents + getTodayCents round-trips, per-phone isolation, per-day isolation. |
| `tests/kyc-provider.test.ts` | **Create** | MockKycProvider behavior. |
| `tests/migration-backfill.test.ts` | **Create** | Backfill creates grandfathered customers from existing transfers; sentinel makes it idempotent. |
| `tests/tools.test.ts` | Modify | Add `check_send_limit` tests + cap-enforcement tests in `send_approve_picker` and `create_transfer`. |
| `tests/agent.test.ts` | Modify | `[NEW CUSTOMER]` and `[TIER_REMINDER]` system-note injection tests. |
| `tests/recipient-store.test.ts` | Modify | Existing `createTransfer side-effects` describe — add an assertion that `daily_volume` also increments. |
| `tests/e2e.test.ts` | Modify | New customer e2e: brand-new → greeted → tries $700 → bot caps → sends $400 → approves → daily_volume = 40000; mid-window mark-verified → cap stays; day-4 → T1 → $2,000 sends. |
| `tests/e2e/dashboard-smoke.spec.ts` | Modify | Add navigation to `/dashboard/customers` + assert table renders. |

## Tier rules (the canonical math)

```ts
// src/lib/tier-rules.ts

const T0_DAILY_CAP_CENTS = 50_000;   // $500.00
const T1_DAILY_CAP_CENTS = 299_900;  // $2,999.00
const OBSERVATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type Tier = 'T0' | 'T1' | 'Suspended';

export function deriveTier(customer: Customer, now: Date): Tier {
  if (customer.kycStatus === 'rejected') return 'Suspended';
  const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
  const inWindow = ageMs < OBSERVATION_WINDOW_MS;
  if (inWindow) return 'T0';
  if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'T1';
  return 'Suspended';
}

export interface CapEvaluation {
  withinCap: boolean;
  tier: Tier;
  dailyCapCents: number;
  perTransferCapCents: number;
  todayUsedCents: number;
  todayRemainingCents: number;
  reason?: 'verification_required_after_window' | 'verification_rejected' | 'over_per_transfer_cap' | 'over_daily_cap';
  dayOfWindow?: number;
}

export function evaluateCap(
  customer: Customer,
  now: Date,
  todayUsedCents: number,
  requestedCents: number,
): CapEvaluation { ... }   // body in the implementation plan
```

`evaluateCap` is the only place caps are computed. Every enforcement point calls it.

## System-prompt addition

Appended to `SYSTEM_PROMPT`:

```
NEW-CUSTOMER ONBOARDING & SENDING LIMITS
- The system tells you when a turn involves a new customer or a tier
  reminder via these synthetic prefixes on the user's message:
    [NEW CUSTOMER]          — first inbound ever from this phone
    [TIER_REMINDER day N/3] — first message of a new conversation (24h+ gap) while still in the 3-day window
- For [NEW CUSTOMER]: greet warmly, explain "$500/day cap for your
  first 3 days while we verify you", call check_send_limit({amount_usd: 0})
  to get the kyc_url, share that URL, then ask "how much would you like to send?".
- For [TIER_REMINDER]: brief reminder of the day they're on + verification
  link, then continue normal flow.

- BEFORE you call get_quote, ALWAYS call check_send_limit with the
  amount the user requested. If within_cap is false, do NOT call
  get_quote. Instead reply explaining:
    over_per_transfer_cap → "You can send up to $X per transfer right now; want $X?"
    over_daily_cap        → "You have $X left of your $Y daily cap (already sent $Z today); want $X?"
    verification_required_after_window → "Your 3-day intro window has ended. Verify here: <kyc_url>"
    verification_rejected → "Your verification didn't succeed. Reply 'help' and a teammate will reach out."

- For Suspended users, never call get_quote / send_approve_picker /
  create_transfer. Just send the verification message.
```

## Migration + rollout

Backfill runs from the existing daily cron at `/api/cron/route.ts`. A `migration:customer-backfill-v1` sentinel makes it idempotent. A `?force=true` query parameter (gated by the existing `CRON_SECRET`) allows manual triggering immediately post-deploy so we don't wait until 13:00 UTC.

Webhook also lazy-backfills: `upsertOnFirstInbound` peeks at `store.listTransfers()` for any pre-existing transfers on the phone, and if found, creates the Customer as grandfathered with `firstSeenAt = oldest transfer.createdAt`. Two safety paths: whichever runs first wins; the sentinel keeps the cron run idempotent against the lazy backfills.

### Production verification (Task 14, B1)

- [ ] `/api/cron?force=true` returns OK with `backfilled N grandfathered customers` log line.
- [ ] `/dashboard/customers` lists every pre-existing sender, all `T1 grandfathered`.
- [ ] Send a WhatsApp message from a brand-new phone → bot greets with the $500/day message; customer page shows T0 day 1/3.
- [ ] Send a message from your existing test number → bot acts normally; customer page shows T1 grandfathered.
- [ ] Click `[Mark KYC verified]` on the brand-new customer in the dashboard → status flips, `updatedAt` advances.
- [ ] Even after marking verified, brand-new customer's cap stays $500/day until day 4 (observation invariant).
- [ ] Try to send $700 from the brand-new customer → bot replies with cap-exceeded text including the remaining-today figure.
- [ ] Playwright dashboard smoke still green and now also asserts `/dashboard/customers` renders.
- [ ] `/dashboard/transactions` shows tier badges in the new column.
- [ ] `npm test` count: ~264 → ~290+.

### Rollback

`vercel rollback` reverts the deploy. Customer records and migration sentinel stay in Redis (forward-compatible, harmless to the rolled-back code which doesn't read them). Re-deploy honors the sentinel and doesn't re-run the backfill.

## Reliability & error handling

| Concern | Mitigation |
|---|---|
| `customerStore.upsertOnFirstInbound` race (same sender, two concurrent inbounds within ms) | Reads first; if both reads see null, both writes set the SAME shape (same `firstSeenAt = oldest transfer.createdAt` from `listTransfers()`, or both see `now()` within the same ms). Last write wins; both `wasCreated = true`, so the bot may greet twice. WhatsApp serializes one user's messages so concurrent inbounds from same sender are vanishingly rare. Accept. |
| Redis transient unavailability on `check_send_limit` | Tool returns `{ error: 'Could not check limit right now. Please try again.', within_cap: false }`. Bot relays. `send_approve_picker` and `create_transfer` independently re-check — they'll also fail closed. No transfer escapes. |
| Redis unavailability on `dailyVolume.addCents` after a successful `createTransfer` | The transfer is already persisted. Log a warn. Sender's effective cap is incorrect (under-counted) until next inbound. We accept this as the cost of keeping the source of truth (transfer) and the counter independent. |
| Stale `daily_volume` from a previous day surviving past midnight | The key is per `easternDate`, so today's key is different from yesterday's. Yesterday's value is irrelevant. 48h TTL drops it eventually. |
| Bot ignores `check_send_limit` and calls `get_quote` anyway | `get_quote` is a pure quote — no money moves. `send_approve_picker` runs the cap check; over-cap returns an error. Defense in depth. |
| Bot tries `create_transfer` on a Suspended user | `create_transfer` runs `evaluateCap`; Suspended → `withinCap: false`. Returns error. No transfer created. |
| `dailyVolume` overflow on a malicious LLM passing huge amount | `INCRBY` is 64-bit signed; cents max ≈ 92 quadrillion dollars. Not a concern. |
| LLM forgets to call `check_send_limit` on `[NEW CUSTOMER]` turn | The greeting still works — but won't include the KYC URL. Bot can recover on next turn. Worst case is a slightly degraded first message. Not a money-safety issue. |
| Grandfather migration races a live new-customer inbound | `upsertOnFirstInbound` reads Customer first; if it exists, returns it. Backfill's `getCustomer !== null` check prevents overwrite. Both paths converge to the same record. |
| Customer record JSON corruption in Redis | `getCustomer` wraps `JSON.parse` in try/catch and returns `null` on parse failure → treated as new customer. Worst case: a sender's record is reset (T0). Logged. Recoverable manually. |

## Testing strategy

### New test files
- `tests/tier-rules.test.ts` — pure math. ~15 cases (T0/T1/Suspended transitions, all `reason` branches, boundary at exactly 3 days, exactly-at-cap, request 0 = status-only).
- `tests/customer-store.test.ts` — CRUD + idempotency + grandfather detection.
- `tests/daily-volume-store.test.ts` — round-trip, per-phone isolation, per-day isolation.
- `tests/kyc-provider.test.ts` — MockKycProvider.
- `tests/migration-backfill.test.ts` — backfill creates grandfathered records from existing transfers; sentinel guards against re-runs.

### Modified test files
- `tests/tools.test.ts` — `check_send_limit` cases, `send_approve_picker` cap-exceeded path, `create_transfer` daily-volume increment.
- `tests/agent.test.ts` — `[NEW CUSTOMER]` + `[TIER_REMINDER]` system-note injection.
- `tests/recipient-store.test.ts` — assert `daily_volume` also bumps in the existing `createTransfer side-effects` describe.
- `tests/e2e.test.ts` — new-customer end-to-end (greeted → over-cap → under-cap → approve → marked verified → day-4-graduation → T1 flow).
- `tests/e2e/dashboard-smoke.spec.ts` — navigate to `/dashboard/customers` and assert the table renders.

### Test count target
264 → ~290 (+25–30 new tests).

## Acceptance criteria

- [ ] Brand-new phone messaging the bot is greeted with the $500/day window message and a verification link.
- [ ] The same brand-new phone, asked to send $700, gets the cap-exceeded reply with the remaining-today figure.
- [ ] The same brand-new phone, sending $400, completes the flow including approve-button tap; `daily_volume:<phone>:<date>` is 40000.
- [ ] After sending $400, asking to send $200 more the same day gets cap-exceeded; asking for $100 succeeds.
- [ ] Mark-KYC-verified clicked in the dashboard mid-window does NOT lift the cap (still $500/day).
- [ ] On day 4 of a verified customer's life, tier transitions to T1 and per-transfer cap is $2,999.
- [ ] On day 4 of an unverified customer's life, tier is Suspended; all sending tools refuse.
- [ ] An existing pre-batch sender is grandfathered on backfill; their next message has no cap reminder; their tier is T1.
- [ ] `/dashboard/customers` lists every customer with correct tier badges.
- [ ] `/dashboard/customers/[phone]` shows the customer details and admin-only Mark-verified / Mark-rejected actions.
- [ ] `/dashboard/transactions` shows a tier badge in the new column for every row.
- [ ] Direct-pushing-to-main is rejected by branch protection; only PR merges deploy.
- [ ] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` all green.
- [ ] Playwright dashboard smoke (incl. new `/dashboard/customers` check) green against prod after deploy.

## Open questions

None. All locked in chat:
- Day-4 unverified → hard block (Suspended).
- KYC-verified-during-window → cap stays $500/day (observation invariant).
- KYC nudges: once on first-ever + once per new conversation in window.
- Cap window: per calendar day in sender's ET timezone.
- Cap check: both bot-pre-check via `check_send_limit` AND server enforcement at `send_approve_picker` + `create_transfer`.
- Mock KYC verification path: dashboard admin button on customer detail page.
- Dashboard surface: tier badge on transactions + new `/dashboard/customers` index + detail page.
- Existing senders: grandfathered via cron + lazy backfill.
- KYC provider for B2: Persona.
- 3-day window measured in milliseconds (72 hours) not calendar days.

## Risks

| Risk | Mitigation |
|---|---|
| Bot consistently fails to call `check_send_limit` and just calls `get_quote` | `send_approve_picker` and `create_transfer` both enforce — the worst case is wasted FX calls + a less informative reply. Money safety isn't compromised. |
| Backfill runs on a huge transfer list and times out the cron | We currently have <100 transfers. If we grow, the cron split makes sense (batch process). Document in the implementation plan that the v1 cron iterates synchronously and is fine at our scale. |
| Staff accidentally clicks Mark-verified on the wrong customer | Confirmation step in the UI before action runs. Audit trail is `kycVerifiedAt` + activity timeline; reversible via Mark-rejected (which sets Suspended). |
| Customer record diverges from the KYC provider's truth (post-B2) | B2's webhook handler is the authority; B1's mock path is overridden by B2 wiring. B1's dashboard action persists locally; B2 reconciles via `getStatus` on demand. |
| Tier transitions feel arbitrary to users ("Why am I capped today but not yesterday?") | The "day N/3" reminder in [TIER_REMINDER] makes the boundary visible. Day 4 transition (T0 → T1 or T0 → Suspended) is messaged via the next inbound's `[NEW CONVERSATION]` greeting. |

## Out of scope (reaffirmed)

- Real KYC provider (B2).
- Real sanctions screening (B3).
- Adaptive tiers (T2+) — defer until we have data.
- Per-customer override of caps — defer.
- Bulk operations / CSV export on the dashboard.
- Source-of-funds / EDD workflow (B5).
- Webhook receiver for KYC provider (B2).
- Customer-level annotations by staff.
