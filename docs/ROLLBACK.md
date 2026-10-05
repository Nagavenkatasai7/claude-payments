# Rolling back a bad production deploy

One page for the moment something is wrong in production after a merge. Owner's hands: rollback is a production change and needs the owner's go.

## When to roll back

Roll back first and debug after when a merge broke something customers or staff use and the fix is not a one-line revert you can merge in minutes:

- the post-deploy smoke (`smoke.yml`) is red on a step after "Wait until production serves this commit";
- pay page, WhatsApp replies, sign-in or the worker (`GET /api/health` 503) broke right after a deploy;
- errors in Sentry or the ops alerts jumped right after a deploy.

Don't roll back for a red smoke whose only failure is "Production did not serve this commit" (the new build never went live, so there is nothing to undo) or "Prod migrations behind" (apply the migration with `/migrate-prod` instead).

## Before you roll back: the database

A rollback swaps code, never the database. The older build must work with every migration applied since it was live.

- **Additive migrations** (new tables, new nullable or defaulted columns, new indexes) are safe: the older build does not select what it does not know. CI's `migration safety` job only lets additive SQL through unless a file carries a reviewed `-- migration-guard: allow-destructive` marker.
- **A destructive migration since then** (look for that marker in `drizzle/*.sql` newer than the target build): stop. The older build may select a column that no longer exists. Roll forward with a fix instead, or restore the data first (see "Data" below).

Check quickly: `git log --oneline <target-sha>..origin/main -- drizzle/` lists every migration added since the target build.

## How

1. Pick the target: the last production deployment whose smoke run was green (Actions, workflow "Smoke", push runs on main).
2. Vercel dashboard, project `claude-payments`: Deployments, open that production deployment, choose **Instant Rollback** (Pro plan). CLI equivalent: `vercel rollback <deployment-url>`, then `vercel rollback status` (https://vercel.com/docs/cli/rollback).
3. Confirm production serves it: `curl -s 'https://smartremit.ai/api/version?vcrrForceStable=true'` shows the target's short SHA on several calls in a row.
4. Re-run the smoke for that SHA: `gh workflow run smoke.yml -f sha=<target-sha>`.
5. Revert or fix the bad change in a new PR. When it merges, check in Vercel that the new deployment actually went live; if production is still pinned to the rolled-back deployment, use **Promote** on the new one (`vercel promote <deployment-url>`, https://vercel.com/docs/deployments/rollback-production-deployment). *(Whether Vercel pauses auto-promotion after an Instant Rollback was not verified for this project; check the Deployments page.)*

## Data

There is no automatic database rollback. Before a risky migration, create a Neon branch (a point-in-time copy) in the Neon console so there is a restore point. Restoring data is a separate, owner-approved step; never run destructive SQL against production to "undo" a migration in a hurry.

## After

- Record the rollback in the Program Ledger as an `incident` event (`/tracker-sync`).
- Find the root cause, add the failing test, and ship the fix through the normal PR flow.

## Automatic controls (Release safety Batch 2)

These run without a person. They do not replace the steps above.

- **Before release: `release-check`** (`.github/workflows/release-check.yml`). Vercel sends `vercel.deployment.ready` for each production build. The workflow sends one sandbox transfer (the "SmartRemit Synthetic" partner's test key, mock rail only) through the held deployment. With `release-check` in the project's Deployment Checks, a red result keeps the build held and customers stay on the previous build. A failure opens a GitHub issue and sends one ops alert. Nothing is rolled back, because nothing went live.
- **After release: the `rollback` job** (`smoke.yml`). It runs only when the smoke's health step (Neon and Redis through Bearer `/api/health`) or its synthetic transfer step fails on the live build, on a push run. It puts the previous production deployment back through the Vercel API (`scripts/ci/release-guard.mjs`), opens a GitHub issue with both SHAs and sends one ops alert. It refuses when a newer merge is already production. A page-test failure never starts it.
- **After an automatic rollback, Vercel does not promote new production deployments until a person promotes one** (the rolled-back state). Do step 5 above: merge the fix, then **Promote** its deployment.
- **Error watch** (worker, each full run). For the first 15 minutes of a new build, the worker compares its server error count with the previous build's rate. More than 5 errors and more than 3 times the previous rate sends one `deployerrors:<sha>` ops alert. The Bearer `GET /api/health` body shows `buildErrors` for the served build.
- **Kill switches** (`/admin-dashboard/switches`, platform admins). `Pause new sends` and `Pause settlement` stop money movement in 15 seconds without a deploy. Use them while you decide on a rollback.

GitHub settings the automatic controls read: secrets `E2E_SANDBOX_API_KEY`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_ROLLBACK_TOKEN`, `CRON_SECRET`; variables `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`.
