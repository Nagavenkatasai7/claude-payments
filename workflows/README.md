# Overnight loop workflows (ultracode dynamic workflows)

Three bounded, unattended loops implemented as **dynamic Workflow scripts** (fan-out
subagents) and run nightly by **scheduled cloud routines**. Each leaves a **morning
artifact** (a PR or a report PR) and **never writes to prod or auto-merges**. See the
loop definitions in [`../docs/loops/`](../docs/loops/).

| Script | Loop | Run (ET, nightly) | Authority | Morning artifact |
|--------|------|-------------------|-----------|------------------|
| `overnight-bug-hunt.mjs` | Edge-case bug hunt | 1:00 AM | PR | fix PR (or clean no-op) |
| `claims-vs-code-audit.mjs` | Claims-vs-code audit | 2:30 AM | read-only | report PR |
| `prod-health-triage.mjs` | Production-health triage | 4:00 AM | read prod (SELECT-only) + PR | fix PR + ops-flag report |

## How they run
A scheduled cloud routine (Anthropic infra — runs while you sleep, independent of
your laptop) fires at each time and invokes the script via the Workflow tool, e.g.
`Workflow({ scriptPath: "workflows/overnight-bug-hunt.mjs" })`. Each script:
observes a **fixed target set** → fans out finder agents → **adversarially verifies**
every finding → produces the artifact. Bounded by the target set + verify gate, so a
run terminates; nothing is auto-merged.

## prod-health-triage needs a read-only DB secret
It reads `process.env.DATABASE_URL_READONLY` — a **SELECT-only** Neon role (it
physically cannot write). Create the role and set the secret on the routine before
enabling that loop; if the secret is unset the loop returns a clean no-op. The role
SQL is in the PR that introduced these workflows.

## Not linted / not built
`workflows/**` is eslint-ignored and `.mjs` (outside tsconfig's `**/*.ts`), so these
Workflow-runtime scripts (`agent()`, `phase()`, `parallel()`, `pipeline()` globals)
never break the app gate. They are invoked only by the Workflow tool.
