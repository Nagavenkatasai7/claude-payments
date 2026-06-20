# Where SmartRemit Can Use AI

## Executive Summary

- **AI stays on the rails, never on the money.** Across every opportunity below, the deterministic spine is untouched: AI reads state, ranks, and drafts; deterministic code mints transfers, screens sanctions, holds for review, and clears KYC. This is the architecture's hard line (`docs/AGENTIC-ARCHITECTURE.md` §3), and it is the reason these features are safe to ship in a regulated, non-custodial money product.
- **The highest-leverage near-term wins are operator and analyst copilots** that reuse the already-shipped rung-1 scaffold (`src/lib/ticket-ai.ts`: one `chat()` call, no tools, no loop, GUARDRAILS, clamped output, audited, fail-open rate-limit). They are weeks of work, suggest-only, and low-risk — KYC-review summary, compliance triage narrative, auto-ticket-triage, stuck-transfer diagnosis, corridor-demand briefs.
- **A recurring lesson from verification: build the deterministic version first.** Many "AI" ideas are 70-90% a SQL `GROUP BY` or a closed-list lookup (structuring detection, mule rings, urgency banding, failure-class classification). The genuine, irreplaceable AI value is narrative synthesis and fuzzy entity-resolution across heterogeneous signals — not the detection itself. We scope to that residue.
- **The two genuinely strategic AML bets — fuzzy sanctions/PEP entity-resolution and behavioral typology detection — are high-value but gated.** They need a real list/data source, a labeled eval set, and the unbuilt P1 eval-harness + agent-registry foundation. They stay at human-approve permanently by design.
- **One internal investment unblocks everything else: the eval harness (the missing P1 skeleton).** Every autonomy promotion is explicitly gated on it ("never on vibes"), and today both live AI surfaces only have model-stubbed unit tests. It is test/CI-only (risk ~2) and is the prerequisite for trusting any score or draft.
- **Several plausible-sounding ideas were deliberately rejected as "not AI / out of scope"** because a deterministic rule is cheaper, more auditable, and safer (see the closing list). Putting a non-deterministic model on a money-decline message, a winning-rate calculation, or a compliance threshold flip is a regression surface, not a capability.

---

## AI Today

1. **Conversational send-money agent** — `src/lib/agent.ts` → `src/lib/ollama.ts` (Kimi K2.6), a 15-tool deterministic loop (`get_quote`, `create_transfer`, etc.); the model never moves money or clears compliance — minting goes through `createTransfer`, caps via `evaluateCap`, sanctions via `screenTransfer`, and `sanitizeReply` strips every model-emitted URL.
2. **Rung-1 staff support-ticket copilot** — `src/lib/ticket-ai.ts` (`draftReply` / `summarizeCase` / `triageSuggest`), one `chat()` call, suggest-only behind self-gated, rate-limited, audited routes (`/api/copilot/*`); a human edits and explicitly sends.

---

## Tier 1 — Quick Wins (weeks, suggest-only / low-risk)

**KYC review-decision copilot** *(suggest · V4 F5 R3 · quick win)*
- **Problem:** A reviewer on `/admin-dashboard/customers/[phone]` approves/rejects from a wall of fields (Persona `kycReviewState`, watchlist/PEP flags, `idLast4`, declared name/DOB/occupation, the `kyc_audit` trail) with no synthesis — slow, inconsistent, prone to rubber-stamping.
- **AI approach:** One-shot `chat()` (clone of `ticket-ai.ts`) → a 5-line case summary + a clamped `{decision, confidence, top-3 reasons}`. AI output is decoration the deterministic `reviewKycAction` ignores; the human still types a reason and clicks.
- **Plugs into:** New `/api/copilot/kyc-review` cloned from `draft-reply/route.ts`; reads `getKycCaseStore().getAudit(phone)` + `scoped.getCustomer(phone)` (already returns decrypted PII on this page — no new trust boundary); renders beside `reviewKycAction` (page lines 120-141). The human-only `review()` invariant is untouched.
- **Data:** Customer KYC fields, `kyc_audit:{phone}` trail, Persona verdict. **Note:** risk is 3 not 2 — a one-click "approve" suggestion next to a one-click Approve button invites automation bias; mitigate with suggest-only, audited, eval-gated, no auto-apply.

