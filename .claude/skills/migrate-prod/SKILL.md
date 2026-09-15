---
name: migrate-prod
description: Apply pending drizzle migrations to production Neon (manual by design) — read-only status first, additive-only gate, explicit confirmation, ONE apply, then a verify query. User-invoked only; writes to the production database.
argument-hint: "[--dry-run]"
disable-model-invocation: true
---
# /migrate-prod — apply pending drizzle migrations to prod Neon

Prod migrations are MANUAL (CLAUDE.md gotcha; 2026-06-11 outage). This skill is the only sanctioned way to run them. It encodes docs/loops/migration-apply-guard.md. Authority: **writes to the production database**. Follow the steps in order; never retry an apply.

## 1. Ground truth first (read-only)
```
set -a; source .env.local; set +a; node_modules/.bin/tsx scripts/migration-status.ts
```
Prints every journal tag as APPLIED / PENDING by comparing `drizzle/meta/_journal.json` with `drizzle.__drizzle_migrations`. Nothing PENDING → report "no-op" and stop. A "journal and DB have diverged" note → stop and surface it; do not apply.

## 2. Classify the pending SQL
`cat drizzle/<tag>.sql` for each PENDING tag. **Additive** = only `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`, `CREATE [UNIQUE] INDEX`, `ADD CONSTRAINT`. Anything with `DROP`, `RENAME`, `ALTER COLUMN … TYPE`, `DELETE`, `UPDATE`, `TRUNCATE`, or a data backfill is **destructive** → print those statements verbatim and require the user to type explicit sign-off before step 4. If `$ARGUMENTS` contains `--dry-run`, stop after this step and report.

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
Report tags applied + verify output, then run /post-merge-check (smoke on main must be green).
