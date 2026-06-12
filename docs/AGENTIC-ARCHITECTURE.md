# SmartRemit — Agentic Architecture Proposal

> Decision document: how to "make the whole system agentic" without ever putting an
> LLM inside the money path. Written 2026-06-11 against the live codebase
> (total-platform program PRs #53–#77; best-rate foundation PR #89). Status:
> **proposal — the build starts only after the owner reviews and approves this
> document.**

---

## 1. Executive recommendation

Three decisions, in order of how much they matter:

**1. Keep the customer chat exactly as built.** The WhatsApp bot is already the
right agentic pattern: a single agent (`src/lib/agent.ts`) driving ~17 deterministic
tools (`src/lib/tools.ts` — `get_quote`, `create_transfer`, `check_send_limit`,
`send_approve_picker`, `repeat_transfer`, schedule tools, …) inside a bounded loop
(`MAX_TOOL_ROUNDS = 6`). Every money-adjacent tool re-checks caps, the KYC gate, and
sanctions **server-side**; the model can never bypass policy. `sanitizeReply()`
strips every model-written URL and appends only code-generated payment links
(typo-squat defense). Each turn is itself a durable outbox row (`agent.turn` in
`src/lib/outbox-worker.ts`), so an Ollama outage retries instead of eating the
customer's message. Anthropic's own guidance ("Building Effective Agents") is that
the simplest composable pattern that works wins — this one works. Do not replace it
with a multi-agent topology; there is nothing to gain and a regression surface to
lose.

**2. Money paths stay deterministic forever.** Ledger writes
(`src/lib/transfer-create.ts`), sanctions screening (`src/lib/compliance.ts` —
structurally untoggleable), settlement (`src/lib/settlement.ts` — the
`beginSettlement()` single-transaction commit), claim-first idempotent minting
(`src/lib/pay-finalize.ts`, `idempotency_keys` PK `(partner_id, key)`), and the
outbox/worker delivery engine are code, not prompts. No phase of this proposal puts
an LLM in the write path of any of them. An agent may **read** their outputs and
**draft** inputs to them; a deterministic, human-gated handler is the only thing
that ever executes.

**3. The new agentic value is a supervisor–worker ops layer on top.** SmartRemit
already emits the perfect event stream for it: the outbox kinds
(`settlement.instruct`, `rail.callback`, `ops.alert`, dead letters) and
`reconcileSweep()` / `getOpsSnapshot()` (`src/lib/reconcile.ts`) are the event
backbone agents subscribe to — nothing new to build there. A supervisor agent
routes incidents to narrow worker agents: **reconciliation triage**,
**compliance-alert triage**, **stuck-transfer diagnosis**, a **partner onboarding
copilot**, and **anomaly detection**. Each agent climbs an **autonomy ladder** —
*suggest → human-approve → act-with-review → act* — per risk class, gated on
measured confidence and a passing eval suite, never on vibes. Most agents stop at
rung 1 or 2 permanently; that is the design, not a limitation.

---

## 2. Orchestration patterns compared

| Pattern | What it is | Fintech fit | Cost | Resilience | Verdict for SmartRemit |
|---|---|---|---|---|---|
| **Single agent + deterministic tools** | One LLM loop, code-enforced tools | Excellent for conversational front doors; policy lives in code | Low (one model call chain) | Good when each turn is durable (ours is — `agent.turn` outbox rows) | **Keep** — this is the customer chat today (`src/lib/agent.ts`) |
| **Supervisor–worker hierarchy** | A router agent dispatches narrow specialist agents; results funnel back through one gate | The production-dominant pattern in financial services; clean blast-radius boundaries per worker | ~60% of single-large-agent baseline token cost at ~98% accuracy in financial-document benchmarks (arXiv 2603.22651) — narrow contexts are cheaper *and* more accurate | Strong: a misbehaving worker is suspended without touching siblings | **Adopt** for the ops layer |
| **Event-driven agents** | Agents subscribe to a stream and react autonomously | Good telemetry fit, but uncontrolled fan-out and no natural human gate | Unbounded without budgets | Failure loops are easy to create (alert → action → alert) | Use the *trigger* (our outbox/sweep events) but route through the supervisor, never direct-act |
| **Durable-workflow engine + LLM steps** (Temporal-style) | Deterministic workflow spine; LLM calls as individual retried steps | Exactly right for money movement — which is why we already built it: the outbox + worker + `reconcileSweep()` **is** a durable workflow engine | n/a (already paid) | The strongest of all — replay-safe, idempotent, dead-letter alerting | **Keep as the execution substrate**; agents *suggest* steps, the engine runs them |
| **Reflexive / self-correcting agents** | Agents critique and re-plan their own outputs in open loops | Collapses at scale: self-critique compounds errors, costs balloon, and there is no audit-able decision point for a regulator | Highest, unbounded | Worst — failure modes are emergent | **Reject** |

Why supervisor–worker beats "more deterministic rails" for the ops layer: the work
is *diagnosis* — correlating a dead-lettered `settlement.instruct` row with a
partner's webhook history, a stuck-`paid` transfer, and a config change — which is
exactly the cross-document reasoning LLMs are good at and exhaustive `if/else`
rails are terrible at. The benchmark result above (narrow workers ≈ 60% of the
token cost at ≈ 98% accuracy vs. one giant context) plus the production case
studies (Stripe, Ramp, Klarna all converged on routed specialists with human
gates on money actions) make this the lowest-risk, highest-leverage shape.

---

## 3. Where agents add value — and where determinism is non-negotiable

### Tier 1 — first agents (read-heavy, human-gated)

| Agent | Reads | Produces | Gate |
|---|---|---|---|
| **Reconciliation triage** | `getOpsSnapshot()` / `reconcileSweep()` outputs (`src/lib/reconcile.ts`): dead letters, stuck-`paid` >15 min, stale `in_review` >24h; outbox attempt history; partner integration state | A root-cause analysis + a **suggested re-instruction** (the same deduped `settlement.instruct` enqueue `reconcileSweep` already performs) | Human clicks Approve in `/admin-dashboard/ops` (`src/app/admin-dashboard/ops/`); the existing audited Retry action executes |
| **Compliance-alert triage** | The `in_review` queue (`screenTransfer()` outcomes in `src/lib/compliance.ts`: `flagged` reasons — large amount, velocity), customer tier/history, corridor rules | A drafted disposition memo (release/reject + reasoning) attached to the queue item | The analyst decides on `/admin-dashboard/compliance`; the agent never releases anything |
| **Stuck-transfer diagnosis** | Transfer timeline, outbox rows, webhook receipt log, rail config | A diagnosis narrative ("partner's `settlementUrl` started 404ing at 14:02; last good callback …") | **Read-only, always** — output is text |

### Tier 2 — second wave (still read-only or draft-only)

| Agent | Scope |
|---|---|
| **Partner config copilot** | Walks a new partner's integration state (the `/admin-dashboard/partners/[id]` tabs + `partner_integrations`), spots gaps (missing webhook secret, unverified Meta number), drafts the go-live checklist. Suggest-only. |
| **Anomaly flagging** | Watches aggregates the dashboards already compute (volume, corridor mix, velocity leaderboards) for distribution shifts; emits `ops.alert`-style notices. Read-only. |

### Never agentic — structurally, not by policy

| Surface | Why | Enforced where |
|---|---|---|
| **Ledger writes** | A hallucinated state flip is unrecoverable money truth | `src/lib/transfer-create.ts`, `src/db/repos/transfer-repo.ts` — no agent tool will ever wrap these |
| **Sanctions greenlisting** | Screening is structurally untoggleable today (`screenTransfer()` has no off switch); an agent that can say "not a match" reintroduces the toggle | `src/lib/compliance.ts` — keep as-is |
| **Settlement execution** | `beginSettlement()`'s one-transaction commit + outbox determinism is the whole durability story | `src/lib/settlement.ts`, `src/lib/outbox-worker.ts` |
| **KYC approval** | Regulated verdict; Persona or partner attestation, never a model | `src/lib/kyc-state-machine.ts`, persona webhook |
| **Idempotency / dedup** | Claim-first minting and dedupe keys are correctness invariants, not judgment calls | `src/lib/pay-finalize.ts`, `idempotency_keys` |

The dividing rule, stated once: **agents read state and draft proposals; only
deterministic, already-audited code paths mutate money state — and a human (or a
capped, eval-passing policy) stands between every proposal and its execution.**

---

## 4. Guardrail stack (fintech-grade, all phases)

- [ ] **Tool allow-lists per agent**, Zod-validated arguments — same discipline as
  `toolSchemas` in `src/lib/tools.ts`; an agent literally cannot name a tool
  outside its registry entry.
- [ ] **Deterministic validators wrap every agent output that touches money**: a
  suggested re-instruction is replayed through the same checks
  `reconcileSweep()` applies (webhook-driven rail? still stuck? not already
  re-instructed?) before it is even *shown* to a human.
- [ ] **Idempotency keys on any agent-suggested action** — reuse the existing
  dedupe-key pattern (`reinstruct:{id}`); an approved suggestion executed twice
  is a no-op by construction.
- [ ] **Budgets + circuit breakers**: per-agent token/spend caps, step caps,
  latency caps; >N tool calls/min trips a breaker that suspends the agent and
  emits an `ops.alert` outbox row (the existing alert channel).
- [ ] **Kill switch, <30s**: a Redis-backed flag checked at every agent
  invocation (flips instantly via the shared `getRedis()` client — Vercel env
  vars need a redeploy, so env is the boot-level override, Redis is the runtime
  switch; mirrors the `src/lib/boot-assert.ts` posture).
- [ ] **Full audit trail per decision**: every agent suggestion, the evidence it
  cited, the human verdict, and the executed action land in `audit_events`
  (`src/lib/audit-log-store.ts`) — the same append-only table that already
  records `pii.reveal`. `actor_type` gains an `agent` value.
- [ ] **Eval suite + regression harness BEFORE every autonomy promotion**: a
  frozen incident corpus (replayed `getOpsSnapshot` states with known-correct
  dispositions); promotion to the next ladder rung requires a passing run, in
  CI, like any other merge gate.
- [ ] **Drift monitoring**: weekly eval re-runs against fresh incidents;
  agreement-with-human-rate per agent dashboarded; a drop demotes the agent one
  rung automatically.
- [ ] **Confidence-threshold escalation**: below-threshold outputs route to a
  human with the agent's uncertainty stated, never silently dropped or silently
  acted on.
- [ ] **SR 11-7 model-risk alignment**: an **agent inventory** (registry of every
  agent, version, model, autonomy rung, owner), independent validation before
  production, ongoing monitoring, and documented governance — agents are models
  under SR 11-7 and get the same treatment as a credit model would.
- [ ] **EU AI Act awareness**: AML/fraud-adjacent agents will likely classify as
  high-risk systems; design for the obligations now (logging, human oversight,
  accuracy metrics, technical documentation — arXiv 2604.04604's compliance
  architecture is the template) rather than retrofitting.
- [ ] **Data minimization**: agents see **masked** PII by default — the
  field-crypto pattern already does this (`****last4` reads;
  `getTransferDecrypted` is explicit and audited). An agent needing a full value
  is a design smell; if ever justified, it goes through the same audited-reveal
  path as staff.

---

## 5. Phased roadmap (each phase independently shippable)

| Phase | Ships | Autonomy | Exit criteria |
|---|---|---|---|
| **P1 — Foundation** | Agent registry (the SR 11-7 inventory), Redis kill switch + env override, per-agent observability (tokens, latency, tool calls, outcomes), the eval harness skeleton, and an **MCP server exposing the EXISTING partner-API/admin tool surface** (`/api/partner/v1/*`, `getOpsSnapshot`, transfer reads) — read-only tools, no new capabilities | **None** — infrastructure only | Registry + kill switch tested; MCP tools callable; eval harness runs in CI |
| **P2 — Ops triage agents** | Reconciliation triage + stuck-transfer diagnosis + compliance triage as **read-only** workers behind a supervisor; a **Suggested Actions** queue on `/admin-dashboard/ops` — humans read, humans execute via the existing audited actions | Rung 1: *suggest* | ≥90% human-agreement on the eval corpus; zero unsafe suggestions in review |
| **P3 — Settlement suggestions** | The triage agent **drafts** the re-instruction (pre-validated, idempotency-keyed); a human clicks Approve; the deterministic outbox executes it | Rung 2: *human-approve* | Drafts are byte-identical to what the human would have built in ≥95% of approvals |
| **P4 — Autonomy ladder** | Low-risk, high-confidence classes (e.g. re-instructing a stuck simulator-rail transfer under a daily cap) auto-execute with post-hoc review; everything else stays gated | Rung 3: *act-with-review*, confidence-gated, capped | Breaker + demotion telemetry proven; one full quarter of rung-2 data |
| **P5 — Partner copilot + anomaly detection** | Tier-2 agents: onboarding copilot (suggest-only) and anomaly flagging (read-only alerts) | Rungs 1–2 | Same eval-then-promote loop |
| **P6 — (optional, regulatory-driven)** | Formal verification of compliance invariants — encode "sanctions screening always runs", "no transfer skips the ledger" as machine-checked properties (Lean-4 type-checked guardrails, arXiv 2604.01483) | n/a | Only if a regulator or major partner requires it |

**Explicit decision checkpoint: nothing in P1 is built until the owner has
reviewed this document and approved the direction.**

---

## 6. Sources

1. Anthropic — *Building Effective Agents* (simple composable patterns over
   frameworks; workflows vs. agents distinction).
2. Anthropic — *Measuring AI Agent Autonomy* (autonomy-ladder framing;
   promotion only on measured evidence).
3. Anthropic — Claude for Financial Services announcement (production finance
   agents ship with human gates and narrow scopes).
4. arXiv 2603.22651 — multi-agent financial-document benchmark
   (supervisor–worker at ~60% of baseline token cost, ~98% accuracy; reflexive
   architectures degrade at scale).
5. arXiv 2604.01483 — Lean-4 type-checked compliance guardrails (formal
   verification of regulatory invariants around LLM systems).
6. arXiv 2604.04604 — EU AI Act compliance architecture for agentic systems
   (high-risk classification of AML/fraud agents; oversight + logging design).
7. LangGraph vs. Temporal durable-execution comparisons (why a deterministic
   workflow spine should own execution while agents own judgment — the
   architecture our outbox/worker already implements).
8. Stripe, Ramp, Klarna production agent case studies (routed specialist
   agents, human approval on money actions, kill switches as table stakes).
9. Federal Reserve SR 11-7 — *Guidance on Model Risk Management* (model
   inventory, independent validation, ongoing monitoring, governance).
