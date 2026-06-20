# SmartRemit — Platform Overview (Client Presentation)

White‑label, non‑custodial remittance **infrastructure**. Customers send money home by chatting with an AI agent in WhatsApp; licensed partners get a branded product, a REST API, signed settlement webhooks, and a self‑service dashboard. SmartRemit orchestrates the conversation, quoting, compliance, KYC, and instructions — and **never holds funds**.

---

## 1. What SmartRemit is

- **A remittance platform you white‑label**, not a wallet. Your customers chat in WhatsApp; you stay the licensed money transmitter of record.
- **Non‑custodial by design** — SmartRemit never touches, holds, or routes money. It produces *signed instructions*; settlement happens on the partner's licensed rails.
- **Conversational‑first** — there is no app to install. The entire send flow happens in a WhatsApp chat with an AI agent, finished on a secure hosted pay page.
- **Multi‑corridor** — sends from US, Canada, UK, UAE, Singapore, Australia, New Zealand; pay out to India today, architected for any‑to‑any corridors.
- **Multi‑tenant** — one platform serves many partners, each fully isolated with its own brand, number, rails, rates, and dashboard.
- **Compliance is built in, not bolted on** — sanctions screening always runs; KYC, transaction limits, velocity, and enhanced due diligence are first‑class.
- **Production‑grade reliability** — every external effect is durable and retried; money paths are transactional and idempotent; nothing is silently lost.

**The stack:** Next.js 16 (App Router) on Vercel · TypeScript · Neon Postgres (the ledger, via Drizzle ORM) · Upstash Redis (hot/ephemeral) · Kimi K2.6 on Ollama Cloud (the agent) · Meta WhatsApp Cloud API · ~140 automated test files / ~1,665 tests.

---

## 2. Who it's for & the value proposition

**For partners (licensed money transmitters / fintechs):**
- A turnkey, **branded** WhatsApp remittance product — your name, logo, color, number.
- **You keep the license and the funds flow**; we orchestrate everything around the money.
- A **REST API** + **signed settlement webhooks** to plug into your existing payout rails.
- A **self‑service dashboard** for ops, compliance, KYC review, analytics, and pricing.
- **Compliance orchestration** (sanctions always on; KYC you can run or delegate) so you launch faster.
- **Best‑rate routing** — you can compete for volume by pushing wholesale FX rates.

**For end customers (the sender):**
- Send money by **chatting** — no app, no forms until the final secure page.
- **Live FX**, transparent fees, a locked quote, and a one‑tap secure payment link.
- **WhatsApp notifications** to both sender and recipient when money is delivered.
- A **self‑service portal** for history, receipts, repeat sends, refunds, and support.

---

## 3. Use cases (every flow the platform supports)

**Customer‑facing (in WhatsApp or the web portal):**
- **Send money** — first‑time send: amount → recipient name + number + destination → bank details on the secure page → pay → delivered.
- **Receive‑first quoting** — "I want them to get exactly ₹50,000" — the agent back‑solves the send amount.
- **Repeat a transfer** — re‑send to a previous recipient, reusing payout details and amount.
- **Saved recipients** — pick a recent recipient from interactive buttons instead of re‑typing.
- **Schedule recurring transfers** — weekly/monthly auto‑reminders with a ready‑to‑pay link.
- **Check status** — "where's my transfer?" returns awaiting / paid / delivered.
- **Request a refund** — for a paid‑but‑not‑delivered transfer; routed to ops (no money moves from chat).
- **Correct a recipient number** on an existing transfer.
- **KYC / identity verification** — guided hosted flow when verification is required.
- **Unsupported‑corridor capture** — if a destination isn't supported yet, the lead is saved.
- **Support tickets** — open and track support requests from the portal.
- **Account portal** — password login, transfer history, locked receipts, embedded chat.

