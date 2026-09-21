---
name: post-merge-check
description: After a PR merges to main, gate on pending migrations, then watch the production deploy's post-deploy smoke.yml run for that SHA and report green/red with the failing job. Use right after any merge to main, or when asked "did the deploy go through?". Read-only on GitHub (gh reads); finishes with /tracker-sync.
argument-hint: "[PR number | merge SHA]"
---
# /post-merge-check — verify a merge to main landed safely

Encodes the CLAUDE.md rule "check the smoke.yml run on main after every merge" and docs/loops/post-merge-smoke-watch.md. Read-only; the only write it can trigger is handing off to /migrate-prod.

**One rolling release at a time.** Never merge the next PR to main while a rolling release is active. Wait for this merge's smoke run: once its "Wait for the rolling release to reach 100%" step passes, the rollout is at 100%. Vercel does not change production while a rollout is in progress: "The active rolling release must be resolved (either completed or aborted) before starting a new one" (https://vercel.com/docs/rolling-releases#starting-a-rolling-release). A merge that lands mid-rollout still builds, but it is **not promoted**.

## 1. Resolve the merged SHA
- PR number in `$ARGUMENTS`: `gh pr view <n> --json mergeCommit,state,title,mergedAt` → use `.mergeCommit.oid`; if state ≠ MERGED, stop and say so.
- A SHA: use it. Nothing: `git fetch -q origin && git rev-parse origin/main`.

## 2. Migration gate (before anything else)
```
git fetch -q origin; git diff --name-only <sha>~1..<sha> -- drizzle/ src/db/schema.ts
```
Non-empty → tell the user to run `/migrate-prod` NOW (it is user-invoked) and wait for it. Until then the deploy serves code that selects columns prod does not have.

## 3. Find the smoke run for that SHA
The push to main creates the run **immediately** (within seconds of the merge), so look it up straight away:
```
gh run list --workflow=smoke.yml --branch main --event push --limit 10 --json databaseId,headSha,status,conclusion,url,createdAt
```
and take the entry with `headSha == <sha>`. Poll every 30 s for up to 2 min. Still no run → stop and report "smoke never triggered". Check the Actions tab for a disabled workflow or an outage, and check whether the merge commit message holds `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` or a `skip-checks: true` trailer: GitHub then skips push-triggered runs. Start it by hand with `gh workflow run smoke.yml -f sha=<sha>`.

Since Rolling Releases were enabled (2026-09-21), Vercel posts no GitHub `deployment` / `deployment_status` records for production builds: `gh api repos/Nagavenkatasai7/claude-payments/deployments` lists only Preview records after 6269fda, although production serves 2365627. Do not wait for a `deployment_status` run, and do not treat a missing production deployment record as "Vercel did not deploy". To check what production serves, use `curl -s 'https://smartremit.ai/api/version?vcrrForceStable=true'`.

Other runs you may see for the same SHA:
- `deployment_status` (fallback; fires only if Vercel posts a Production deployment event): it waits behind the push run, then runs no test and repeats the push run's verdict. The push run is the one to read.
- `workflow_dispatch` (a manual re-run): in `gh run list`, its `headSha` is the head of the branch it was dispatched from, **not** its `sha` input. Its run title reads `Smoke <sha> (workflow_dispatch)`.

## 4. Watch to completion
`gh run watch <databaseId> --exit-status`.

The run starts at merge time. Its step "Wait for the rolling release to reach 100%" covers the Vercel production build (~3–6 min) AND the Rolling Release (10% for 5 min, then auto 100%). It polls `https://smartremit.ai/api/version?vcrrForceStable=true` until 12 consecutive polls report the merge SHA, and only then runs Playwright. **Expect a run of ~10–15 min**: about 1 min of install, 9–12 min of waiting, then the tests. It gives up after 25 min (job timeout 32 min). Don't read a long run as a hang.
- success → report green with the run URL. A green run also means the rollout reached 100%.
- failure at **"Wait for the rolling release to reach 100%"** (its error is titled "Rolling release did not reach 100%", after 25 min) → Playwright never ran, so this is **not** a test failure and **not** proof the code works. Production did not serve this SHA to every client. The causes: the Vercel build failed or is still queued; the rollout is paused, aborted or rolled back; or another production deployment is queued ahead of it or replaced it. **The most common cause: an earlier rolling release was still active, so this deploy was built but not promoted.** Check Vercel → Deployments (build state) → Rolling Release. Report it as "rollout incomplete", not "smoke red".
  - **Deploy not promoted** (this SHA is Ready but is not the canary or current production): the owner either promotes it from the Deployments page (Promote), which starts its own rolling release, or merges nothing until the active rollout resolves. Don't stack another merge on top.
  - Once this SHA serves 100%, re-run with `gh workflow run smoke.yml -f sha=<sha>` (then find it with `gh run list --workflow=smoke.yml --event workflow_dispatch --limit 3`), or with `gh run rerun <databaseId>`. If a newer merge replaced it, that SHA's smoke run is the one that counts.
- failure at any other step → `gh run view <databaseId> --log-failed | tail -80`, name the failing step/spec and the assertion, and stop. Do not merge anything else on top until it is fixed (propose the fix as a new PR).

## 5. Update the Program Ledger
Run `/tracker-sync` (green or red): the merge, the smoke result and any fix-status change go to the ledger artifact. A red smoke is recorded as an `incident` event.

## 6. Report
SHA · migration gate result · smoke run URL + conclusion · failing spec (if red) · ledger synced.
