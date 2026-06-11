# SmartRemit — Feature Inventory & Roadmap

Honest, up-to-date status of what's actually built vs the originally specified end-to-end remittance vision. Updated **2026-05-23**.

## Scoring summary

Of ~26 sub-features in the original specification (the WhatsApp-as-remittance-pipeline flow):

| | Count |
|---|---|
| ✅ Fully built | 8 |
| ⚠️ Mocked or partial | 8 |
| ❌ Not built | 10 |

We have a **convincing prototype of the conversation, dashboard, and notification layers**. We do **not** move real money, do real KYC, or integrate with real banking rails. That matches the original prototype scope; turning it into a live service requires partnerships + regulatory work, not just code.

---

## Feature inventory (status per sub-feature)

### 1. Initiation & AI Personalization

| Sub-feature | Status | Reality |
|---|---|---|
| Verified business WhatsApp profile | ⚠️ partial | Real WhatsApp Cloud API works, but on a Meta **test number** (+1 555-629-8293) capped at ~5 verified recipients. Needs Meta Business Verification. |
| AI suggests frequent recipients | ❌ not built | Conversation history is kept per phone but the bot doesn't recall or surface past recipients. |
| Select existing recipient / input new UPI or bank | ✅ built | Bot collects name, payout (UPI ID or bank+IFSC), recipient phone. |

### 2. AI-Driven Rate Locking

| Sub-feature | Status | Reality |
|---|---|---|
| User enters dollar amount | ✅ built | |
| Live FX + AI micro-second optimal lock | ⚠️ partial | Live FX **YES** (Frankfurter API, cached 1 h). "AI micro-second optimal lock" — **NO** (would require a market-prediction model; not a software feature). |
| Transparent breakdown (rate / fee / delivery / INR) | ⚠️ partial | Shown by `get_quote`. But fees are **not $0** ($1.99 / $2.99 / +3% per method) and delivery is **"within 10 minutes"** not "instant" (no real rail). |
| Native WhatsApp Approve button | ❌ not built | Confirmation is a text reply. Cloud API supports interactive button messages; we haven't wired them. |

### 3. High-Speed US Funding (Instant Pull)

| Sub-feature | Status | Reality |
|---|---|---|
| Plaid open-banking link | ❌ not built | Mock card / bank-link form on `/pay/[id]`. |
| FedNow / RTP pull | ❌ not built | Mocked. |
| Bank → settlement in seconds | ❌ not built | Mocked. |

### 4. Real-Time AI Compliance & Fraud Check

| Sub-feature | Status | Reality |
|---|---|---|
| AI identity verification (KYC) | ❌ not built | No KYC provider integrated. |
| Real sanctions list | ⚠️ mock | Hardcoded `WATCHLIST` in `src/lib/compliance.ts`. Not OFAC. |
| Transaction velocity analysis | ✅ built | Per-phone-per-day counter; flags at ≥3/day. |
| Replaces manual holds | ⚠️ partial | Rule-based; blocks or flags inside `create_transfer`. Not "AI". |

### 5. Instant Indian Payout (UPI/IMPS)

| Sub-feature | Status | Reality |
|---|---|---|
| Pre-funded India liquidity pool | ❌ not built | No Indian banking partner. |
| Real UPI / IMPS push | ❌ not built | Mocked. |
| Recipient gets INR in 60s | ❌ not built | ~2-min mock auto-advance via `after()` background work. |

### 6. Confirmation & Receipt

| Sub-feature | Status | Reality |
|---|---|---|
| Sender + recipient WhatsApp notifications | ✅ built | Sender gets paid / delivered messages. Recipient gets the approved `transfer_delivered` WhatsApp template (verified delivering). |
| Digital receipt | ❌ not built | Text confirmation only. No formal receipt page. |
| AI suggests recurring schedule | ❌ not built | Recurring exists; the bot doesn't proactively suggest it from patterns. |

### Bonus — context the user asked for

| Sub-feature | Status | Reality |
|---|---|---|
| External admin website with webhooks | ✅ built | Dashboard at `smartremit.ai`; Meta webhook `/api/whatsapp`. |
| All traffic monitored on dashboard | ✅ built | Every transfer logged; live 5-sec refresh on every dashboard page. |
| Multi-channel WhatsApp monitoring | ❌ not built | Single phone-number-id hardcoded. |
| Scalable as users grow | ⚠️ prototype-scale | Fine at hundreds of transfers. In-memory aggregation would not survive ten-thousands without pre-aggregated counters or a real DB. |
| Modifiable / extensible | ✅ structural | Modular `src/lib/*`; agent + tools pattern. Easy to add features. |
| **CI/CD pipeline** | ✅ built | GitHub repo at `Nagavenkatasai7/claude-payments`; GitHub Actions runs typecheck + lint + test + build on every PR and push to `main`; Vercel auto-deploys on merge with per-PR preview URLs; branch protection requires the `ci / ci` check; Playwright smoke test runs against prod after each production deploy. Shipped 2026-05-23. |

---

## Roadmap — what to build, in what order

### Lane A — Cheap wins (no external partnerships, days of work)

