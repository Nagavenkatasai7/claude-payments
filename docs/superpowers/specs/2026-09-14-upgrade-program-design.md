# SmartRemit upgrade program — design

Date: 2026-09-14. Status: **approved by the owner 2026-09-14** with two amendments: (a) stay on free tiers for now, so Phase 1 ships the outbox lease column, reclaim and timeouts but the drain stays on the GitHub Actions heartbeat until Vercel Pro is bought; (b) keep Ollama/Kimi as the model provider for now, so Phase 2 fixes the loop, timeouts, injection hygiene, memory bounding and evals on the current provider and the Claude/AI Gateway move is deferred. PR flow: one PR per fix, owner reviews and merges. Inputs: `docs/AUDIT-2026-09-14.md` (ground-truth audit + claude-security scan, combined fix plan of 49 items) and four deep-research passes (orchestration; agent runtime and model; MCP; payments and compliance), each adversarially verified against primary sources on 2026-09-14. Where a fact below was verified it is marked **[verified]**; where it rests on vendor documentation that the research budget did not reach, it is marked **[docs, unverified]** and must be re-checked before a contractual or budget commitment. "Fix-plan N" refers to the audit's original 40-item numbering (section "Fix plan" of the audit's final synthesis); "scan Fnn" refers to the claude-security finding ids.

## 1. Goal and constraints

Goal, in the owner's words: fix the existing application to its best usage before adding features, demo the whole product to partners with clarity, keep it scalable, use the best available architecture, make it as easy to use as it should be and as hard to break as a money application must be, and adopt AI agents and MCP where they genuinely help.

Constraints agreed on 2026-09-14: upgrade in place (Next.js 16 + Vercel + Neon + Upstash stay; new services only beside them); startup-lean budget (Vercel Pro, Neon Launch, Sentry team tier, one sanctions feed; low hundreds USD/month); no fixed demo date; all four AI directions are in scope (better customer agent, ops/compliance copilots, SmartRemit as an MCP server, MCPs consumed by the agent).

