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

**Destructive → confirm the rollout is at 100% first.** Production uses Vercel Rolling Releases: the merge's deployment serves 10% of traffic for 5 min, and the OLD code keeps taking new requests until the rollout auto-promotes to 100%. Before asking for sign-off on anything that rewrites or drops data, confirm ONE of these:
- `curl -s 'https://smartremit.ai/api/version?vcrrForceStable=true'` returns `{"sha":"<first 7 chars of the merge SHA>"}` on several calls in a row;
- the smoke run for the merge SHA passed its "Wait for the rolling release to reach 100%" step;
- the Vercel dashboard (Deployments → Rolling Release) shows the rollout complete.

Use `vcrrForceStable=true`: it forces the pre-rollout base while the rollout is below 100%. A plain `curl` is sticky per client (Vercel hashes client info such as the IP), so it can show the new SHA every time while 90% of traffic still runs old code (https://vercel.com/docs/rolling-releases). Not at 100% → stop and wait. Then add any drain time the migration's own runbook requires (0016: 5 more minutes).

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
