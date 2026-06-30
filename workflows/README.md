# Overnight loop workflows (ultracode dynamic workflows)

Three bounded, unattended loops implemented as **dynamic Workflow scripts** (fan-out
subagents) and run nightly by **scheduled cloud routines**. Each leaves a **morning
artifact** (a PR or a report PR) and **never writes to prod or auto-merges**. See the
loop definitions in [`../docs/loops/`](../docs/loops/).

| Script | Loop | Run (ET, nightly) | Authority | Morning artifact |
|--------|------|-------------------|-----------|------------------|
| `overnight-bug-hunt.mjs` | Edge-case bug hunt | 1:00 AM | PR | fix PR (or clean no-op) |
| `claims-vs-code-audit.mjs` | Claims-vs-code audit | 2:30 AM | read-only | report PR |
| `prod-health-triage.mjs` | Production-health triage | 4:00 AM | read prod (SELECT-only) + PR | **⛔ DISABLED 2026-06-29** (kill-switch; role dropped) — fix PR + ops-flag report when enabled |

## How they run
A scheduled cloud routine (Anthropic infra — runs while you sleep, independent of
your laptop) fires at each time and invokes the script via the Workflow tool, e.g.
`Workflow({ scriptPath: "workflows/overnight-bug-hunt.mjs" })`. Each script:
observes a **fixed target set** → fans out finder agents → **adversarially verifies**
every finding → produces the artifact. Bounded by the target set + verify gate, so a
run terminates; nothing is auto-merged.

## prod-health-triage is DISABLED (2026-06-29)
Turned off at the user's request via a `DISABLED` kill-switch at the top of
`prod-health-triage.mjs` (the nightly schedule still fires but the run is a clean
no-op), and the SELECT-only `smartremit_readonly` Neon role it used was **dropped**.
To **re-enable**: flip `DISABLED = false`, recreate a SELECT-only Neon role, and set
its connection string as `DATABASE_URL_READONLY` on the nightly routine. When enabled
it reads `process.env.DATABASE_URL_READONLY` (a role that physically cannot write); if
that secret is unset the loop also returns a clean no-op.

## Not linted / not built
`workflows/**` is eslint-ignored and `.mjs` (outside tsconfig's `**/*.ts`), so these
Workflow-runtime scripts (`agent()`, `phase()`, `parallel()`, `pipeline()` globals)
never break the app gate. They are invoked only by the Workflow tool.