**Auto-triage every ticket at creation** *(act-with-review → really rung-1 · V3 F5 R2 · quick win)*
- **Problem:** `triageSuggest()` only runs when a human clicks Summarize; every customer-opened ticket lands with `category=null, priority='normal'` and staff hand-sort.
- **AI approach:** Reuse `triageSuggest(subject, firstMessage)` verbatim (closed-list clamp guarantees shape) → `repo.setTriage()`. Wrap in try/catch so a model outage never blocks ticket creation.
- **Plugs into:** `createTicketAction` (`account/support/actions.ts:78`), the recall path (`tools.ts:1449`), `receipt/recall-actions.ts`; `setTriage` already exists (`ticket-repo.ts:187`). Audit as `ticket.triage` with `actorType:'system'` (no schema change). **Correction:** must run **out-of-band** (outbox `agent.turn` or non-awaited), not inline — `triageSuggest` is a synchronous Ollama call and would add latency to a customer-facing redirect. Scope to `kind:'customer'`.
- **Data:** `tickets.subject` + first message body (plaintext by design). Effort is days, not weeks.

**Corridor-demand triage + launch recommender** *(suggest · V4 F5 R2 · quick win)*
- **Problem:** `corridor_requests` (the unsupported-corridor lead feed) is surfaced as a flat list on `/admin-dashboard/corridors` with zero aggregation — no ranking of pent-up demand, no $ value, no "launch which corridor next?"
- **AI approach:** Deterministic aggregator does all the math (group by destination over rolling windows: lead count, USD-normalized sums via `getFxRates`, growth slope, distinct senders, gap-check vs supported pairs/FX coverage). One `chat()` call narrates the ranked table into an expansion brief per top-N destination. Activation stays a manual admin action.
- **Plugs into:** `listCorridorRequests` (`aux-repos.ts:118`); new pure `corridor-demand.ts` (TDD'd) + `corridor-brief-ai.ts`; replaces the flat list on the already-platform-gated corridors page.
- **Data:** `corridor_requests` (sender phone never narrated — counts/sums only), `partner_rates`, `partners.countries`, `getFxRates`. **Note:** `approxAmount` is nullable so $-demand is sparse; lead-count/distinct-sender ranking is the real (deterministic) strength — clamp the `marginBps` narration like `ticket-ai`.

**Partner health & integration-stall scoring** *(suggest · V4 F5 R2 · quick win)*
- **Problem:** Nothing surfaces a struggling partner — a tenant created, issued a key, then zero successful transactions, or a pushed rate that expired and was never refreshed, until churn.
- **AI approach:** Deterministic scorer computes a health/stall band from existing per-partner aggregates (key-issued-but-zero-`transaction.create`, first-week activation, volume trend, `needsAttention` ratio, expired `partner_rates`). The LLM writes only the last-mile "why at risk" + a concrete outreach action.
- **Plugs into:** All four reads already co-located on `admin-dashboard/partners/[id]/page.tsx`: `transfersSummary`, `listByPartner`, api-key `list`, `listRatesForPartner`; new `partner-health.ts` scorer.
- **Data:** `transfersSummary`, partner audit stream, api-key timestamps, `partner_rates` freshness. **Corrections:** the `transaction.create` signal only covers pure-API integrators (WhatsApp/dashboard transfers write no such audit) — fall back to `transfersSummary.total/latest` or it false-positives; `api_keys.lastUsedAt` already exists but is dead (a 2-line wire-up sharpens "stalled").

**Stuck-transfer & dead-letter diagnosis copilot** *(suggest · V3 F4 R2)*
- **Problem:** A `paid`>15m strand fires a generic `ops.alert`; every outbox row dead at 8 attempts lists with a 140-char truncated error. Operators hand-assemble *why* per row, re-diagnosing recurring clusters (a partner's `settlementUrl` 401, a Meta template reject) dozens of times. This is the documented P2 "stuck-transfer diagnosis" worker.
- **AI approach:** Rung-1 one-shot over a masked bundle (stuck `Transfer` + its outbox history + `providerType` + a deterministic count of sibling dead rows by error prefix) → clamped `{failure_class, suggested_action, blast_radius, rationale}`, each carrying the deterministic evidence.
- **Plugs into:** `getOpsSnapshot().stuckPaid/deadLetters`, `outbox-repo` `listDead/retryDead/markDone`; renders a badge on `admin-dashboard/ops/page.tsx`; proposed actions are the existing audited `retryDeadAction/dismissDeadAction`.
- **Data:** transfers, outbox dead rows, `integrations.payment.providerType`. **Corrections:** `transferId` is **not** an outbox column — it lives in payload jsonb, so clustering needs `payload->>'transferId'` extraction, not a plain group-by; failure classification is a closed list a deterministic regex does more cheaply — the AI value is the synthesized rationale.

**Stale-review router** *(suggest · V2 F5 R3)*
- **Problem:** `reconcileSweep()` only nudges a hold *after* it sits `in_review` >24h, undifferentiated, with no view of holds approaching the threshold. Operators triage one row at a time.
- **AI approach:** Rung-1 `triageSuggest`-shape classifier → clamped `{urgency, suggested_path, rationale}` over `complianceReasons`, amount band, `eddRequired`, KYC flags. Release/reject stay deterministic audited dashboard-ops actions.
- **Plugs into:** `getOpsSnapshot().staleReviews` + `transfers.findInReviewOlderThan(hours)` (parameterizable — the "approaching threshold" queue is trivially derivable today).
- **Data:** `complianceReasons`, `eddRequired`, amounts, KYC flags. **Honest weakness:** the urgency banding is pure arithmetic on `paidAt` vs now — ship the deterministic prioritized queue first; layer the suggester only if disposition hints beat a rules baseline on an eval. Value capped at 2.

---

## Tier 2 — High-Value (months, human-approve)

**Compliance / in-review triage copilot** *(suggest · V4 F5 R2)*
- **Problem:** A flagged transfer lands `in_review` and the analyst sees raw reason strings, then manually pulls sender history, corridor norms, and KYC to decide release-or-refund. The bottleneck is human triage throughput, not detection.
- **AI approach:** Reuse the exact rung-1 copilot pattern → a plain-English risk narrative + clamped `{release|hold|escalate}` + priority over the masked transfer, masked sender history, and the deterministic reasons. Strictly suggest-only; the human executes the existing `releaseTransfer/rejectTransfer`.
- **Plugs into:** `listTransfersByPhone/listTransfersByCompliance`, `getOpsSnapshot().staleReviews`; renders a Suggested-Disposition panel on `admin-dashboard/compliance/page.tsx` beside the existing release/reject forms.
- **Data:** `complianceReasons`, full masked row, KYC record, `kyc_cases.notes`. **Defer the sanctions-disposition arm** to P5 — against today's exact-match mock there are no candidate-entity attributes to adjudicate; ship the amount/velocity/EDD triage narrative now.

**Fuzzy sanctions / PEP entity-resolution behind the `SanctionsScreener` seam** *(human-approve · V5 F3 R4)*
- **Problem:** Screening is case-insensitive **exact** match against a tiny mock list (`list.includes(name)`). Real OFAC/UN/EU screening must catch transliteration (Mohammed/Muhammad/Mohd), name-order swaps, initials, diacritics, aliases — and a real list behind exact match drowns analysts in false positives.
- **AI approach:** Swap the mock for a fuzzy screener: phonetic + edit-distance + a multilingual name-embedding model, co-keyed on DOB/nationality, returning a **scored** candidate list + optional LLM adjudication on near-threshold cases. A **deterministic threshold** maps score→{block, grey-band review, clear}. The AI only widens recall and ranks; it never auto-clears and never auto-blocks on a fuzzy-only match.
- **Plugs into:** The existing `SanctionsScreener` interface via `getSanctionsScreener()` — **zero call-site change** (consumed at `compliance.ts:30-38`, already async, already passes `{name, sourceCountry}` for sender + recipient). `SanctionsHit` gains optional `score/listSource`; grey-band uses `ops.alert` + audited `sanctions.match`.
- **Data:** `baseWatchlist/watchlistExtra`, names already passed to `screen()`, `customers.dateOfBirthEnc/nationality/govIdType` for fielded scoring; real OFAC SDN / UN / EU lists slot into the seam. **Dependencies:** a real list source, model hosting, calibrated thresholds, the eval harness (a recall regression is an AML finding); the grey-band `in_review` routing is net-new (no `in_review` compliance status today). Stays human-approve permanently.

**SAR / suspicious-activity narrative drafting** *(suggest · V3 F3 R4)*
- **Problem:** Authoring a FinCEN SAR Part V narrative is high-effort prose synthesis from scattered ledger + KYC + audit facts, entirely manual.
- **AI approach:** One-shot `chat()` (same rung-1 contract) assembles structured facts into a SAR-style skeleton; suggest-only, DRAFT-watermarked, GUARDRAILS forbid inventing facts or asserting guilt. A human is the legal author/filer.
- **Plugs into:** New `sar-ai.ts`; compliance-gated `/api/copilot/sar-draft`; reads masked by default, decrypted PII only via `getTransferDecrypted` + `pii.reveal` audit.
- **Data:** transfers lifecycle, KYC fields, `kyc_cases.notes`. **Caveats that keep it speculative:** the "typology label" input doesn't exist (depends on the behavioral detector below); the audit "case timeline" needs a new `listBySubject` repo query; SmartRemit is non-custodial and the licensed MTL is the filer — establish regulatory ownership first. Risk 4: a SAR is a federal filing requiring a `pii.reveal` decrypt.

**Adverse-media & PEP enrichment at KYC time** *(human-approve · V4 F3 R3)*
- **Problem:** PEP/adverse-media is captured only as self-declared booleans plus mock flags — there is no actual screening, so a real PEP self-declaring "no" passes silently.
- **AI approach:** At KYC start/approval, retrieve from an adverse-media/PEP source for the audited-decrypted name + nationality, and have an LLM classify and summarize hits into `{pepLikely, adverseMediaCategory, sourceLinks, confidence}` with citations. It **sets a review signal** (flips `pepHit/watchlistHit` → EDD), never auto-approves/rejects KYC.
- **Plugs into:** Strongest at `applyKycEvent` (`kyc-state-machine.ts`), which already writes `watchlistHit=true → needs_review` under a coded "never auto-clear" invariant — an enrichment signal inherits that guarantee structurally. `persona-webhook/route.ts` is the live call site.
- **Data:** `fullNameEnc`, nationality, occupation, `dateOfBirthEnc`; `kyc_cases.notes` to store the summary. **Caveats:** the audited customer-name decrypt is **net-new** (customer reads decrypt without `pii.reveal` audit today); detection power is a paid data vendor (ComplyAdvantage/OpenSanctions) — the AI adds fuzzy resolution + cited summarization, not the lookup. EU AI Act high-risk.

**Cohort & retention insight engine** *(suggest · V4 F5 R2)*
- **Problem:** No retention view exists — analytics is all daily time-series and donuts. "Do month-N customers return in N+1? Does the debit-funded cohort retain better?" is unanswerable today, though every transfer carries `firstSeenAt` + `createdAt`.
- **AI approach:** Deterministic cohort builder computes the retention triangle + repeat-rate + time-to-second-send, sliced by funding method / corridor / partner. One `chat()` call narrates "what changed" from the computed cells; GUARDRAILS + a check that every quoted number maps to a triangle cell prevent invented figures.
- **Plugs into:** New `cohorts.ts` cloning the existing `analytics.ts` + `charts.tsx` pattern (`createScopedStore` + `scoped.listTransfers()`); `dates.ts` `easternMonth()` for bucketing (mind the relative-date fixture gotcha).
- **Data:** `customers.firstSeenAt`, transfers (phone, `createdAt`, `fundingMethod`, `destinationCountry`, status). Clean, low-risk, genuinely AI-shaped narration; weeks of work.

**Sender churn / reactivation scoring + LTV value-tiering** *(suggest · V4 F4 R1)*
- **Problem:** The Customers page already computes per-phone lifetime cents, count, and last-activity — raw RFM sitting unused. Nobody sees who is about to lapse or who will become high-volume.
- **AI approach:** Two **interpretable, arithmetic** scores kept out of any money/compliance path: churn-risk = days-since-last-send / personal median interval (schedules as the cadence prior); a transparent LTV scorecard (cold-start safe, graduates to a learned model behind the same interface). One optional `chat()` call drafts a per-segment "why these customers / what to say" for staff.
- **Plugs into:** New pure `churn-score.ts` + `ltv-score.ts` fed the same `scoped.listTransfers()` array `customers/page.tsx` already builds; a Reactivation column/filter; `deriveTier` reused from `tier-rules.ts`.
- **Data:** transfers history, `schedules.frequency`, `firstSeenAt/optInAt/optedOutAt/lastFundingMethod`. The win is productizing unused RFM (deterministic, auditable); the LLM is only the segment blurb. Churn-score v1 alone is a quick win.

**Natural-language analytics copilot + partner insight narrator** *(suggest · V3 F4 R2)*
- **Problem:** The analytics page is fixed Recharts panels — any question outside them needs an engineer; partners see raw numbers with no interpretation.
- **AI approach:** Constrained text-to-analytics that does **not** touch the DB: the model emits `{metric, dimension, window, filters}` clamped to an allow-list of pre-built aggregations; deterministic code runs the chosen one on masked data; the model narrates the result. Partner "Insights" card computes period-over-period deltas, model writes grounded bullets.
- **Plugs into:** New chat input on `analytics/page.tsx` backed by a route mirroring `draft-reply/route.ts`; aggregations extend `analytics.ts`; tenant isolation via `createScopedStore` (test-pinned).
- **Data:** transfers + customers already loaded server-side, `transfersSummary`, `partner_rates` freshness. Staff NL-Q&A is the real AI value; the partner narrator is closer to rules. Needs a narration-accuracy eval gate + cross-tenant test-pinning.

**Integration-debugging assistant for "401 / my webhook isn't working"** *(suggest · V3 F4 R2)*
- **Problem:** Both inbound seams fail closed with a bare 401 (bad `x-hub-signature-256` / `x-signature`); a partner engineer can't tell wrong-secret from non-raw-body HMAC from clock skew, and support has no diagnostic.
- **AI approach:** A deterministic context-builder (no model in the auth path) assembles configured-vs-blank integration fields, recent success-audit presence/absence, api-key state, and the exact signature recipe; one `chat()` call ranks a plain-English checklist. The model sees only booleans/counts — never secrets.
- **Plugs into:** Integration tab on `partners/[id]/page.tsx`; reads `getIntegrations` + `listByPartner` + api-key `list` (all on-page); new `integration-doctor-ai.ts`.
- **Data:** integration configured-booleans, partner audit stream (`transaction.create/confirm/rates.push` exist), api-key timestamps, the printed HMAC recipe. **Note:** value trimmed (effectively single-tenant "default" partner today — the "#1 onboarding stall" is aspirational); ~70% is a deterministic rules table, AI is the ambiguous-case ranking.

---

## Tier 3 — Strategic Bets (quarters, act-with-review / platform-level)

**Structuring / smurfing & behavioral typology detector over the ledger** *(suggest · V5 F2 R3)*
- **Problem:** AML monitoring is three static rules (≥$1000, ≥5/day, exact watchlist). It misses structuring just under the line, fan-out/fan-in, corridor-hopping, round-number avoidance, and volume spikes vs a customer's own baseline.
- **AI approach:** A scheduled read-only worker: anomaly detection on engineered features + a per-sender sequence model over the ledger; an LLM step **only** labels and explains flagged clusters with a typology + evidence. Output is a ranked Suggested Review; it never touches status.
- **Plugs into:** New cron worker on the existing backbone (`topVelocityToday`, `listByPhone`, monthly-volume store, `eddRequired`); emits `ops.alert`; audited `actor_type='agent'`.
- **Data:** full per-sender ledger history (well-indexed), velocity/volume counters, beneficiaries graph. **Gating:** the headline typologies (structuring-under-$1000, fan-out, corridor-hop) are deterministic SQL and should ship **first** as rules; only the per-customer unsupervised anomaly + narrative genuinely needs ML. Blocked on the unbuilt P1/P2 skeleton (`actor_type='agent'` doesn't exist yet) + a baseline-learning period + eval gate.

**Mule / shared-payout-account graph signal across senders** *(suggest · V4 F2 R2)*
- **Problem:** Each transfer is screened against one sender's velocity; cross-sender mule patterns (N unrelated senders → one payout account, collection rings) are invisible.
- **AI approach:** Graph-anomaly scoring over the sender→recipient→payout-account graph — start with connected-component + centrality, graduate to a lightweight GNN. High-risk structures produce a ranked mule-suspect list as a read-only suggestion; never blocks/clears.
- **Plugs into:** Read-only ops worker; edges from `recipients`, `beneficiaries`, `transfers.payoutDestinationLast4` (no PII decryption for the structural signal); suggestions via `ops.alert`.
- **Data:** recipient/beneficiary edges, masked payout-last4, recipient phones. **Honest gaps:** the starter heuristic ("N senders into one payout account") is deterministic graph SQL; `recipients` has no `partnerId` (scope via transfers); last4 is a collision-prone join key. The AI uplift (GNN, dense-ring) is far and uncertain; depends on the entire unbuilt P1+P2 layer.

**Account-takeover / behavioral-drift detection on the WhatsApp channel** *(human-approve · V3 F3 R3)*
- **Problem:** Once a number is verified, a takeover lets an attacker send to a new recipient/account with no behavioral check — the screen sees only amount + velocity, not "this sender suddenly behaves unlike themselves."
- **AI approach:** A per-customer behavioral baseline (corridors, recipient set, amount band, funding method, time-of-day). A sharp deviation raises a step-up signal (route to `in_review` / re-verify) as an **additive** flag — it raises friction, never auto-declines.
- **Plugs into:** Scored at the `createTransfer` call site alongside `screenTransfer`, reading `listTransfersByPhone` + `listRecipients` + `customer.lastFundingMethod`.
- **Data:** per-customer history, `lastFundingMethod`, saved recipients, velocity. **Caveats:** the headline trigger (new account + max-amount + new funding in one session) is a deterministic rule; the conversational-tone-drift signal is hand-waved (agent-turn rows aren't a queryable corpus); a pre-mint re-verify gate is net-new UX. Modest ML upside; SR 11-7 / EU-AI-Act burden a rules engine avoids.

**Predictive stuck-payment early-warning + FX-drift exposure** *(suggest · V3 F2 R2)*
- **Problem:** All safety nets are threshold tripwires (15m/10m/60m). A transfer that *will* strand is invisible until the hard threshold; locked `fxRate` may have drifted vs live mid on in-flight money with no exposure view.
- **AI approach:** Deterministic core computes leading indicators (per-partner instruct retry rates, paid→delivered latency vs trailing baseline, drift = locked rate vs `getFxRates` mid). One `chat()` call narrates which partner/corridor is degrading + net exposure; clamped `{green/amber/red}`. Never predicts FX or "optimal rate."
- **Plugs into:** Runs beside `reconcileSweep()` in `/api/worker`; an at-risk/exposure panel on `ops/page.tsx`.
- **Data:** outbox instruct history, transfers timestamps/fxRate/amounts, `getFxRates`. **Limits:** outbox has no `partnerId` (jsonb join on an unpruned table); `getFxRates` is hardwired INR-only, so per-corridor drift works only for INR destinations today. The leading-warning value is achievable without an LLM; the defensible AI use is the digest narration.

**Settlement re-instruction draft + validator** *(human-approve · V3 F4 R2)*
- **Problem:** The only auto-recovery for a stuck-paid transfer is one `reinstruct:<id>` enqueue, gated on `providerType`. Harder cases (changed `settlementUrl`, acked-but-unpaid) have no assisted path. This is the documented P3.
- **AI approach:** Rung-2: the agent proposes a `{action, target, rationale}` draft; the money-touching `settlement.instruct` body is built and signed by **existing deterministic code** (`buildSettlementInstruction`); a deterministic validator confirms the transfer is still `paid` + dedupe-key fresh before Approve. The LLM never builds or signs.
- **Plugs into:** Wraps `beginSettlement`'s instruct path + the worker's `settlement.instruct` handler; draft on `ops/page.tsx`; approve is the platform-staff-gated audited action.
- **Data:** transfers lifecycle, instruct history, payment credentials. **Weakness:** the AI content is thin — the deterministic validator + builder + idempotency key do the load-bearing work, and the sweep already auto-resolves the common case. Months of eval-gated effort (exit bar: ≥95% byte-identical drafts) on an unbuilt foundation.

**Knowledge-base RAG: grounded copilot drafts + WhatsApp self-serve deflection** *(suggest · V3 F3 R3)*
- **Problem:** `draftReply()` has no product knowledge (can't state the 24h recall window, KYC timing, corridor payout methods) so staff rewrite heavily; FAQ-class chat questions become tickets.
- **AI approach:** RAG over a curated KB (`docs/*.md` + admin FAQ + later resolved threads) in pgvector on Neon, one retriever feeding two consumers: (1) grounded copilot drafts, (2) a deterministic `answer_support_question` tool that relays retrieved facts in-chat and escalates to the existing `createTicket` path on money/compliance or low confidence.
- **Plugs into:** `draftReply` (add a retrieved-context param — the route already fetches context); new agent tool + dispatch; KB store behind a `getKycProvider`-style seam; `sanitizeReply` protects link integrity.
- **Data:** `docs/*.md`, resolved `ticket_messages`, `partners.supportConfig`, customer masked transfers. **Gaps:** pgvector + embeddings are greenfield (new extension + manual migration + a third model provider) = the "months"; the agent already answers the marquee FAQs deterministically, so incremental deflection is the operational-nuance tail; the "high-rated threads" source needs a CSAT field built first.

**Escalation-risk prediction on the ticket queue** *(suggest · V3 F4 R2)*
- **Problem:** Nothing surfaces which open tickets are heading for trouble; an anxious refund ticket on a paid-but-undelivered transfer sits in the same flat queue as a rates question.
- **AI approach:** LLM-judge over the thread + ticket age + linked-transfer state → a 0-1 risk chip with a short reason. Pure read; a Suggested-Actions-style chip on the queue.
- **Plugs into:** `queue-view.tsx` + `pills.tsx`; joins `ticket_messages`, ticket fields, masked transfer state, `reconcileSweep()` signals; score cached in Redis; `actorType='system'`.
- **Data:** tickets, thread, `audit_events` (`ticket.escalate/resolve` as labels), transfers compliance/status. **Scope down:** the "graduate to a gradient-boosted model" path is speculative (no ML pipeline, rare positive class) — ship the LLM-judge chip (weeks); it must beat a cheap deterministic baseline (age + `waiting_admin` + linked stuck/refund transfer) to justify itself.

**Voice-note send via WhatsApp audio transcription** *(human-approve · V4 F3 R3)*
- **Problem:** The bot is text/button only; the webhook drops audio messages — a real accessibility/conversion gap for the exact demographic this product serves.
- **AI approach:** A multilingual ASR pass transcribes inbound audio to text **before** `runAgentTurn`, so the deterministic agent loop, tools, verify gate, caps, and screening run unchanged on the transcript. The model never "hears" money; the approve card stays the confirmation chokepoint.
- **Plugs into:** Branch on `message.type==='audio'` in the WhatsApp handler, transcribe, then call `runAgentTurn(phone, transcript, turn)`. ASR sits behind an `AsrProvider` factory like the existing provider seams.
- **Data:** the transcript is the `incomingText` argument — no new ledger data. **Corrections:** media-download wiring is net-new (not "existing"); transcribe in the **worker**, not the signature-gated POST handler (preserves the Stage-2c durability design); risk → 3 (biometric-adjacent PII to a third-party ASR ⇒ DPA/retention obligations; needs rate-limiting).

**Eval-harness automation — the missing P1 skeleton** *(suggest · V4 F4 R2)*
- **Problem:** Every autonomy promotion is gated on "a passing eval suite, never on vibes," but it's unbuilt. The two live AI surfaces only have unit tests that **stub** the model — a prompt edit, model swap, or Kimi bump can silently degrade guardrail adherence (e.g. the copilot starting to promise refunds) with nothing to catch it.
- **AI approach:** An LLM-as-judge harness — a curated `{input, rubric}` corpus run through the **real** prompt builders; deterministic checks (URL-strip, clamp, JSON shape) are the hard gate, the judge grades only soft criteria (no refund promises, no compliance detail, no invented facts). Gates the `ci / ci` check; drift dashboard from the `copilot.accept/edit/reject` stream.
- **Plugs into:** New `tests/evals/`; imports the real `ticket-ai.ts`/`prompt.ts` builders; judge via the `chat()` seam; CI gate. **No production path touched.**
- **Data:** real ticket threads, the live GUARDRAILS/prompts, `audit_events` accept/edit/reject as a bootstrap human-agreement signal. **Foundational** — unblocks promoting the fuzzy screener, typology detector, and triage workers off the suggest rung. Risk ~2 (CI-only; keep the judge advisory so a flaky judge can't break CI). Lean version high-value; gold-corpus labeling is real effort.

---

## Recommended First 3

1. **Auto-triage every ticket at creation** — the single highest ROI-per-effort item: days of work, reuses `triageSuggest` + `setTriage` + audit verbatim, zero new model code, zero money/compliance surface, and it improves staff throughput on *every* customer ticket from day one. (Run it out-of-band so it never adds latency to ticket creation.)
2. **KYC review-decision copilot** — pure template reuse (clone `draft-reply/route.ts`), no infra, no migration, mock-data-friendly, and it attacks a real reviewer-consistency problem on a regulated surface. The human-only `review()` invariant is structurally untouched; ship it suggest-only with no auto-apply to keep automation bias in check.
3. **Corridor-demand triage + launch recommender** — turns an inert lead table into the highest-leverage *growth* signal in a remittance network, with the math fully deterministic and the LLM confined to narrating pre-computed numbers. Weeks of work on a page that already exists and is platform-gated.

**Why these three:** all are quick wins (weeks-or-less), all sit at rung-1 suggest-only with low blast radius, each reuses an already-shipped, audited, rate-limited seam, and together they cover the three audiences that matter — support, compliance/risk, and growth — proving the "AI suggests, code decides" pattern before any higher-autonomy bet.

---

## Guardrails (non-negotiables)

- **AI suggests; deterministic code decides money and compliance — forever.** Ledger writes, sanctions block/clear, settlement execution, KYC approval, idempotency/dedup stay deterministic (`docs/AGENTIC-ARCHITECTURE.md` §3). Agents read state and draft proposals; a human or deterministic validator gates every execution.
- **Autonomy is promoted only on a passing eval suite + measured confidence, never "on vibes."** Most agents stop at rung 1-2 by design. Build the eval harness before trusting any score; most "AI" ideas ship their deterministic core first and earn the AI layer only if it beats a rules baseline.
- **KYC and sanctions are human-approval / structurally untoggleable.** Sanctions screening always runs; the AI may only widen recall and rank, never auto-clear or auto-block on a fuzzy match. KYC approval stays a human/Persona decision.
- **Audit everything, mask by default.** Every copilot call is audited (`copilot.*`, new `sanctions.match`/`ops.diagnose`/etc.); reads are the masked ledger by default; decrypted PII only via the explicit `getTransferDecrypted` + `pii.reveal`-audited path. New agent actions land under `actor_type='agent'` (a tracked P1 item) with a Redis kill switch and per-agent budgets.
- **Deliberately not AI / out of scope** (a rule is cheaper, safer, more auditable): un-gated ML transaction-risk score writing a compliance reason on every row; model-suggested EDD/KYC tiering (features only exist post-EDD); Persona field-extraction normalizer (the data isn't captured); rate-competitiveness & "winning-rate" suggestions (scale-invariant arithmetic, already half-shipped); quote-time funding-tier nudge (the product hardcodes the cheapest tier); refund/recall sentiment→severity (duplicates `triageSuggest`, adds a hot-path LLM call); liquidity pre-funding forecast (no pool, out of license); explainable-decline messaging (sanctions tip-off-safety already deterministic); payout-detail validator (already deterministic in `payout-format.ts`, and the destination is the money path).

---

*The pattern is consistent and the spine holds: let deterministic code own the money and the compliance verdict, and point AI at the language-shaped work around it — synthesis, ranking, narration, and fuzzy resolution — eval-gated, audited, and human-approved on the way up the ladder.*
