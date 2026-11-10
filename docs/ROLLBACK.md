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

## Before you roll back: the TGFL custom address

The custom-host PR (`smartremitai.tgfl.org`, CLAUDE.md "Site skins") taught the code that this host is the TGFL skin. An older build parses it as the apex and would serve the staff `/login` and the rest of the apex app on TGFL's address. So, while the domain is attached in Vercel and TGFL's CNAME points at it:

1. **Switch "TGFL demo portal" off first** (`/admin-dashboard/switches`). Within about 15 seconds the custom host answers 404 on every page and API route, and every portal cookie and AI-app refresh token minted there is useless. This covers only cookies and refresh tokens minted on the custom host: whoever controls tgfl.org's DNS can relay a WhatsApp code or TOTP in real time and finish the sign-in on any smartremit.ai host of the tenant, which neither the switch nor the epoch bump revokes (see "Suspected compromise of tgfl.org's DNS" below). Keep the domain **attached**, so no other Vercel account can claim the name.
2. **Ask TGFL to delete the CNAME** for `smartremitai.tgfl.org`. Confirm it is gone: `dig +short CNAME smartremitai.tgfl.org` prints nothing. Only then remove the domain in Vercel (Settings, Domains). Never detach while the CNAME is live: a detached domain with a live CNAME may be claimed by another Vercel account (the owner confirms against Vercel's current domain rules).
3. **Only after step 2**, Instant Rollback or revert to a build older than the custom-host PR. If TGFL cannot be reached, do not detach and do not roll back past that PR: stay on step 1 and roll forward with a fix.

A rollback to a build that still has the custom-host code needs none of this. Never remove a host from `SITE_SKINS.<slug>.hosts` while its CNAME may point at Vercel, for the same reason. The PR adds no migration, so a revert is safe for the data.

### After attaching smartremitai.tgfl.org

Order: the custom-host PR is merged and its `smoke.yml` run is green; Vercel env has `APP_BASE_URL=https://smartremit.ai`; the switch "TGFL demo portal" is on; the domain is added in Vercel (Production, no redirect); TGFL adds the CNAME (and the `_vercel` TXT if asked; a CAA record, if any, must allow Vercel's CA) and Vercel shows "Valid Configuration" with a certificate. Then check each line for the stated status. No automated smoke covers this host, so these checks are the only proof that the staff app is not served on TGFL's address:

- `curl -sI https://smartremitai.tgfl.org/login` → 404; the same for `/admin-dashboard`, `/account`, `/pay/x`, `/docs` and `/api/worker`.
- `curl -sI -H 'Host: SMARTREMITAI.TGFL.ORG' https://smartremitai.tgfl.org/login` → 404; the same for `/admin-dashboard` and `/api/worker`.
- `curl -sI https://smartremitai.tgfl.org./login` (trailing dot) → 404; the same for `/admin-dashboard` and `/api/worker`.
- `curl -sI https://smartremitai.tgfl.org/` → 307 to `/portal/login`.
- `curl -s https://smartremitai.tgfl.org/.well-known/oauth-authorization-server | jq .issuer` → `"https://smartremitai.tgfl.org"`.
- `curl -sI -X POST https://smartremitai.tgfl.org/api/mcp` → 401 with `resource_metadata="https://smartremitai.tgfl.org/..."`.
- Switch off: within about 15 s `/portal/login` → 404. Switch back on.
- Walk through in a browser: sign in on the custom host, TGFL header, "Ways to send" card, connector box with the custom address; the same cookie does not sign you in on `tgfl.smartremit.ai`.
- Record a baseline, and re-run it after any TGFL DNS change: `dig +short CNAME smartremitai.tgfl.org` and the certificate issuer (`openssl s_client -connect smartremitai.tgfl.org:443 -servername smartremitai.tgfl.org </dev/null | openssl x509 -noout -issuer`).

If any staff route answers anything but 404 on the custom host, switch off at once and follow the rollback order above.

### Suspected compromise of tgfl.org's DNS or registrar

1. Switch "TGFL demo portal" off at once (domain stays attached).
2. Scope the window from `audit_events`: every phone with a `login_success` or an `agent.grant.created` row on ANY host during the window. Do not rely on `meta.host = 'smartremitai.tgfl.org'` alone: a relayed code finishes the sign-in on a smartremit.ai host and its row carries that host.
3. For each of those phones, end all its portal sessions (`getPortalSessionStore().revokeAll(partnerId, phone)`, the same call the Devices page's "sign out everywhere" uses) and revoke its AI-app grants (`revokeCustomerGrant` / `revokeGrant` in `src/db/repos/agent-oauth-repo.ts`). Revoking a grant also ends its access tokens at once (the live-grant check).
4. Before turning the switch on again, merge a PR that bumps `SITE_SKINS.tgfl.credentialEpoch`. It orphans every session and refresh token minted on the custom host, but AI-app access tokens are not epoch-bound and live up to `AGENT_ACCESS_TTL_SEC` (1 h): keep the switch off for at least 1 h after step 1 even once the bump is merged, unless step 3 revoked those grants. Sessions orphaned by the bump stay listed on the customer's Devices page as dead entries until their 30-day idle timeout; they cannot be used.

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
