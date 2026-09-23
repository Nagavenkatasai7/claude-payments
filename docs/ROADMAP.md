# SmartRemit — Feature Inventory & Roadmap

Honest status of what is built against the original end-to-end remittance vision. **Re-verified 2026-09-22 against `main @ 191828f`** (Program-Fix 42): every row below was re-read from the code it names. The previous version was dated 2026-05-23 and predated the Postgres ledger, Persona KYC, the partner platform and the outbox.

## Where it stands

SmartRemit is white-label, non-custodial remittance **infrastructure**: a multi-partner, multi-corridor platform in which the licensed money transmitter (the partner) moves the money and SmartRemit orchestrates the conversation, quoting, compliance screening, KYC flows and signed settlement instructions.

**Real:** the AI conversation, live FX quoting, the signed instruction→callback settlement loop, durable processing (outbox), the admin/partner dashboards, the customer account portal and WhatsApp notifications.

**Simulated today** (the same wording as `/about` and `/docs`): actual fund movement, the production identity-verification vendor, a commercial sanctions feed, and a live payout rail. A reference "simulator" rail runs the exact signed loop a production rail would.

---

## Feature inventory (status per sub-feature)

### 1. Initiation & AI personalization

| Sub-feature | Status | Reality (source) |
|---|---|---|
| Verified business WhatsApp profile | ⚠️ partial | The platform default is still Meta's **test number** (+1 555-629-8293). Partners can bring their own numbers (`partner_integrations`, routing by `phone_number_id` in `src/lib/whatsapp-inbound.ts`). Needs Meta Business Verification. |
| AI suggests frequent recipients | ✅ built | Saved recipients per sender (`recipients` table), `list_saved_recipients`, `send_recipient_picker`, `repeat_transfer` and `get_customer_context` in `src/lib/tools.ts`. |
| Select existing recipient / input new UPI or bank | ✅ built | The bot collects recipient name, phone and country; bank/UPI details are entered on the hosted pay page, never in chat (`src/lib/payout-format.ts`). |

### 2. AI-driven rate locking

| Sub-feature | Status | Reality (source) |
|---|---|---|
| User enters an amount | ✅ built | Send-side or receive-side amounts (`get_quote`, `src/lib/fx.ts`). |
| Live FX + "AI micro-second optimal lock" | ⚠️ partial | Live FX **yes** (Frankfurter, Redis L2 cache, fails loud on stale or missing rates — `src/lib/rate.ts`, `src/lib/rate-staleness.ts`); per-partner rate pushes (`partner_rates`, `PUT /rates`). An "optimal lock" prediction model is **not** a software feature and is not built. |
| Transparent breakdown (rate / fee / delivery / payout amount) | ✅ built | `get_quote`; fees are method-based, not $0 (`src/lib/fx.ts`). |
| Native WhatsApp Approve button | ✅ built | `send_approve_picker` (`src/lib/tools.ts`) sends an interactive approve card; button taps are parsed in `src/lib/whatsapp-buttons.ts`. |

### 3. High-speed US funding (instant pull)

| Sub-feature | Status | Reality (source) |
|---|---|---|
| Plaid open-banking link | ❌ not built | Mock card / bank form on the hosted pay page (`/pay/<id>`). A `FundingProvider` seam exists (`src/lib/providers/funding-provider.ts`) with a signed funding webhook (`/api/funding-webhook`). |
| FedNow / RTP pull | ❌ not built | Simulated. |
| Bank → settlement in seconds | ❌ not built | Simulated. |

### 4. Real-time compliance & fraud checks

| Sub-feature | Status | Reality (source) |
|---|---|---|
| Identity verification (KYC) | ⚠️ integrated, not live | Persona hosted flow + signed webhook (`src/lib/providers/persona-kyc-provider.ts`, `/api/persona-webhook`); approval is human-only, with an AI read-assist for the reviewer (`src/lib/kyc-review-ai.ts`). KYC can be delegated to the partner. The production vendor account is not live. |
| Real sanctions list | ⚠️ mock | Screening always runs and cannot be switched off, but against a built-in reference list (`MockSanctionsScreener`, `src/lib/providers/sanctions-provider.ts`), not OFAC or a commercial feed. |
| Transaction velocity and send caps | ✅ built | Per-sender daily/monthly caps enforced from the ledger under a per-sender lock (`src/lib/send-limits.ts`, `src/lib/daily-volume-store.ts`), tier rules (`src/lib/tier-rules.ts`). |
| Replaces manual holds | ⚠️ partial | Rule-based `cleared` / `flagged` / `blocked` in the mint path; flagged transfers are held for staff review with an AI triage summary (`src/lib/review-triage-ai.ts`). The decision stays human. |

