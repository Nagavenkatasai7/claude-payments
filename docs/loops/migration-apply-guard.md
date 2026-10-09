# Migration-apply guard

The Vercel production build applies normal migrations itself
(`scripts/migrate-on-build.mjs`: additive and reviewed-before-deploy SQL,
before `next build`; a failed apply fails the build). This loop covers what the
build does not apply: a step marked `allow-destructive after-deploy`, applied
right after its merge is live, and a migration the build could not apply (see
`.claude/skills/migrate-prod/SKILL.md`). Closes the gap that caused the
2026-06-11 dashboard outage (an unapplied migration → every query on the altered
table 404s).

**Authority:** writes to the production database — **approval-gated.**

### Cycle
1. **Observe** — a merged PR carries an `after-deploy` step (its production
   build logged `after-deploy migration <tag> waits for a manual apply`), or a
   production build failed with `migrate-on-build: error`, or the smoke reports
   "Prod migrations behind". Read the pending migration SQL.
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
> Trigger: a merged PR carries an `after-deploy` step, or the production
> build could not apply a migration (`migrate-on-build: error` in its Vercel
> build log, or the smoke reports "Prod migrations behind"). Read the pending
> migration SQL first. If it only adds (`CREATE TABLE` / `ADD COLUMN` /
> `CREATE INDEX`), get approval, then apply **once** with
> `set -a; source .env.local; set +a; npx drizzle-kit migrate` (idempotent — applies
> only what is pending) and verify by querying the new table/column once against
> prod. If the SQL drops, renames, destructively alters, or backfills data, stop and
> ask — do not auto-apply. If migrate errors, stop and surface it; do not retry.
> Nothing pending → clean no-op. Never run more than one apply per trigger.