**Partner / operator‑facing (dashboard + API):**
- **Onboard a partner** via a 6‑step wizard (identity, brand, KYC posture, WhatsApp, settlement rail, review).
- **Create transfers programmatically** through the REST API (quote → create → confirm → status).
- **Push wholesale FX rates** or set margins to win best‑rate routing.
- **Review compliance** — flagged/blocked transfers, release or reject with auto‑refund.
- **Review KYC cases** — approve/reject identity verifications (human‑only decision).
- **Operate the money** — stuck‑payment recovery, refund queue, reconciliation alerts.
- **Manage team** — platform admins vs. partner‑scoped staff (pinned to their tenant).
- **Analytics** — corridor volume, FX margin, payment‑method split.

---

## 4. How a transfer works — end to end

A first‑time **US → India** send, step by step:

1. **Inbound message** — the customer messages the WhatsApp number. The webhook is **signature‑verified (fail‑closed)**, the message is **de‑duplicated**, and the turn is enqueued as a durable outbox row.
2. **The AI agent runs** — Kimi K2.6 reads the conversation, calls tools (quote, validate phone, etc.), and replies. It guides: amount → recipient name + number → destination country.
3. **Live quote** — the agent fetches **live FX** (Frankfurter, cross‑rate via a USD pivot), applies the fee, and — for the platform tenant — runs **best‑rate routing** to see if a partner offers a better wholesale rate. The customer only ever sees the better rate.
4. **Approve & Pay card** — the agent locks the quote and sends a one‑tap **"Approve & Pay"** button with a secure link. (A content‑keyed guard ensures the link is sent exactly once, even on retries.)
5. **Secure pay page** — the customer opens the branded `/pay/<id>` page, enters payout details (UPI / bank account), passes an **OTP step‑up**, and pays. Funds are captured **before** any ledger mutation.
6. **Compliance gate at payment** — *blocked* → no charge; *flagged* → charged but **held for review**; *cleared* → proceeds to settlement.
7. **Settlement (atomic)** — in one database transaction the transfer flips to **paid**, a "payment received" message is queued, and a **signed settlement instruction** (HMAC‑SHA256) is queued for the partner's rail.
8. **The signed rail loop** — the platform POSTs the signed instruction to the partner's endpoint; the partner pays out and POSTs back a **signed `paid_out` callback** (verified fail‑closed). The transfer flips to **delivered**.
9. **Notifications** — the **sender** gets a delivery confirmation; the **recipient** gets a `transfer_delivered` WhatsApp message (template‑first, with a free‑form text fallback so a rejected template still reaches them).

