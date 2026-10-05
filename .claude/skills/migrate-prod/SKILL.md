---
name: migrate-prod
description: Apply pending drizzle migrations to production Neon (manual by design) — read-only status first, additive-only gate, explicit confirmation, ONE apply, then a verify query. User-invoked only; writes to the production database.
argument-hint: "[--dry-run]"
disable-model-invocation: true
---
# /migrate-prod — apply pending drizzle migrations to prod Neon

Prod migrations are MANUAL (CLAUDE.md gotcha; 2026-06-11 outage). This skill is the only sanctioned way to run them. It encodes docs/loops/migration-apply-guard.md. Authority: **writes to the production database**. Follow the steps in order; never retry an apply.

**When:** normally BEFORE the merge, from the PR's branch. CI's `migration safety` job keeps a PR that adds a migration red until production has applied it, and it only lets additive SQL through, which is safe to apply while the current build still serves. So: check out the PR branch (`git fetch origin <branch> && git checkout <branch>`), run this skill, then re-run the PR's failed `migration safety` job and merge. The exception is a file marked `-- migration-guard: allow-destructive after-deploy <reason>`: run this skill from main right AFTER that merge is live (step 2).

## 1. Ground truth first (read-only)
```
set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migration-status.ts
```
Prints every journal tag as APPLIED / PENDING by comparing `drizzle/meta/_journal.json` with `drizzle.__drizzle_migrations`. Nothing PENDING → report "no-op" and stop. A "journal and DB have diverged" note → stop and surface it; do not apply.

## 2. Classify the pending SQL
`cat drizzle/<tag>.sql` for each PENDING tag. **Additive** = only `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`, `CREATE [UNIQUE] INDEX`, `ADD CONSTRAINT`. Anything with `DROP`, `RENAME`, `ALTER COLUMN … TYPE`, `DELETE`, `UPDATE`, `TRUNCATE`, or a data backfill is **destructive** → print those statements verbatim and require the user to type explicit sign-off before step 4. If `$ARGUMENTS` contains `--dry-run`, stop after this step and report.

**Destructive → check the timing first.** A destructive step carries an `allow-destructive` marker reviewed in its PR. Without `after-deploy` it was meant to run before the merge (e.g. widening a CHECK); check that the live build works with it before sign-off. With `after-deploy`, the OLD build may still use what it removes, so before asking for sign-off confirm ONE of these:
- `curl -s 'https://smartremit.ai/api/version?vcrrForceStable=true'` returns `{"sha":"<first 7 chars of the merge SHA>"}` on several calls in a row;
- the smoke run for the merge SHA passed its "Wait until production serves this commit" step;
- the Vercel dashboard (Deployments) shows the merge SHA as the current production deployment.

Rolling Releases are OFF (checked 2026-10-05). `vcrrForceStable=true` keeps the check correct if they are turned back on: it forces the pre-rollout base while a rollout is below 100% (https://vercel.com/docs/rolling-releases). Not live → stop and wait. Then add any drain time the migration's own runbook requires (0016: 5 more minutes).

## 3. Confirm
State: the exact tags to apply, the tables/columns each touches, and that drizzle-kit connects with `DATABASE_URL_UNPOOLED` from `.env.local` (see drizzle.config.ts). Ask: "Apply these N migration(s) to prod now?" — wait for a yes.

## 4. Apply once
```
set -a; source .env.local; set +a; npx drizzle-kit migrate
```
On error: quote the full error, do **not** re-run, stop. A partial apply is the user's decision.

## 5. Verify
Re-run step 1 (every tag must now be APPLIED), then read from each altered table:
```
set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migration-status.ts --check "SELECT <new_column> FROM <table> LIMIT 1"
```
Quote the output. A failing SELECT here means the app is about to break on that table — say so loudly.

## 6. Record
Report tags applied + verify output. Before a merge: re-run the PR's failed `migration safety` job (it must turn green), and the PR is ready for the owner's merge go. After a merge (an `after-deploy` step): run /post-merge-check (smoke on main must be green).