Non-goals for this program: new corridors, new product features, replatforming, real-money go-live (that is the phase after this program and needs the owner's PSP and partner decisions).

## 2. What the evidence settles

1. **The engineering spine is right and stays.** Transactional settlement, claim-first minting, the Postgres outbox, envelope encryption, fail-closed HMACs and app-level tenant scoping were verified in production. Nothing here is replaced.
2. **The outbox stays the system of record for money.** Vercel Workflows deletes run state 7 days after completion on Pro; Vercel Queues hard-deletes messages at TTL (max 7 days). Neither can be the ledger. **[verified]**
3. **Vercel Cron cannot be the delivery guarantee on any plan** (no retry, best-effort, may skip or double-fire); Hobby allows once per day; Pro per minute. Cron's role is an idempotent reconciliation sweep. **[verified]**
4. **Vercel Queues gives the lease/visibility-timeout the outbox lacks** (default 60s HTTP / 300s SDK, extendable, crashed consumer's message becomes visible again) but is public beta, at-least-once, no dead-letter queue. **[verified]**
5. **Vercel Workflows fits settlement and reconcile** (no run-duration or sleep limit, hooks that block on an external event) but reached GA only 2026-04-16 with a breaking major in flight. **[verified]**
6. **Model:** Claude Sonnet 5 at $2/$10 per MTok is the primary conversational tier (Haiku 4.5 at $1/$5 is cheaper but its retirement floor is 2026-10-15, one month out); Fable 5.1 at $10/$50 is reserved for offline eval judging and code review. Kimi K2.6 on Ollama Cloud has no price advantage ($0.95/$4.00, cached $0.16 vs Haiku's $0.10) and is concurrency-capped at 1 (Free) or 3 (Pro) simultaneous requests with overflow rejected, which is the wrong shape for bursty WhatsApp webhooks on a money path. Its zero-retention claim is self-attested with no SOC 2 or DPA found. **[verified]**
7. **Anthropic `strict: true` tool calling** guarantees schema-valid inputs and allow-listed tool names at the decoding layer. It is not a money-safety control: no min/max or pattern support, "schema-valid, not semantically correct". **[verified]**
8. **Prompt caching is the dominant cost lever** (cache reads 0.1x input; cache reads do not count toward input rate limits). **[verified]**
9. **The Anthropic spend cap is the availability cliff:** Start tier $500/month, then HTTP 429 with no retry-after until month end. We need spend monitoring and a fallback route. **[verified]**
10. **Vercel AI Gateway:** no token markup including BYOK; per-API-key budgets are the closest thing to per-partner caps (soft, up to ~5 min lag, BYOK not counted); zero data retention is Pro-only, off by default, and unavailable for Fable 5. **[verified]**
11. **MCP 2026-07-28 is current and stateless** (POST-only, no session id, no initialize handshake). A remote server must be an OAuth 2.1 resource server with RFC 9728 metadata, RFC 8707 resource indicators, audience validation, and no token passthrough. Human confirmation is a client SHOULD only; money tools must be server-enforced two-phase quote→confirm with one-time, principal-bound state. Scopes can be computed per request (403 `insufficient_scope`). **[verified]**
12. **OWASP Agentic Top 10 2026, ASI01:** all natural-language input, including third-party content, passes through injection safeguards before it can influence planning or tool calls; system prompts are explicit and locked. **[verified]**
13. **Sender funding has no self-serve path.** Stripe classifies money transmitters/remittance as Restricted (sales conversation, licence proof, revocable approval) and bans peer-to-peer money transmission; Plaid Transfer is US-only both legs and names "a money transfer app" as unsupported, pointing to Plaid Auth plus your own ACH processor; Moov has a $500/month minimum; on sponsor-bank ACH the exposure is returns ($5, $15 unauthorized, $25 late request) and 60-day R10/R11 principal clawback after INR has been paid out. **[verified]**
14. **Sanctions screening can be $0 licence:** Moov Watchman (Apache-2.0, Docker image, `/v2/search` with match score, `sourceList`, `sourceID`; lists via `INCLUDED_LISTS`, default empty) but it persists nothing, so SmartRemit writes its own screening record with a `/v2/listinfo` snapshot. OFAC records must be kept **10 years** (31 CFR 501.601, final at 90 FR 13286, effective 2025-03-12). **[verified]**
15. **Unresearched, treated as docs-only assumptions:** KYC vendor pricing and Persona webhook event names; Reg E §1005.31–.34 disclosure contents (the audit already identified the missing items); WhatsApp 2026 per-message pricing and verification steps; Neon and Upstash tier limits; Standard Webhooks details; Vercel Hobby commercial-use terms (the audit's Vercel investigator quoted them, the research did not re-verify). **[docs, unverified]**

## 3. Approaches considered

- **A. Fix-only, no architecture change.** Close the 49 fix-plan items on the current design. Cheapest and fastest to a demo, but leaves the 3-hour drain, no lease reclaim, no timeouts and a fragile agent loop as permanent debt. Rejected as the end state; adopted as Phase 1.
- **B. Upgrade in place with additive services (recommended).** Keep the ledger and outbox; add a lease column and a per-minute Pro cron now; put Vercel Queues (drain) and Workflows (settlement/reconcile) behind internal interfaces after the demo; replace the agent loop with AI SDK 7 + Claude via AI Gateway; add Watchman, Sentry, Langfuse; expose read-only MCP tools with OAuth. Matches every constraint and every verified finding.
- **C. Move orchestration to Inngest or Temporal.** Richer tooling, but Inngest bills every step as an execution ($99/month for 1M) and Temporal Cloud adds a service outside the stack; both punish an 8-attempt backoff ladder. Rejected for this budget; QStash noted as the cheapest fallback if Vercel's betas prove unreliable.

## 4. Design

### 4.1 Reliability: outbox, drain, scheduler

- **Phase 1 (demo):** add `lease_until timestamptz` and `lease_owner` to `outbox`; `claimBatch` also claims `processing` rows whose lease expired; a new drizzle migration extends the `outbox_drain` partial index. Every outbound `fetch` (rail, Meta Graph, Frankfurter, Persona, Ollama/Anthropic) gets `AbortSignal.timeout(...)` with per-kind budgets (rail 15s, Meta 10s, FX 5s, LLM 45s). Move the heartbeat from GitHub Actions to a Vercel Pro cron `*/1 * * * *` hitting `/api/worker` with `CRON_SECRET`; keep the GitHub workflow as a secondary trigger. `reconcileSweep` stays as the idempotent safety net. Ops alert gets a second channel (Sentry alert to email) so it no longer depends on the queue it reports on.
- **Phase 3 (production):** introduce `src/lib/dispatch/` with an interface `enqueueEffect(kind, payload, opts)` implemented first by the outbox (today) and then by Vercel Queues with publish-side idempotency keys; the outbox row remains the durable record and the queue message carries only the row id. Settlement and reconcile become a Vercel Workflow (`"use workflow"`) whose steps read and write ledger rows and whose hook waits on the rail callback or a human approval; Workflow state is never authoritative. Adopt only after re-checking the open sleep/hook issues on the GA line.

### 4.2 Money safety on the existing paths

Closes fix-plan items 1, 4–7, 13 and scan items F51, F53. Authenticate `/api/funding-webhook/*` unconditionally (the `mock` carve-out goes); `beginSettlement` and partner-API confirm refuse rows whose `compliance_status` is not `cleared`; the pay route runs capture only from `awaiting_payment`; a `failed`/`returned` rail callback moves the transfer to `failed` and enqueues refund + customer message + alert; staff Cancel on a paid transfer requires a refund path; the approve card rehydrates the real payout destination server-side; send caps return to the tier ladder with counters derived from the ledger (Redis as cache only). Funding capture stays behind the existing `FundingProvider` seam until the PSP decision (section 5.3).

### 4.3 Tenant boundary

Closes scan F44, F45, F47, F50, F52 and fix-plan 30. Customers, recipients, velocity counters and recent-transfer reads are keyed by `(partner_id, phone)`; the partner API refuses to mint for a `sender.phone` that is not a customer of that partner and never returns another tenant's decrypted name; the WhatsApp webhook resolves the customer under the routed partner only. Migration adds `partner_id` to the customer primary key with a backfill from existing rows.

### 4.4 The customer agent

- **Runtime:** AI SDK 7 bounded tool-loop agent (default 20 steps, explicit per-step and total timeouts), provider = Vercel AI Gateway with BYOK Anthropic key, primary `anthropic/claude-sonnet-5`, fallback `anthropic/claude-haiku-4-5` on 429/5xx, one Gateway API key per partner with a budget. Prompt caching on the static system prompt. Spend monitor on `enforced_spend_limit_reached` with a pre-arranged fallback route.
- **Tools:** `strict: true` schemas with enums for currency/method; amounts, formats and caps validated in code after the model, never trusted from the schema. Money-moving tools remain unreachable from the model (as today); the approve card stays the only path to a transfer.
- **Injection hygiene (ASI01):** the system prompt is static and locked; recent transfers, selected recipients, invoice memos and beneficiary names enter as structured tool-role data with values quoted and length-capped, never as system prose; payout destinations are always masked when the model can see them; partner-authored prompt overrides are bounded and cannot touch the money-safety section.
- **Memory:** conversation history in Redis is bounded (last N turns + a rolling summary produced by Haiku), tool results are truncated before storage, 30-day TTL unchanged.
- **Evals:** a 15-case adversarial conversation set (from the audit's prompt-quality review plus the live-session bugs: silent reply, false escalation, currency flip, recipient resolution) runs in CI against a recorded tool layer; Fable 5.1 as the judge via the Batch API. **[tooling choice: Promptfoo or Langfuse datasets, docs-only]**
- **Observability:** Sentry (`@sentry/nextjs` from the existing `register()` hook) for errors; Langfuse cloud free tier for traces via AI SDK OpenTelemetry. **[docs, unverified pricing]**
- **Bot bugs from the live session** are fixed as ordinary PRs: empty replies get a fallback message and an alert; "talk to a human" creates a ticket; schedule amounts carry an explicit currency; "same person as last time" asks for confirmation.

### 4.5 MCP

- **Consume now:** `@ai-sdk/mcp` client to Watchman's MCP server (sanctions), Frankfurter/FX, and Persona, each behind the same timeout and allow-list rules as HTTP tools.
- **Expose later (Phase 3):** one POST-only route `/api/mcp` on the 2026-07-28 revision: `MCP-Protocol-Version` and `_meta` validation, Origin check, no session store; OAuth 2.1 resource server with a protected-resource metadata document, audience validation, hard rejection of partner REST keys at this endpoint; read-only tools first (`get_quote`, `get_transfer_status`, `list_corridors`) under a `read` scope; transfer creation only as a two-phase `quote → confirm` with server-minted, one-time, principal-bound `requestState`, an `insufficient_scope` challenge for `transfer:write`, rate limiting per client, and an `audit_events` row per invocation. Ops/compliance copilots use the same server with staff OAuth identities.

### 4.6 Security and secrets

Closes fix-plan 2, 14–16, 22 and scan F46, F48, F49, F54–F62, F64–F72. Rotate the leaked admin credential and delete the literals; staff login gets rate limit, lockout, MFA and a password-change path; ids from `crypto.randomBytes` (≥128 bits) with the pay page rate-limited; rail and partner webhooks move to timestamped HMAC with a replay window and dual-secret rotation (Standard Webhooks shape **[docs, unverified]**); outbox payloads carry ids, not tokens (WhatsApp creds resolved at run time); attempt counters use `INCR` + `EXPIRE` (or a Lua script) so they are atomic; staff RSC payloads drop password hashes; session tokens are hashed before use as Redis keys; envelope AAD binds table, column and row.

### 4.7 Compliance substance

Closes fix-plan 11, 12, 21, 35. Self-hosted Watchman with `INCLUDED_LISTS=us_ofac,us_non_sdn,us_csl,us_fincen_311` behind `watchman-cache`; a `screening_events` table storing query, threshold, every hit (match, sourceList, sourceID), a `/v2/listinfo` snapshot, reviewer and decision, retained 10 years; KYC decisions written to `kyc_cases` with actor and reason, the one-click override removed; Reg E pre-payment disclosure and receipt fields (rate, fees, total, amount received, availability date, cancellation right, error-resolution contact) on the approve card, pay page and receipt, with a 30-minute cancellation window **[legal text to be confirmed with counsel]**; Terms and Privacy pages shipped; the no-KYC prompt variant disabled for production partners.

### 4.8 Product surfaces for the demo

Closes fix-plan 18, 25, 26, 33, 34 and the admin-walk items. Production WhatsApp number and approved templates (owner action in Meta Business Manager); corridors page brief streamed in a Suspense boundary with a 3s deadline; transactions hydration fix; mobile sidebar collapse; per-page titles; masked names and phones on admin lists and customer ids instead of phones in URLs; demo hygiene (seed forms behind a flag, test fixtures out of Team, expired rates refreshed, stale tickets closed); docs corrected.

## 5. Sequencing

Each item is one PR with a failing test first, security review on money/auth/webhook PRs, post-merge smoke check, component branches per CLAUDE.md. Estimates are engineering time with one builder plus subagents.

1. **Phase 0, unblock (2–3 days):** CI green (dependency bump, audit gate after tests); funding webhook auth; rotate the admin credential; Vercel Pro + Neon Launch; `node_modules.nosync` excluded everywhere locally.
2. **Phase 1, demo-safe core (1–2 weeks):** outbox lease + per-minute cron + timeouts; tenant boundary; compliance hold on every path; failed-rail path; staff cancel; placeholder mint; Sentry + second alert channel.
3. **Phase 2, agent and product (1–2 weeks):** AI SDK 7 + Claude via Gateway; injection hygiene; memory bounding; the five live-session bugs; eval set in CI; production WhatsApp number; admin-dashboard fixes and demo hygiene; masked PII.
4. **Phase 3, production-grade (2–3 weeks, can start after the demo):** Watchman + screening records; Reg E disclosures, Terms, Privacy; durable KYC audit; staff auth hardening; timestamped HMAC + rotation; secrets out of outbox; atomic counters; Workflows for settlement behind the interface; Queues drain behind the interface.
5. **Phase 4, MCP and copilots (1–2 weeks):** consume MCPs; expose the read-only MCP server with OAuth; ops copilot for ticket triage and KYC review on the same server.
6. **Parallel, owner decisions:** PSP (Plaid Auth + an ACH originator under the partner's licence, or a Stripe sales conversation with the partner as the regulated principal), first partner and licence scope, sanctions list additions, repo visibility.

Demo-ready = Phases 0–2 complete. Real-money-ready = Phases 0–3 plus the PSP integration behind the funding seam.

## 6. Budget (monthly, verified where marked)

Vercel Pro (per-seat, **[docs, unverified]**); Neon Launch **[docs, unverified]**; Anthropic Start tier cap $500 **[verified]**; AI Gateway no markup **[verified]**; Watchman hosting only (a small container, **[docs]**); Sentry team tier and Langfuse free/cloud **[docs, unverified]**; Meta WhatsApp per-message **[unverified]**. Expected total for a few-hundred-customer pilot: low hundreds USD/month plus LLM usage, which prompt caching keeps small.

## 7. What to wait on (next 6 months)

Vercel Workflows major (adopt on the stable line after the demo); Vercel Queues GA (keep behind the interface); AI SDK 7 is the target, 6 is superseded; Haiku 4.5 retirement floor 2026-10-15 (do not build the primary path on it); MCP client/SDK adoption of 2026-07-28 (serve both 2026-07-28 and 2025-11-25 if a partner's client lags); Stripe/Plaid approvals (start the conversation now, integrate later).

## 8. Risks

Beta reliability of Workflows/Queues (mitigated by interfaces and the outbox as record); Anthropic spend cap (monitor + fallback); a partner's MCP client ignoring confirmation SHOULDs (server-side enforcement); Reg E text without counsel review (flagged); PSP approval timelines outside our control (funding stays behind the seam); research gaps in section 2 item 15 (re-verify before spend).

## 9. Testing and proof

Every helper TDD'd with Vitest + PGlite; outbox lease and timeouts tested with fake timers after `freshDb()`; tenant boundary tests pinned per repo function; agent evals in CI; Playwright smoke extended for the admin fixes; `/security-review` on every money/auth/webhook PR; `/post-merge-check` after each merge; a second claude-security scan scoped to the 20 unresearched components after Phase 2.