**What's real vs. simulated (honest framing for partners):**
- **Real, production‑grade:** the AI conversation, live FX, sanctions/compliance screening, the **signed instruction → signed callback loop (HMAC both ways, fail‑closed)**, the durable outbox, and all WhatsApp notifications.
- **Provided by the partner in production:** the actual sender funding (a PSP/card processor) and the recipient payout (the partner's licensed rails). SmartRemit **never custodies funds**.
- **Built‑in simulator rail:** a hosted reference rail runs the *exact* production signed loop end‑to‑end, so you can test and demo the full flow before wiring your real rail.

---

## 5. Partner configuration — how white‑labeling works

**The 6‑step onboarding wizard** (nothing persists until "Create"):
1. **Identity** — partner name + **operating countries** (the source corridors this partner serves).
2. **Brand** — display name, support contact, primary color, **logo (direct upload)**, bot persona/tone.
3. **KYC posture** — who runs identity verification (see below) + an opt‑in "require verification before sending" gate.
4. **WhatsApp** — bring your own Meta number (phone number ID + token + secrets), or fall back to the shared number.
5. **Settlement rail** — choose `simulator` (auto‑provisioned reference rail), `http` (your live endpoint), or `mock` (sandbox).
6. **Review & create** — provisions the partner row, encrypted integration secrets, and a **first API key** (shown once).

**Branding (white‑label):** display name, brand name, primary color, **uploaded logo**, support contact, and a bot‑persona tone hint — applied to the pay page, notifications, and the agent's voice. The default tenant stays byte‑for‑byte "SmartRemit."

**KYC modes:**
- **`ours`** — SmartRemit runs identity verification via a hosted **Persona** flow.
- **`delegated`** — the partner (the licensed entity) runs KYC on their side; our verify‑gate steps aside.
- **In both modes, sanctions screening always runs** — it is structurally impossible to toggle off.

**Settlement rails:**
- **`simulator`** — a hosted reference rail at `/api/partner-rail`; auto‑provisions the endpoint + both HMAC secrets. Runs the real signed round‑trip with zero setup.
- **`http`** — the partner's real endpoint; the partner provides the URL + signing/webhook secrets.
- **`mock`** — auto‑delivers after a delay; sandbox only.

**The partner REST API** (`/api/partner/v1/*`, Bearer API‑key auth, tenant is always taken from the key):
- `POST /quote` — FX + fee quote (no persistence).
- `POST /transactions` — create a transfer (**Idempotency‑Key required**; claim‑first minting).
- `GET /transactions` / `GET /transactions/:id` — list (keyset‑paged) / fetch (404‑never‑403).
- `POST /transactions/:id/confirm` — drive settlement (flip to paid + signed instruction).
- `GET /corridors` — discover the partner's configured corridors.
- `PUT /rates` / `GET /rates` — push a wholesale rate (with TTL) / list own rates.
- `POST /beneficiaries` + validation — store/validate recipients.

**Signed settlement webhooks:** instructions out and callbacks in are both **HMAC‑SHA256 signed and fail‑closed** (constant‑time comparison; missing/invalid signature → 401). Routed transfers verify with the *settlement* partner's secret but notify under the *owning* partner's brand.

**Best‑rate / partner rates:** a partner competes by pushing a **fresh wholesale rate** (with a TTL) or setting a **standing margin**. The selection engine routes a quote to the partner who is **strictly better than mid‑market** *and* has a routable rail — otherwise it settles at the platform mid via the customer's own partner. The customer only ever sees the better rate; routing is internal.

**Tenant isolation:** every partner‑scoped query is filtered by `partnerId`; ownership checks are **404‑never‑403** (no enumeration); partner‑scoped staff are **pinned to their tenant** and can only see their own partner; suspending a partner revokes its staff sessions immediately.

**Bring‑your‑own WhatsApp number:** a partner's inbound traffic routes by Meta phone‑number‑ID to their tenant, and outbound messages send from their own number/token — so customers see the partner's brand throughout.

---

## 6. How transactions work

**The transfer state machine:**
- `awaiting_payment` → `paid` → `delivered` (the happy path)
- `in_review` — a flagged transfer is charged but held for manual compliance review
- `cancelled` — rejected by an operator, auto‑refunded if charged
- `blocked` — a sanctions hit; **the transfer never mints / is never charged**
- **Refund track (orthogonal):** `none → requested → pending → completed` (or `failed`)

**Durability (the outbox pattern):** every external effect — WhatsApp sends, settlement instructions, rail callbacks, agent turns, ops alerts — is written as an **outbox row in the same database transaction** as the state change that implies it. A worker drains it with **`FOR UPDATE SKIP LOCKED`** (safe under concurrency), retries with **exponential backoff**, and **dead‑letters after 8 attempts → a deduplicated ops alert**. A 5‑minute heartbeat is the delivery guarantee; a fast‑path "poke" keeps it snappy. Effect kinds include: `agent.turn`, `whatsapp.text`, `whatsapp.template`, `settlement.instruct`, `rail.callback`, `mock.settle`, `funding.refund`, `ops.alert`.

**Correctness guarantees:**
- **Claim‑first minting** — the transfer id is bound to the idempotency key **before** the row is inserted, so a crash‑replay re‑mints the *same* transfer rather than a duplicate.
- **FX locked at quote time** — the rate the customer approved is the rate that settles; it never silently re‑prices.
- **Guarded, atomic transitions** — the paid‑flip and the settlement effect commit together; the webhook status update is a single rank‑guarded atomic UPDATE (concurrent callbacks can't double‑advance).

**FX:** live mid‑market rates from Frankfurter (keyless), cached two layers deep (in‑memory + shared Redis, 5‑minute freshness), with a USD‑pivot cross‑rate for any‑to‑any corridors and conservative offline fallbacks.

**Refunds:** the customer requests a refund in chat (only valid for a paid, not‑yet‑delivered transfer); an operator approves; a durable `funding.refund` effect issues it and notifies the customer. Stuck refunds raise an ops alert.

**Scheduled / recurring transfers:** weekly/monthly schedules trigger a cron that creates a ready‑to‑pay transfer and sends the customer a payment link (gated by KYC if required).

**Reconciliation (self‑healing):** a sweep catches stuck states and alerts ops within fixed windows — paid‑but‑not‑settled > 15 min (re‑instructed once), charged‑but‑not‑settled > 10 min (settlement resumed), reviews open > 24 h, refunds pending > 60 min.

---

## 7. How fraud detection & compliance work

**Sanctions screening — always on, untoggleable:**
- Runs on **every transfer, in both KYC modes** — there is no switch anywhere in the system.
- Screens the **recipient** (and the **sender** when a legal name is present) against a watchlist, with a **pluggable provider seam** (production swaps in a commercial sanctions provider; per‑corridor watchlist extensions are supported).
- A hit → the transfer is **blocked**: it never mints, is never charged, and the attempt is **audited** (without inflating velocity/volume counters).

**KYC (identity verification):**
- **`ours` mode** uses a hosted **Persona** flow; **`delegated` mode** lets the partner run KYC.
- **Verification is human‑approved only** — a strict invariant: identity webhooks move a *review state*, but only a **human operator** can set a customer to `verified` or `rejected`. A late or out‑of‑order webhook can never override a human decision or auto‑approve.
- An **opt‑in "require verification before sending"** gate blocks sends until verified (when a partner turns it on).

**Transaction limits & customer tiers:**
- **T0 (new‑customer observation window, 3 days):** capped at **$500/transfer and $500/day**.
- **T1 (verified or grandfathered):** capped at **$2,999/transfer and $2,999/day**.
- **Suspended:** $0 (rejected, or unverified past the window when the gate is on).

**Velocity & volume controls:**
- **Velocity limit** — more than **5 transfers/day** flags a customer for review (date‑bucketed counters).
- **Large‑amount flag** — transfers at/above a configurable threshold (≈ $1,000) are flagged for review.

**Enhanced Due Diligence (EDD) — the Travel Rule:**
- Triggered when a customer's **rolling‑month volume reaches ≈ $3,000**.
- Collects and stores structured fields: **relationship, purpose, source of funds, occupation, recipient legal name** — the transfer is flagged (never silently blocked) until satisfied.

**Compliance states & the review queue:**
- A transfer is `cleared`, `flagged`, or `blocked`. **Flagged** transfers are charged but held in `in_review`; an operator **releases** (delivers) or **rejects** (cancel + auto‑refund) them.
- Every consequential action — KYC decisions, blocked attempts, PII reveals — is written to an **append‑only audit log**, scoped per partner.

**Data protection (encryption at rest):**
- Sensitive fields — **payout destinations, recipient legal names, customer PII, integration secrets** — are encrypted with **AES‑256‑GCM envelope encryption** (a per‑record data key wrapped by a master key).
- **Dashboard reads are masked by default** (`****last4`); full decryption is explicit, and staff PII reveals are **audited**.
- **Crypto‑shred deletion** — dropping the ciphertext destroys the only copy of its key, making the value permanently unrecoverable (clean, compliant disposal).

---

## 8. Every component in detail

**The AI conversational agent**
- **Model:** Kimi K2.6 on Ollama Cloud. A turn allows up to ~6 tool rounds; history is trimmed to the last 40 messages with a 30‑day TTL.
- **Safety rails:** every link the model writes is **stripped** and replaced with a code‑generated canonical pay/verify link; a verify‑before‑send gate is injected deterministically; on the web channel the toolset is **narrowed** (read‑only + refunds).
- **Channels:** WhatsApp (full toolset, interactive buttons) and the web account portal (restricted toolset).
- **Inbound pipeline:** Meta signature verification (fail‑closed) → message de‑duplication → STOP/START consent handling → partner routing by phone‑number‑ID → durable enqueue.

**The 18 agent tools** — `get_quote`, `create_transfer`, `generate_payment_link`, `check_payment_status`, `request_refund`, `update_recipient_phone`, `create_schedule`, `list_schedules`, `cancel_schedule`, `list_saved_recipients`, `send_recipient_picker`, `send_approve_picker`, `cancel_draft`, `check_send_limit`, `validate_phone`, `resolve_recipient`, `repeat_transfer`, `capture_corridor_request`. (10 of these are allow‑listed on the web channel.)

**Customer‑facing surfaces**
- **Hosted pay page** (`/pay/<id>`) — branded; collects payout + payment details, shows the locked quote with a masked recipient account, OTP step‑up, unframable + IP‑rate‑limited.
- **Customer account portal** (`/account`) — password login (OTP for reset), transfer history, locked receipts, repeat sends, support tickets, and an embedded web chat.
- **Public landing page** (`/`) — dual‑audience product explainer with live FX and corridor matrix; a partner integration/docs hub at `/docs`.

**The admin dashboard** (staff‑gated) — Overview (KPIs) · Transactions (paged ledger) · Ops (stuck money, refunds) · Schedules · Customers (KYC/tier) · Compliance (flagged/blocked review) · KYC (Persona case review) · Analytics (Recharts) · Partners (wizard + per‑partner config) · Corridors · Rates (partner pricing board) · Team (staff) · API Keys. (Plus support tickets.)

**The security pack**
- **Boot‑assert** — production refuses to start if any money‑grade secret is missing or malformed.
- **Enforced CSP + security headers** — HSTS (2‑yr preload), `frame‑ancestors 'none'`, nosniff, locked permissions policy.
- **Middleware gates** — signed staff cookie for `/admin-dashboard`; a strict `__Host-` customer cookie for `/account`.
- **Per‑IP rate limits** (fail‑open) on the pay page, webhooks, and login.
- **PII‑scrubbing logger** — phone numbers, accounts, emails masked to last‑4 in all money‑path logs; tokens/OTPs never logged.

**The data model (Postgres ledger, 14 tables)** — `partners`, `transfers`, `customers`, `partner_integrations`, `partner_rates`, `api_keys`, `schedules`, `beneficiaries`, `recipients`, `audit_events`, `idempotency_keys`, `outbox`, `kyc_cases`, `corridor_requests` (plus support tickets). **Storage split:** Neon Postgres is the durable money ledger; Upstash Redis holds only hot/ephemeral data — conversations (30‑day TTL), drafts, OTPs, throttles, message de‑dup, velocity counters, and the FX cache.

**The stack** — Next.js 16 (App Router) on Vercel (serverless / Fluid Compute) · TypeScript · Drizzle ORM · Tailwind v4 + shadcn/ui · Recharts · Meta WhatsApp Cloud API · Persona (KYC) · Frankfurter (FX) · ~140 test files / ~1,665 automated tests with a post‑deploy browser smoke suite.

---

## 9. Why it's trustworthy (the one‑slide summary)

- **Non‑custodial** — you stay the licensed transmitter; we never hold funds.
- **Compliance‑first** — sanctions always on; human‑only KYC approval; tiered caps, velocity, and EDD.
- **Durable & idempotent** — nothing is lost; nothing double‑charges; crashes self‑heal.
- **Signed end to end** — every settlement instruction and callback is HMAC‑signed and fail‑closed.
- **Encrypted & audited** — PII encrypted at rest, masked by default, reveals audited.
- **Multi‑tenant & isolated** — every partner fully separated, branded, and self‑served.
- **Proven by tests** — ~1,665 automated tests plus a post‑deploy smoke suite on every release.
