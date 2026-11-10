# Rolling back a bad production deploy

One page for the moment something is wrong in production after a merge. Owner's hands: rollback is a production change and needs the owner's go.

## When to roll back

Roll back first and debug after when a merge broke something customers or staff use and the fix is not a one-line revert you can merge in minutes:

- the post-deploy smoke (`smoke.yml`) is red on a step after "Wait until production serves this commit";
- pay page, WhatsApp replies, sign-in or the worker (`GET /api/health` 503) broke right after a deploy;
- errors in Sentry or the ops alerts jumped right after a deploy.

Don't roll back for a red smoke whose only failure is "Production did not serve this commit" (the new build never went live, so there is nothing to undo) or "Prod migrations behind" (the production build applies migrations, `scripts/migrate-on-build.mjs`: read that deploy's Vercel build log for its `migrate-on-build:` lines. An `after-deploy` step is never applied by the build, and a failed apply fails the build, so the old build keeps serving. Apply what is missing with `/migrate-prod` as the fallback, then re-run the smoke).

## Before you roll back: the database

A rollback swaps code, never the database. The older build must work with every migration applied since it was live.

- **Additive migrations** (new tables, new nullable or defaulted columns, new indexes) are safe: the older build does not select what it does not know. CI's `migration safety` job only lets additive SQL through unless a file carries a reviewed `-- migration-guard: allow-destructive` marker, and the production build applies them before the new code goes live.
- **A destructive migration since then** (look for that marker in `drizzle/*.sql` newer than the target build): stop. The older build may select a column that no longer exists. Roll forward with a fix instead, or restore the data first (see "Data" below).

Check quickly: `git log --oneline <target-sha>..origin/main -- drizzle/` lists every migration added since the target build.

## How