1. ~~**CI/CD pipeline.** GitHub repo + GitHub Actions for PR checks + Vercel auto-deploy + branch protection + a Playwright smoke test for the dashboard.~~ ✅ **shipped 2026-05-23** — `Nagavenkatasai7/claude-payments`, workflows in `.github/workflows/`. *Plan: `docs/superpowers/plans/2026-05-23-cicd.md`*
2. **Provider abstraction layer** — `interface PaymentRail`, `interface KycProvider`, `interface SanctionsProvider`. Today's mocks implement these. Production swaps in real providers behind the same interfaces without rewriting the agent. ~1–2 days.
3. **AI recipient suggestions + WhatsApp interactive buttons** — biggest customer-facing chat wins. Save recipients per phone; bot greets returning customers with "Send $200 to Mom again?" + Approve/Cancel buttons. ~2 days.
4. **Digital receipt page + AI scheduling suggestion** — `/receipt/[id]` public URL sent in confirmation messages; bot detects repeat patterns and offers to schedule them. ~1 day.
5. **Multi-channel WhatsApp routing** — per-channel phone-number-id registry; webhook routing by `metadata.phone_number_id`; per-channel branding. ~1–2 days.
6. **Pre-aggregated counters for analytics scale** — daily Redis counters (`HINCRBY`) so the Analytics page doesn't aggregate from scratch each request. Standard fix; ~1–2 days.

### Lane B — Mid-cost integrations (1–2 weeks each)

7. **Real KYC** — pick a provider (Persona, Onfido, or Veriff). One-time KYC flow in chat. Block transfers until verified. Provider webhook for verification results.
8. **Real sanctions screening** — ComplyAdvantage, Sanctions.io, or Refinitiv. Replaces the hardcoded `WATCHLIST`.

### Lane C — Real banking rails (months, requires partnerships + licenses)

These are NOT software features — code is the smallest part. Costs depend on whether we partner with a BaaS provider or pursue our own licensing.

9. **Verified business WhatsApp profile** — Meta Business Verification (real entity docs).
10. **Plaid integration** — production Plaid account + their KYC of us as a business.
11. **FedNow / RTP** — needs US money-transmitter license per state OR partner with a regulated provider (Lithic, Synctera, Modern Treasury).
12. **India UPI / IMPS payout** — needs Indian Authorised Dealer Cat-II license OR partnership with an AD-II (Wise, Remitly, NIUM, M2P). Pre-funded INR account in India.

---

## Architecture — current → production

### What we have today

```
Customer WhatsApp ⇄ Meta WhatsApp Cloud API (test number)
                      ⇣
Next.js on Vercel: /api/whatsapp · /api/pay · /api/cron · /pay · /login · /dashboard/*
                      ⇣                          ⇣
                  Upstash Redis           Ollama Cloud (Kimi K2.6)
```

### What it needs to become (long term)

```
Customers' WhatsApp (millions) ⇄ Meta Cloud API (verified, multi-channel)
                      ⇣
Next.js + Channel Router (per phone-number-id)
   ├─ Agent loop with persistent per-customer profile
   ├─ Provider abstraction layer ────────┐
   └─ Dashboard / Analytics              │
                                          ▼
              ┌────────┬─────────┬─────────────┬─────────────┐
              ▼        ▼         ▼             ▼             ▼
          KYC API  Sanctions  Plaid/BaaS  Real-time FX  India AD-II
          (Persona,(Comply-   (or money   provider      partner
          Onfido)   Advantage) transmitter)              (NIUM,M2P)
                                          ⇣
              ┌────────────────────────────────────────────────┐
              │  Postgres (ledger, audit, history)             │
              │  Redis (sessions, hot counters, queues)        │
              │  Event bus (compliance, payout, notifications) │
              └────────────────────────────────────────────────┘
```

**Architectural moves that unlock the above (in priority order):**

1. **CI/CD** (this batch) — make every future change shippable safely.
2. **Provider abstraction layer** — interfaces for `PaymentRail`, `KycProvider`, `SanctionsProvider`. Replaces mocks with real providers one at a time without rewriting the agent.
3. **Per-channel WhatsApp routing** — single config → channel registry. Adds multi-channel without a rewrite.
4. **Customer profile table** — separate "customer" (KYC status, saved recipients, preferences) from "transfer" records.
5. **Postgres for the ledger** — financial records belong in a relational DB with proper indexes + ACID + history. Redis stays for hot state.
6. **Event bus + queues** — fan out per-transfer work (compliance, payout, notifications) so the WhatsApp turn isn't blocked by slow downstream calls.
7. **Pre-aggregated counters** — analytics from precomputed counters, not by summing every transfer per request.
8. **Feature flags** — Vercel Edge Config or Flagsmith for staged rollouts, per-channel gating, A/B tests.

---

## How to use this document

- When planning a new feature: check the "Cheap wins" lane first; if it's there, start with it.
- When asking "is this realistic for our prototype": match against this inventory. If it's in Lane C, the answer is "code yes, business + regulatory months, not now".
- Update this file when status changes — keep it honest.
