# Security-invariant audit

A read-only sweep that checks new/changed public surfaces against this repo's
documented spine + security-pack invariants and surfaces violations with file:line
evidence — no auto-fix. Stops after one pass over the changed surfaces.

*Adapts the published **Groundtruth audit loop** (unpublished adaptation).*
**Authority:** read-only (find + report). Fixes are a separate, human-approved step.

### Why
Every feature adds public surfaces that must self-gate: the partner-application flow
needed token re-validation on **3 entry points** (page, action, upload route); server
actions are public POSTs that each must `require*` + validate scope; the
`FIELD_ENCRYPTION_KEY` boot-assert incident showed the assert must *mirror the
accepting code*. These invariants are easy to break silently as surfaces land.

### Cycle
1. **Observe** — the public surfaces changed since the last audit (git diff:
   server actions, `app/api/**/route.ts`, pages reading route params) + the invariant
   checklist.
2. **Choose** — one surface / one invariant.
3. **Act** — none (read-only); emit a finding: pass, or violation + file:line evidence.
4. **Verify** — each finding cites the file:line proving compliance or the gap
   (reproducible, not a vibe).
5. **Record** — audited surfaces + findings (the new "last audited" point).

### The invariant checklist
- Server actions / route handlers **self-gate** (`require*` + scope; route params
  authoritative over body).
- Token-gated public routes **re-validate server-side** (token → not-expired → not-used).
- Money paths use the **PII-scrubbing logger** (`src/lib/log.ts`), not `console`.
- Partner-scoped queries filter by **`partnerId`** (tenant isolation).
- The **boot-assert** lists every secret the accepting code requires (mirror contract).
- Per-IP rate limits on pay/rail/webhook surfaces; HMAC fail-closed on inbound webhooks.

### Terminal states
- **No-op** — every changed surface passes.
- **Success** — findings reported (they hand off to a human fix step).
- Cannot run forever: bounded to the changed-surface set since the last audit;
  one pass; read-only — no fix loop.
- **Separation of duties:** this loop only *finds*; fixing high-impact gaps is a
  separate, reviewed change (the auditor never also approves its own fix).

### Prompt
> On a schedule or before a release, list the public surfaces changed since the last
> audit (server actions, `app/api/**/route.ts`, pages reading route params) via git
> diff. For each, check: the action/route self-gates (`require*` + scope, route-param
> authoritative over body), token-gated routes re-validate server-side, money paths
> use the PII-scrubbing logger, partner-scoped queries filter by `partnerId`, and the
> boot-assert lists every secret the accepting code requires. Report each as pass or
> violation with file:line evidence. All pass → clean no-op. Read-only: surface
> findings for a human to fix; do not edit code.
