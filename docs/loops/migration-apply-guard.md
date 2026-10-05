# Migration-apply guard

Before a migration PR merges (from its branch), apply the pending drizzle
migration to prod Neon and verify the altered table answers — then stop. CI's
`migration safety` job keeps the PR red until this is done and only lets
additive SQL through; a step marked `allow-destructive after-deploy` is applied
right after its merge instead (see `.claude/skills/migrate-prod/SKILL.md`). Closes the gap that caused the
2026-06-11 dashboard outage (an unapplied migration → every query on the altered
table 404s).

**Authority:** writes to the production database — **approval-gated.**

### Cycle
1. **Observe** — an open PR adds a file under `drizzle/` and its `migration
   safety` job says production has not applied it (or a merged PR carries an
   `after-deploy` step). Read the pending migration SQL.
2. **Choose / gate** — only auto-apply **additive** SQL (`CREATE TABLE`,
   `ADD COLUMN`, `CREATE INDEX`). If it `DROP`s, `RENAME`s, destructively `ALTER`s,
   or backfills data → **stop and ask** (human review).
3. **Act** — with approval, apply **once**:
   `set -a; source .env.local; set +a; npx drizzle-kit migrate` (idempotent —
   applies only what is pending).
4. **Verify** — run one read against the new table/column on prod (self-contained,
   not dependent on smoke).
5. **Record** — note which migration tag was applied.

### Terminal states
- **No-op** — nothing pending.
- **Success** — applied + the verify query succeeds.
- **Approval-required** — destructive/backfill SQL, or before any prod write.
- **Blocked** — `migrate` errors → surface, **do not retry**.
- Cannot run forever: at most **one apply per trigger**, no retry loop.

### Prompt
> Trigger: an open PR adds a file under `drizzle/` and its `migration safety`
> job is red because production has not applied it (or a merged PR carries an
> `after-deploy` step). Read the pending
> migration SQL first. If it only adds (`CREATE TABLE` / `ADD COLUMN` /
> `CREATE INDEX`), get approval, then apply **once** with
> `set -a; source .env.local; set +a; npx drizzle-kit migrate` (idempotent — applies
> only what is pending) and verify by querying the new table/column once against
> prod. If the SQL drops, renames, destructively alters, or backfills data, stop and
> ask — do not auto-apply. If migrate errors, stop and surface it; do not retry.
> Nothing pending → clean no-op. Never run more than one apply per trigger.