### 5. Instant payout (UPI / IMPS and other corridors)

| Sub-feature | Status | Reality (source) |
|---|---|---|
| Pre-funded destination liquidity | ❌ not built | Belongs to the partner; SmartRemit is non-custodial. |
| Real UPI / IMPS push | ❌ not built | The partner's rail receives a signed settlement instruction; today the reference simulator rail answers (`/api/partner-rail`, `src/lib/settlement.ts`). |
| Recipient paid in seconds | ❌ not built | Simulated: the simulator rail calls back, or the built-in mock settle completes after a fixed delay (`DELIVERY_DELAY_MS`, `src/lib/providers/payment-provider.ts`), both through the durable outbox. |

### 6. Confirmation & receipt

| Sub-feature | Status | Reality (source) |
|---|---|---|
| Sender + recipient WhatsApp notifications | ✅ built | Stage messages to the sender, the approved `transfer_delivered` template to the recipient (`src/lib/whatsapp-templates.ts`), all as outbox rows. |
| Digital receipt | ✅ built | Receipts in the customer portal (`src/app/account/receipt/[transferId]`). |
| AI suggests a recurring schedule | ⚠️ partial | Recurring schedules exist (`create_schedule` / `list_schedules` / `cancel_schedule`, daily cron); the bot does not yet propose them from spending patterns. |

### Platform (beyond the original vision)

| Sub-feature | Status | Reality (source) |
|---|---|---|
| Admin and partner dashboard | ✅ built | `/admin-dashboard` (Transactions, Ops, Schedules, Customers, Compliance, KYC, Analytics, Partners, Corridors, Rates, Team, API keys, tickets, B2B). Partner staff are pinned to their tenant. |
| Multi-channel WhatsApp | ✅ built | Per-partner BYO numbers; credentials encrypted at rest and resolved at send time. |
| Postgres ledger | ✅ built | Neon Postgres via Drizzle (`src/db/schema.ts`); Redis is hot/ephemeral only. |
| Durable effects | ✅ built | Transactional outbox drained by `/api/worker` with retries, dead-lettering and ops alerts (`src/lib/outbox-worker.ts`). |
| Partner REST API + signed webhooks | ✅ built | `/api/partner/v1/*`, documented at `/docs`. |
| B2B invoicing | ✅ built (mock data) | Sellers issue bills the buyer pays in chat (`create_invoice`, `present_bill`, `b2b_invoices`, `sellers`). No real accounting integration. |
| Customer account portal | ✅ built | `/account`: history, receipts, repeat sends, support tickets, web chat (restricted toolset). |
| CI/CD | ✅ built | GitHub Actions `ci / ci` gate on PRs, Vercel rolling releases, post-deploy Playwright smoke (`smoke.yml`). |
| Feature flags | ❌ not built | |

---

## Roadmap — what remains

These are mostly partnerships and licensing, not code. The provider seams (`PaymentProvider`, `FundingProvider`, `KycProvider`, `SanctionsScreener`) are in place, so each is a swap behind an existing interface.

1. **Commercial sanctions feed** — ComplyAdvantage, Sanctions.io or Refinitiv behind `SanctionsScreener`, replacing the reference list.
2. **Production KYC vendor account** — take Persona (or the partner's KYC) live.
3. **Funding provider** — Plaid + FedNow/RTP or a BaaS partner behind `FundingProvider` (Phase 4, fix 7).
4. **A live payout rail** — a partner's own rail (UPI/IMPS via an AD-II partner such as NIUM or M2P) in place of the simulator.
5. **Verified business WhatsApp profile** — Meta Business Verification for the platform number.
6. **AI schedule suggestions** — propose a recurring schedule from repeat sends.
7. **Feature flags** — staged rollouts and per-partner gating.

---

## How to use this document

- When asking "is this realistic": match against this inventory. If it needs a licence or a partner, the answer is "code yes, business and regulatory work first".
- Update this file when a status changes, and re-stamp the date and SHA at the top. Keep it honest: nothing here is described as live until it is.
