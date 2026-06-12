# SmartRemit — Complete System Architecture

> The single end-to-end reference for how SmartRemit works: every component, every API,
> every webhook, every configuration surface. Written 2026-06-11, after the
> total-platform program (PRs #53–#77). Production: **https://smartremit.ai**
> (Vercel alias `claude-payments.vercel.app` retained for old links).

---

## 1. What SmartRemit is

SmartRemit is **white-label, non-custodial remittance infrastructure**. End customers
send money home by chatting with an AI agent on WhatsApp; **partners** — the licensed
money transmitters — get that whole experience under their own brand: their WhatsApp
number, their settlement rail, their KYC posture, a REST API, and a self-service
dashboard.

The **non-custodial invariant** shapes everything: SmartRemit never holds, receives,
or disburses funds. When a customer pays, SmartRemit sends the partner's rail a
**signed settlement instruction**; the rail settles and reports status back via a
**signed webhook**. SmartRemit orchestrates — conversation, quoting, compliance
screening, KYC flows, payment links, monitoring — and mirrors the partner's status.

Two invariants are structurally untoggleable:
1. **Sanctions screening runs on every transfer**, in every KYC mode, for every
   partner. There is no flag anywhere that disables it.
2. **Tenant isolation is enforced in the query layer** — partner-scoped reads carry
   `partner_id` in the SQL WHERE; an out-of-scope id is indistinguishable from a
   missing one (404-never-403).

---

## 2. Tech stack

| Layer | Technology | Why |
|---|---|---|
| Framework | **Next.js 16** (App Router) | One codebase for pages, API routes, server actions; RSC |
| Hosting | **Vercel** (Fluid Compute) | Serverless with instance reuse; GitHub-driven deploys |
| Language | **TypeScript** end-to-end | |
| Ledger | **Neon Postgres** via **Drizzle ORM** on `drizzle-orm/neon-serverless` (WebSocket Pool) | Money paths need interactive transactions and `FOR UPDATE SKIP LOCKED`; the HTTP driver can't do either |
| Hot state | **Upstash Redis** (REST) | Sessions, conversations, OTPs, drafts, throttles, dedup, counters, FX cache |
| AI agent | **Ollama Cloud** running **Kimi K2.6** | The conversational brain; tool-calling chat loop |
| Chat channel | **Meta WhatsApp Cloud API** | Inbound webhooks + outbound sends/templates; per-partner BYO numbers |
| UI | **Tailwind CSS v4** + **shadcn/ui** (Radix) | One stylesheet pipeline (`src/app/tailwind.css`); the legacy hand-rolled CSS was fully retired |
| Charts | **Recharts** | Analytics dashboard |
| FX | **Frankfurter API** | Live USD/GBP/CAD/AED/SGD/AUD/NZD→INR rates, no key |
| KYC vendor | **Persona** (hosted flow + webhook) | When SmartRemit runs verification |
| Tests | **Vitest** (~122 files / ~1,315 tests) + **PGlite** (real in-process Postgres) + `fakeRedis` + **Playwright** (post-deploy smoke) | UNIQUE/SKIP LOCKED/transactions are tested against real Postgres semantics |
| CI/CD | GitHub Actions (`ci.yml` gate on PRs, `smoke.yml` post-deploy, `worker-heartbeat.yml` every 5 min) | Branch protection: no direct pushes to `main` |

---

## 3. Data layer

### 3.1 Postgres — the ledger (14 tables, `src/db/schema.ts`, migrations in `drizzle/`)

| Table | Purpose | Notable engineering |
|---|---|---|
| `partners` | Tenant records: name, countries, status, branding (displayName/color/logo/persona/supportContact), KYC posture (`kyc_mode`, `require_kyc_before_send`) | Migration 0001 seeds the `default` partner |
| `transfers` | THE money ledger | Status CHECK constraint; indexes `(partner_id, created_at)`, `(phone, created_at)`, `(status, paid_at)`; `payout_destination_enc` + `_last4`, `recipient_legal_name_enc` (encrypted at rest); `settlement_partner_id` (nullable routing carrier, §5.1) |
| `customers` | Sender records: phone (routing key, plaintext), tier anchors, KYC status, encrypted PII (`full_name/dob/address/gov_id` + last4 siblings) | `upsertOnFirstInbound` routes new customers to the partner owning the receiving number |
| `partner_integrations` | Per-partner technical config: WhatsApp creds, settlement rail selection + credentials, KYC vendor creds | All secrets envelope-encrypted; non-secret selectors (phoneNumberId, providerType) in the clear |
| `api_keys` | Partner API credentials | Only SHA-256(+pepper) hash at rest, UNIQUE index = O(1) auth; plaintext shown once at issue |
| `schedules` | Recurring transfers (weekly/monthly) | Fired by daily cron |
| `beneficiaries` | Partner-API stored beneficiaries | Payout destination encrypted |
| `recipients` | Chat-side saved recipients per sender | Encrypted destination; powers "send again to Mom" |
| `audit_events` | Append-only audit: staff actions, partner API calls, system events, **PII reveals** | `actor_type` ∈ staff/api_key/system |
| `idempotency_keys` | **PK `(partner_id, key)`** — the duplicate-window killer | Claim-first minting (see §6.3) |
| `kyc_cases` | KYC case records (state lives on `customers`; reserved) | |
| `corridor_requests` | Unsupported-corridor demand capture from chat | Platform-only lead list |
| `partner_rates` | Per-partner conversion pricing per corridor (best-rate selection, §5.1) | UNIQUE `(partner_id, source_currency, destination_currency)`; pair index for selection; plain numerics — rates are not PII (migration `drizzle/0002_partner_rates.sql`) |
| `outbox` | **The durability backbone** — every external effect | `dedupe_key` UNIQUE (where not null); drain partial index; see §7 |

### 3.2 Redis — hot/ephemeral keyspace (single shared client, `src/lib/redis.ts`)

| Keyspace | Purpose | TTL |
|---|---|---|
| `conv:{phone}` | Chat history (trimmed to 40 msgs) | 30d sliding |
| `recipient_draft:{id}` | Pay-link drafts (create-at-pay model) | 30 min, single-use |
| `session:*` / staff + `__Host-sr_session` customer sessions | Auth sessions | 12h customer ceiling |
| `otp:*` | Hashed OTP codes, per-purpose (`login`/`register`/`reset`) | 5 min, single-use, ≤5 wrong guesses |
| `velocity:{phone}:{date}` / daily + monthly volume counters | Caps & EDD accrual | Date-bucketed |
| `msg:{wamid}` | Inbound message dedup | 10 min |
| `lastmsg:{phone}` | 24h-window recency | 24h |
| `iprl:{scope}:{ip}:{window}` / `ratelimit:{partnerId}:{minute}` | Per-IP + per-partner rate limits | Self-evicting |
| `sr_otpip:*`, login-failure locks, pending-auth tokens | Brute-force throttles, 2FA binding | Hourly/daily buckets |
| `fx:{currency}` | Shared FX L2 cache | 5 min |

### 3.3 Encryption at rest (`src/lib/field-crypto.ts`)

AES-256-GCM **envelope encryption**: each value gets a random DEK, wrapped by the
master key (`FIELD_ENCRYPTION_KEY`, 32 bytes as hex64 or base64; set-once-never-rotate).
Encrypted: payout destinations, recipient legal names, customer PII, all integration
secrets. **Default ledger reads return the mask (`****last4`)**; decrypted reads are
explicit (`getTransferDecrypted`) and exist only where the full value is genuinely
needed (settlement instruction build, receipts, repeat-transfer hydration). Staff
reveals in the dashboard call an audited server action that writes a `pii.reveal`
row to `audit_events`.

---

## 4. The WhatsApp bot

### 4.1 Inbound pipeline (`src/lib/whatsapp-inbound.ts`)

```
Meta POST /api/whatsapp            (shared/default number)
     POST /api/whatsapp/[partnerId] (partner BYO number)
  → X-Hub-Signature-256 HMAC verify (fail-closed; partner's appSecret or env META_APP_SECRET)
  → status events (delivered/read/failed) → structured log, done
  → parseIncoming → markMessageSeen (Redis dedup)
  → STOP/START consent short-circuit (opt-out state suppresses the agent)
  → upsertOnFirstInbound(phone, routedPartnerId)   ← "follow the number": the customer
        belongs to the partner whose number they messaged
  → tier-reminder computation (3-day intro window)
  → enqueue outbox row 'agent.turn' (dedupe wamid:{id}) + pokeWorker()
```

The agent turn itself is a **durable outbox row** — a killed function or an Ollama
outage retries with backoff instead of eating the customer's message. The payload
carries `routedPartnerId`, never tokens; the worker re-resolves the partner's
WhatsApp credentials at run time.

### 4.2 The agent (`src/lib/agent.ts`, `prompt.ts`, `tools.ts`)

A tool-calling loop (max rounds) against Kimi K2.6:
- **System prompt** is built per-partner: `buildSystemPrompt({brand, botPersona,
  kycGateActive})`. The bot identifies as the partner's brand, never SmartRemit,
  when white-labeled. With the KYC gate off (the default), the prompt's onboarding
  section instructs immediate quoting and forbids verification talk.
- **Round-0 system notes** (not persisted): recent-transfers memory, sticky funding
  default, send-currency note (multi-corridor partners), `[NEW CUSTOMER]` /
  `[TIER_REMINDER]` / `[UNVERIFIED SENDER]` (gate-on only).
- **Tools** (the only way the bot acts): `check_send_limit`, `get_quote`,
  `list_saved_recipients`, `send_recipient_picker` (interactive buttons),
  `send_approve_picker` (the Approve & Pay card), `create_transfer` /
  draft creation, `generate_payment_link`, `check_payment_status`,
  `update_recipient_phone`, `cancel_draft`, `repeat_transfer`, schedule tools,
  corridor-request capture. Every money-adjacent tool re-checks caps, the KYC gate,
  and sanctions server-side — the model can never bypass policy.
- **Quote math** (`fx.ts`, `rate.ts`): live Frankfurter rates (5-min L1 memory +
  Redis L2), fee tiers (first transfer free, then $1.99), USD-equivalent accounting
  for caps in any send currency.
- **Bank details are never collected in chat** (WhatsApp policy + PII): the bot
  collects recipient name/phone/amount; account numbers are entered on the secure
  pay page.

### 4.3 Multi-tenant WhatsApp

Each partner can bring their own Meta number: they save `phoneNumberId`, access
token, verify token, and app secret on their dashboard WhatsApp tab; Meta's webhook
is pointed at `https://smartremit.ai/api/whatsapp/{partnerId}`. Inbound routing
resolves the partner from the integrations row (`partnerForPhoneNumberId`); every
outbound reply, OTP, and notification leaves from the number the customer messaged.
Unconfigured partners share the platform number.

---

## 5. Customer-facing money flow (end to end)

```
1. Customer: "send $200 to mom"           (WhatsApp)
2. Agent: cap check → live quote → Approve & Pay card
3. Approve → DRAFT created in Redis (30-min TTL) → secure pay link sent
4. Pay page (https://smartremit.ai/pay/{id}, WhatsApp-dark theme):
     a. collect bank details (validated per destination country)
     b. per-transaction OTP — code sent in the WhatsApp chat, verified server-side
     c. POST /api/pay/{id}
5. finalizeDraftPayment — CLAIM-FIRST: transfer id bound to idempotency key
   `draft:{draftId}` BEFORE minting; draft consumed AFTER. A crash-replay or
   double-click converges on the same transfer; the pay link can never die mid-pay.
   createTransfer runs sanctions screening + EDD + accruals.
6. beginSettlement() — ONE Postgres transaction commits together:
     • status flip awaiting_payment → paid (atomic claim; replays no-op)
     • outbox: customer's "payment received" WhatsApp message (dedupe stage1:{id})
     • outbox: the rail effect —
         http/simulator → signed settlement.instruct (dedupe instruct:{id})
         mock          → delayed mock.settle (the 2-min sandbox lag)
7. Worker delivers the instruction → partner rail settles → partner POSTs signed
   status webhook → forward-only state machine → delivered → branded WhatsApp
   delivery notifications (sender text + recipient template).
```

Compliance outcomes branch at step 5/6: a watchlist hit records a `blocked` row
(never charged, auditable); a `flagged` transfer charges but holds as `in_review`
for staff release/reject.

### 5.1 Partner best-rate selection (settlement routing)

When a default-tenant customer asks for a quote, partners **compete on the FX
rate**: the corridor goes to whichever eligible partner offers the customer
strictly more destination units per source unit than the platform mid-market
rate — and that partner's rail settles the transfer. Zero competitors means
today's behavior byte-for-byte: mid-market rate, settled via the customer's own
partner. Files: `src/lib/partner-rates.ts` (selection service),
`src/db/repos/partner-rate-repo.ts` (repo), `drizzle/0002_partner_rates.sql`
(schema).

**Hybrid rate source.** A partner prices a corridor either way, or both:
- **Pushed rate with TTL** — `PUT /api/partner/v1/rates` writes
  `effective_rate` + `expires_at` + `pushed_at`; the rate competes only while
  fresh (`expiresAt` in the future).
- **Standing margin** — staff set a signed `margin_bps` on the partner's
  Pricing tab; the effective rate is `mid × (1 + marginBps/10 000)` (positive ⇒
  better for the customer).

The upsert has merge semantics (`upsertRate`): a push updates only the pushed
fields, a margin save updates only `margin_bps` — the two sources never clobber
each other. A fresh push takes precedence; an expired push falls back to the
margin, if any.

**Eligibility** (all required, judged at quote time by `selectSettlementRoute`):
- partner row **active** (enforced in the repo's candidate join),
- **not the `default` partner** — it *is* the platform baseline,
- a fresh pushed rate **or** a standing margin,
- a **usable rail**: `payment.providerType` is `http` or `simulator` **and**
  `credentials.settlementUrl` is non-empty — anything else would dead-letter
  money in `paid`, so it is filtered out before winning.

**The platform mid-market rate is always the baseline competitor**, and the
winner must be **strictly better** than mid — ties go to the platform.
Contenders are ranked best-rate-first; integrations are checked only for
provisional winners, so the hot quote path is one indexed query plus at most a
couple of integrations reads. Selection is an optimization, never a blocker: a
rates-query failure falls back to the platform rate rather than taking quoting
down.

**Routing carrier.** The winner is stamped on the ledger as
`transfers.settlement_partner_id` (`null` = settle via the owning partner). The
split is strict:
- **Rail side** follows `settlementPartnerId ?? partnerId` — settlement
  instruction target, signing/webhook secrets, provider type.
- **Brand side** always follows `partnerId` — WhatsApp number, branding,
  receipts, the customer relationship.

**Scope rules:**
- **Only default-tenant customers compete.** White-label customers are pinned
  to their partner — that partner is the transmitter of record, and routing
  their volume elsewhere would break the regulatory premise. Callers gate on
  the tenant *before* calling the selector.
- **Customers never see the routing** — they see a rate and a quote, nothing
  about which rail settles.
- **Scheduled/cron sends intentionally don't route** — recurring transfers
  stay on the owning partner's rail for predictability.

**Operations.** The worker's staleness sweep (`listExpired`) flags pushed rates
whose TTL has lapsed and alerts ops — a partner that stops pushing silently
drops out of competition rather than competing on a stale price. Admin
surfaces: the per-partner **Pricing tab** (that partner's rate sheet + margin)
and the platform-only **`/admin-dashboard/rates`** page (every partner's rates,
freshness, and corridor coverage in one view).

---

## 6. API surface (every route)

### 6.1 Public/customer

| Route | Auth | Purpose |
|---|---|---|
| `GET/POST /api/whatsapp` | Meta HMAC (X-Hub-Signature-256, fail-closed) + GET verify-token challenge | Shared-number webhook |
| `GET/POST /api/whatsapp/[partnerId]` | Partner's own appSecret HMAC | BYO-number webhook |
| `POST /api/pay/[transferId]` | Per-transaction WhatsApp OTP + per-IP rate limit (30/min) | Two-step payment: `request_otp` action, then bank-details + code + pay |
| `POST /api/persona-webhook` | Persona signature | KYC verdicts from the hosted Persona flow |

### 6.2 Partner API (`/api/partner/v1/*`)

Auth: `Authorization: Bearer <key>` — hash lookup binds the request to one partner;
the key is the **sole** source of tenancy (body/path partner ids are never trusted).
Rate limit 120 req/min/partner. All responses JSON; errors `{error}`.

| Endpoint | Purpose |
|---|---|
| `GET /corridors` | Partner's enabled send corridors + brand |
| `GET /rates` | The partner's own rate sheet (pushed rates + margins, freshness) |
| `PUT /rates` | Push corridor rates with a TTL — the partner's bid in best-rate selection (§5.1) |
| `POST /quote` | Price a transfer |
| `POST /beneficiaries/validate` | Stateless payout-field validation per country |
| `POST /beneficiaries` | Store a beneficiary (destination encrypted) |
| `POST /transactions` | Mint a transfer — `Idempotency-Key` header REQUIRED; claim-first: concurrent duplicates and crash-replays converge on one row |
| `GET /transactions` | Keyset-paginated list (`?limit=&cursor=`), newest-first |
| `GET /transactions/:id` | Ownership-scoped read (404-never-403) |
| `POST /transactions/:id/confirm` | Partner attests funds captured → `beginSettlement` |

### 6.3 Settlement loop

| Route | Direction | Auth |
|---|---|---|
| (worker → partner) `POST {settlementUrl}` | SmartRemit → rail | `x-signature` = HMAC-SHA256(raw body, partner's signingSecret); retried with backoff until 2xx; partner may return `{providerRef}` (stored write-once) |
| `POST /api/payment-webhook/[provider]` | rail → SmartRemit | `x-signature` HMAC with the partner's webhookSecret (resolved from the referenced transfer; fail-closed). Status mapping: `created`→awaiting, `funded`→paid, `paid_out`→delivered. Forward-only, race-safe single UPDATE. 600/min IP ceiling |
| `POST /api/partner-rail` | the **hosted reference rail** | Verifies the platform's signed instruction like a real rail, acks a providerRef, then (12s later, via outbox) POSTs the signed `paid_out` callback through the public webhook — the full production loop with zero partner code |

### 6.4 Platform internals

| Route | Auth | Purpose |
|---|---|---|
| `GET/POST /api/worker` | `Bearer CRON_SECRET` | Drains the outbox (45s budget) + runs the reconciliation sweep |
| `GET /api/cron` | `Bearer CRON_SECRET` | Daily: fires due recurring schedules (skips unverified owners when the partner's gate is on) |
| `GET /api/dashboard/summary` | Staff session cookie | The light polling target: one SQL aggregate + change-stamp |

---

## 7. Durability engine (no lost money states, ever)

**Outbox pattern**: every external effect — WhatsApp text/template, settlement
instruction, rail callback, mock settle, agent turn, ops alert — is a row written
**in the same transaction** as the state change implying it. Effects are
**dedupe-keyed** (`stage1:{id}`, `instruct:{id}`, `wamid:{id}`, …) so at-least-once
delivery can never double-send.

**Worker** (`/api/worker` → `drainOnce`): claims batches via
`FOR UPDATE SKIP LOCKED` (concurrent drains are safe by construction), executes by
kind, exponential backoff `2^attempts` (cap 1h), **dead at 8 attempts** → exactly one
deduped WhatsApp ops alert to `OPS_ALERT_PHONE`.

**Delivery guarantee**: a GitHub Actions heartbeat hits the worker every 5 minutes;
`pokeWorker()` (a best-effort `after()` fetch) makes the common case drain in seconds.

**Reconciliation sweep** (every worker run): transfers stuck in `paid` >15 min →
re-instruct the rail once (deduped) + ops alert; `in_review` >24h → ops alert.
`getOpsSnapshot()` feeds the Operations page.

**Transactional money paths**: `beginSettlement` (§5 step 6) and claim-first minting
(idempotency key bound to a pre-generated transfer id BEFORE insert, in both the
partner API and pay-link finalize) close every crash window the durability audit
found: "customer told paid but rail never instructed", "crash kills the pay link",
"duplicate transfer on retry", and "killed function eats a message" are all
structurally impossible now.

---

## 8. Security architecture

| Control | Implementation |
|---|---|
| Production boot assert | `src/instrumentation.ts` + `boot-assert.ts`: prod refuses to serve with missing/empty `DATABASE_URL`, KV pair, `FIELD_ENCRYPTION_KEY` (shape-checked: hex64 OR base64-32 — must mirror the accepting code), `PASSWORD_PEPPER`, `CRON_SECRET`, `META_APP_SECRET`, `OPS_ALERT_PHONE` |
| Headers | HSTS (2y preload), nosniff, X-Frame DENY, Referrer-Policy, Permissions-Policy, **enforced CSP** (default/connect/img/font `'self'`, frame-ancestors `'none'`, base-uri/form-action locked; script-src nonce hardening is the named follow-up) |
| Middleware | `/admin-dashboard/*` gated on the staff session cookie; `/account/*` on the customer `__Host-` cookie (auth entry pages public) |
| Rate limits | Per-IP fixed window (fail-open: a limiter outage never blocks payments): pay 30/min, rail 120/min, payment webhooks 600/min; per-partner API 120/min; OTP per-number 5/h + 10/day + 30s cooldown; per-IP OTP 20/h; login lockouts per-phone/day + per-IP/h |
| Server actions | Every action self-gates (`require*`), validates existence + scope before mutating, treats route params as authoritative over body fields |
| Customer auth (AAL2) | Argon2id + pepper passwords, pwned-password check, enumeration-safe login/reset, **two-factor binding**: sessions minted only by OTP verify consuming a single-use pending-auth token whose phone comes from the token, never the form |
| OTP store | Crypto RNG codes, only SHA-256 hashes at rest under opaque purpose-namespaced keys, constant-time compare, burn after 5 wrong guesses, daily fail lock |
| PII logging | `src/lib/log.ts` scrubber on all money-path logs (emails out; 7+-digit runs → last-4; codes never logged at all) |
| KYC gate | **Partner opt-in** (`requireKycBeforeSend`); `kycMode` picks who verifies (SmartRemit/Persona vs partner attestation). Sanctions screening independent and always-on |
| Audit | Append-only `audit_events`: staff mutations, partner API calls, ops actions, PII reveals |

---

## 9. Admin dashboard (`/admin-dashboard`, staff login at `/login`)

Stripe-class shadcn UI; grouped sidebar IA: **Overview · Operations** | **Money**
(Transactions, Schedules) | **People** (Customers, KYC, Compliance) | **Insights**
(Analytics) | **Platform** (Partners, Corridors, Team, API keys).

Roles & scoping: platform admin (everything), platform agent (no Team/API-keys),
**partner-scoped staff** — pinned to their tenant at the query layer; their sidebar
swaps the Platform group for "My partner"; visiting other tenants' resources 404s.

| Page | What it does | Data source |
|---|---|---|
| Overview | Today's commission/volume/count/flagged metric cards, needs-attention banner, recent 5, next due schedules | One SQL aggregate (`summary()`, eastern-day in Postgres) + keyset recents |
| **Operations** (platform) | The money-state safety surface: pending outbox, **dead letters with audited Retry/Dismiss**, stuck-paid, stale reviews | `getOpsSnapshot()` |
| Transactions | 100-row keyset window (Older/Newest cursors), search, partner filter, status tabs, tier/KYC badges, masked accounts with **audited reveal**, assign/cancel/resend actions | `transfersPage()` + per-phone indexed reads |
| Schedules | Recurring transfers, due-soon panel | |
| Customers | List + per-customer detail: tier/cap card, KYC review (approve/reject with reasons), audit trail, recent transfers | Indexed per-phone queries |
| Compliance | In-review queue (release/reject), flagged, blocked/watchlist, today's velocity leaderboard, per-corridor rule matrix | Four indexed queries (`complianceViews()`) |
| KYC | Status-tile metrics + needs-review queue | |
| Analytics | §11 | |
| Partners | Tenant list → **6-step setup wizard** + **tabbed detail** (§10) | |
| Corridors (platform-only) | Cross-tenant demand leads | Bounded 200 |
| Team (platform admin) | Staff CRUD, roles, partner scope, permission flags, audit log | |
| API keys (platform admin) | Every partner's keys: last-4 + status, issue (show-once)/revoke | |

**Live updates**: `LiveRefresh` polls `/api/dashboard/summary` every 5s and
re-renders **only when the change-stamp moves** (per-status counts + latest
timestamp), with a 60s safety refresh — one tiny SQL per viewer per tick instead of
full-page re-renders.

---

## 10. Partner experience

**Onboarding wizard** (`/admin-dashboard/partners/new`, platform admin): Identity →
Brand → KYC → WhatsApp → Settlement → Review. All state client-side; **nothing
persists until the final commit** (one server action creates the partner, saves
integrations, and issues the first API key). Selecting the hosted reference rail
auto-provisions its endpoint + both HMAC secrets. The done screen is the go-live
checklist: show-once API key, Meta callback URL, status-callback URL, API base.

**Partner detail** (`/admin-dashboard/partners/[id]`) — seven tabs:
- **Overview**: lifetime activity (SQL aggregates) + recent transfers
- **Settings**: identity, countries, branding (display name, color, logo, bot
  persona, support contact), **KYC posture** (who verifies + the opt-in
  verify-before-send checkbox)
- **WhatsApp**: BYO number config (write-only secrets, configured-state badges) +
  the partner's Meta callback URL
- **Settlement**: provider (mock / simulator / http), settlement URL, signing +
  webhook secrets (write-only)
- **API keys**: issue (show-once) / revoke
- **Staff**: partner-scoped staff CRUD
- **Integration**: the technical handoff — all URLs, signature recipes, payload
  shapes, curl examples

**Public docs hub** (`/docs`): the partner integration guide — mirrors the
implementation (API, signed instruction payload, webhook recipe + status mapping,
reference rail, BYO WhatsApp, KYC modes).

---

## 11. Analytics

`/admin-dashboard/analytics`: 7d/30d/90d window toggle (URL param); metric tiles +
seven Recharts charts (volume over time, transfer counts, fee revenue, corridor
mix, funding mix, status distribution, top recipients). Aggregation is computed
server-side per render from the scoped transfer set; the page re-renders only when
the live-refresh stamp moves. (Known follow-up: push the windowed aggregations into
SQL GROUP BYs like the overview's `summary()` — queued, non-blocking.)

---

## 12. Webhooks — complete inventory

**Inbound (others → SmartRemit):**

| Webhook | Sender | Verification |
|---|---|---|
| `POST /api/whatsapp` + `GET` verify | Meta (shared number) | `X-Hub-Signature-256` HMAC w/ `META_APP_SECRET` (fail-closed) + verify-token challenge |
| `POST /api/whatsapp/[partnerId]` + `GET` | Meta (partner number) | Partner's own `appSecret` / `verifyToken` |
| `POST /api/payment-webhook/[provider]` | Partner rail (or reference rail) | `x-signature` HMAC-SHA256(raw body, partner `webhookSecret`) — fail-closed, forward-only state machine, replay/out-of-order safe |
| `POST /api/persona-webhook` | Persona (KYC verdicts) | Persona webhook signature |

**Outbound (SmartRemit → others):**

| Call | Target | Signature |
|---|---|---|
| Settlement instruction | partner `settlementUrl` | `x-signature` HMAC-SHA256(raw body, `signingSecret`); at-least-once w/ retries; `reference` = transfer id for partner-side dedup |
| Reference-rail status callback | our own `/api/payment-webhook/simulator` | signed with the partner's `webhookSecret` — exercising the exact inbound path |
| Meta Graph sends | WhatsApp Cloud API | Bearer token (platform or partner) |

**Heartbeats:** GitHub Actions → `/api/worker` (5-min, Bearer `CRON_SECRET`);
Vercel cron → `/api/cron` (daily schedules).

---

## 13. Configuration reference (environment)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres (pooled) |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis |
| `FIELD_ENCRYPTION_KEY` | 32-byte master key (hex64 or base64) — **set once, never rotate** |
| `PASSWORD_PEPPER` | Argon2id pepper — **set once, never rotate** |
| `CRON_SECRET` | Worker + cron bearer auth |
| `META_APP_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` | Platform WhatsApp number |
| `WHATSAPP_AUTH_TEMPLATE` (default `verification_code`) | Meta AUTHENTICATION template for portal OTPs |
| `WHATSAPP_VERIFICATION_{NEEDED,IN_PROGRESS,VERIFIED,FAILED}_TEMPLATE` | KYC status templates (free-form fallback until approved) |
| `OPS_ALERT_PHONE` | Stuck-money / dead-letter WhatsApp alerts |
| `OLLAMA_BASE_URL` / `OLLAMA_API_KEY` / `OLLAMA_MODEL` | The agent LLM |
| `PERSONA_API_KEY` / `PERSONA_WEBHOOK_SECRET` / template + env ids | Hosted KYC |
| `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` | First staff admin (seeds only when staff list empty) |
| `APP_BASE_URL` | Public base URL (set to `https://smartremit.ai`; self-derives on Vercel otherwise) |
| `PAYMENT_WEBHOOK_SECRET_<PROVIDER>` | Global per-provider webhook fallback secrets |
| `OTP_DEV_MODE` | Local/CI only — logs "code ready", never sends |

Production **refuses to boot** if the money-grade subset is missing (§8).

---

## 14. Delivery pipeline & verification

1. **PR-only** to `main` (branch protection requires the `ci / ci` check: full
   Vitest suite + tsc + eslint `--max-warnings 0` + `next build`).
2. Merge → Vercel auto-deploys production.
3. **Post-deploy Playwright smoke** (`smoke.yml`) runs against the live site:
   landing render + WhatsApp CTAs, staff login, every dashboard page, customers
   table contract, partner creation via the real wizard (self-provisioning
   fixtures), partner-scoped staff isolation. **Check it after every merge.**
4. Unit/integration: PGlite gives real Postgres semantics in-process (transactions,
   UNIQUE races, SKIP LOCKED); `fakeRedis` covers the hot path; durability proofs
   include crash-replay convergence, concurrent webhook races, outbox
   retry→dead→alert, and sweep dedup.

---

## 15. Known follow-ups (tracked, non-blocking)

- Analytics/customers-list/partners-list windowed aggregations → SQL GROUP BYs.
- Nonce-based CSP `script-src`.
- Meta template approvals (AUTHENTICATION `verification_code`, rebuilt
  `transfer_delivered_v2`, `scheduled_payment_ready`, verification-status family) +
  the lockstep param swap once approved.
- Real WhatsApp number + Meta Business Verification to leave sandbox limits.
- PGlite test-pool tuning (rare parallel-run flakes; always pass isolated).
- Customer self-service portal expansion (recipients, schedules, profile/security).