1. Pick the target: the last production deployment whose smoke run was green (Actions, workflow "Smoke", push runs on main).
2. Vercel dashboard, project `claude-payments`: Deployments, open that production deployment, choose **Instant Rollback** (Pro plan). CLI equivalent: `vercel rollback <deployment-url>`, then `vercel rollback status` (https://vercel.com/docs/cli/rollback).
3. Confirm production serves it: `curl -s 'https://smartremit.ai/api/version?vcrrForceStable=true'` shows the target's short SHA on several calls in a row.
4. Re-run the smoke for that SHA: `gh workflow run smoke.yml -f sha=<target-sha>`.
5. Revert or fix the bad change in a new PR. When it merges, check in Vercel that the new deployment actually went live; if production is still pinned to the rolled-back deployment, use **Promote** on the new one (`vercel promote <deployment-url>`, https://vercel.com/docs/deployments/rollback-production-deployment). *(Whether Vercel pauses auto-promotion after an Instant Rollback was not verified for this project; check the Deployments page.)*

## Rows a newer build left behind

A rollback also leaves the newer build's outbox rows and audit rows in place. From the partner-assurance PR1 build on, the worker never dead-letters an outbox row whose kind it does not know: it waits (pending, no attempt spent, deferred 5 minutes at a time), and one ops alert per kind per UTC day (`unknownkind:<kind>:<day>`) says rows are waiting. They run as soon as a build that knows the kind is live again, so roll forward to clear them. A build older than PR1 still retries an unknown kind and dead-letters it after 8 attempts; check the dead-letter list after rolling back that far.

PR1 itself adds no outbox kind, no migration and no Redis format. Its new rows are ordinary ones an older build already handles or ignores: `ai.notice_shown` audit rows (the AI notice marker; an older build never reads them and never shows the notice) and `human_help` tickets opened by the HELP keyword (the same tickets the bot's request_human_help tool opens). It also adds the `agent.reply_guard` switch: an older build has no such key, so a `feature_flags` row for it is ignored there (the reply guard and its `replyguard:<tenant>:<hour>` alerts simply stop). To stop the guard replacing replies without a rollback, turn the switch off at `/admin-dashboard/switches`; it goes back to shadow mode (alerts only).

PR1 also ships the READERS of the sealed Redis chat history and pay-link drafts (R49, `src/lib/redis-seal.ts`); it still writes today's plaintext format, and a save drops any sealed copy of the same thread so the newest write wins. The writers come in PR9. Once PR9 is live, an Instant Rollback must stay at PR1 or later: a build older than PR1 cannot read a sealed thread or draft, so those chats would start over and drafts made in the last 30 minutes would expire. Inbound redaction (card, account and ID numbers hidden before they are stored) leaves nothing behind that an older build cannot read: rows hold the `[… hidden]` label as ordinary text, and `turn.redacted` is an optional payload field an older worker ignores.

PR2 (sanctions fail closed on real-money rails) adds migration 0036, which is additive: five nullable columns (customers `screening_flagged_at`, `screening_cleared_at`; sanctions_list_versions `archive_path`, `archive_sha256`, `archived_at`). An older build ignores them, but it behaves as before PR2: its `storeList` prunes whole old list version rows again (the Blob copies under `sanctions-archive/` stay; roll forward to resume the verified archive), it does not enforce the sender screening hold (its partner gates still read the PEP and watchlist booleans, not the `screening_flagged_at` stamp), it lets platform staff release `LIST_UNAVAILABLE` holds by hand again, and it sends no sanctions block notices. It also has no live-list check at settle time, at the instruct or at a release: a paid row the PR2 instruct gate was refusing (an `instructnotlive:<id>` alert) is POSTed to the rail on the older worker's next retry of it, and a release pays out on a screen of any age. Before rolling back past PR2, find the transfers that are still `paid` and have an `instructnotlive:<id>` outbox row, and cancel or refund them first. No build deletes `sanctions-archive/` objects. The `sanctions.block` audit rows and the new ops alerts are ordinary rows an older build ignores. Spec: `docs/compliance/sanctions-screening-spec.md`.

**Rolling back past PR2 after a prune.** Once the PR2 build has archived old list versions and pruned their entries (`pruneArchivedEntries` deletes the entries of archived inactive versions beyond the newest 2 and keeps the version rows), an older build can activate one of those entry-less rows: its `storeList` matches a version by content hash and re-activates the existing row without inserting entries. That happens when OFAC publishes content whose hash equals a pruned version. The older build's `loadList` then throws (`0 entries stored, N expected`), so every instance without a cached list fails closed on every OFAC screen. Before the older build's next list load (the daily cron), do ONE of these: turn `SANCTIONS_LOADER_ENABLED` off for as long as that build serves, or delete the entry-less archived version rows first (`DELETE FROM sanctions_list_versions v WHERE v.active = false AND v.archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sanctions_list_entries e WHERE e.version_id = v.id)`; the Blob copies stay, and the PR2 build does not need those rows back). Rolling forward repairs a pruned version when the PR2 build's `storeList` re-activates it (content seen before, not the active version): it re-inserts the entries. It also repairs a row the older build already made active: the same content again takes the `unchanged` path, which counts that version's stored entries and, when the count differs from the parsed list, re-inserts the entries in the same transaction (review R4, E5). Until that load runs, screens fail closed, and the list health check reports the list as not live (an active version whose stored entries do not match its `entry_count` is not live), so the compliance card shows it and the daily list health alert fires while a partner is on a real-money rail. The roll-forward's next list load (the daily cron, or a manual run) is the repair; no hand re-insert is needed.

## Data

There is no automatic database rollback. Before a risky migration, create a Neon branch (a point-in-time copy) in the Neon console so there is a restore point. Restoring data is a separate, owner-approved step; never run destructive SQL against production to "undo" a migration in a hurry.

## After

- Record the rollback in the Program Ledger as an `incident` note: `node scripts/tracker/note.mjs --kind incident` (`/tracker-sync` Part C). A failed smoke is recorded by the engine on its own.
- Find the root cause, add the failing test, and ship the fix through the normal PR flow.

## Automatic controls (Release safety Batch 2)

These run without a person. They do not replace the steps above.

- **Before release: `release-check`** (`.github/workflows/release-check.yml`). Vercel sends `vercel.deployment.ready` for each production build. The workflow sends one sandbox transfer (the "SmartRemit Synthetic" partner's test key, mock rail only) through the held deployment. With the check `Vercel - claude-payments: release-check` in the project's Deployment Checks (Settings, Build and Deployment), a red result keeps the build held and customers stay on the previous build. A failure opens a GitHub issue and sends one ops alert. Nothing is rolled back, because nothing went live.
- **After release: the `rollback` job** (`smoke.yml`). It runs only when the smoke's health step (Neon and Redis through Bearer `/api/health`) or its synthetic transfer step fails on the live build, on a push run. It puts the previous production deployment back through the Vercel API (`scripts/ci/release-guard.mjs`), opens a GitHub issue with both SHAs and sends one ops alert. It refuses when a newer merge is already production. A page-test failure never starts it. A missing or non-sandbox `E2E_SANDBOX_API_KEY` skips the synthetic step and turns the smoke red, but never starts a rollback.
- **After an automatic rollback, Vercel does not promote new production deployments until a person promotes one** (the rolled-back state). Do step 5 above: merge the fix, then **Promote** its deployment.
- **Error watch** (worker, each full run). For the first 15 minutes of a new build, the worker compares its server error count with the previous build's rate. More than 5 errors and more than 3 times the previous rate sends one `deployerrors:<sha>` ops alert. The Bearer `GET /api/health` body shows `buildErrors` for the served build.
- **Kill switches** (`/admin-dashboard/switches`, platform admins). `Pause new sends` and `Pause settlement` stop money movement in 15 seconds without a deploy. Use them while you decide on a rollback.

GitHub settings the automatic controls read: secrets `E2E_SANDBOX_API_KEY`, `VERCEL_AUTOMATION_BYPASS_SECRET`, `VERCEL_ROLLBACK_TOKEN`, `CRON_SECRET`; variables `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`.

## Ops commands (no Mac needed)

Thread agents act on GitHub as the owner through an App token that cannot re-run, cancel or dispatch workflows (403). Instead, comment on an open issue labelled `ops`, as the owner account, with exactly one of these as the first line:

- `/ops rerun <run id>`: re-run the failed jobs of a run
- `/ops rerun-all <run id>`: re-run every job of a run
- `/ops cancel <run id>`: cancel a run. Runs of smoke.yml and release-check.yml are refused, because they guard production (smoke's rollback job, the pre-release check); the workflow looks the run up first and replies with the refusal
- `/ops smoke` or `/ops smoke <40-hex sha>`: dispatch smoke.yml on main, for the head of main or for that commit (a dispatched smoke never rolls back)

`.github/workflows/ops-commands.yml` reacts with eyes, runs the command with its own `GITHUB_TOKEN` (`actions: write`) and replies with a link to the run, or with the HTTP status if GitHub refused. Anything else on the first line gets a usage reply. The parser is `scripts/ci/ops-command.mjs`. Only comments by `Nagavenkatasai7` with OWNER association, on an open issue (not a pull request) labelled `ops`, are acted on; comments on a closed issue are ignored.
