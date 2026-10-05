---
name: post-merge-check
description: After a PR merges to main, gate on pending migrations, then watch the production deploy's post-deploy smoke.yml run for that SHA and report green/red with the failing job. Use right after any merge to main, or when asked "did the deploy go through?". Read-only on GitHub (gh reads); finishes with /tracker-sync.
argument-hint: "[PR number | merge SHA]"
---
# /post-merge-check — verify a merge to main landed safely

Encodes the CLAUDE.md rule "check the smoke.yml run on main after every merge" and docs/loops/post-merge-smoke-watch.md. Read-only; the only write it can trigger is handing off to /migrate-prod.

**One deploy at a time.** Don't merge the next PR to main until this merge's smoke run has finished, so each deploy is tested on its own. Rolling Releases are OFF (Vercel project config `null`, checked 2026-10-05), so a deploy takes all traffic as soon as it is ready. If they are ever turned back on, a merge that lands mid-rollout builds but is **not promoted** ("The active rolling release must be resolved (either completed or aborted) before starting a new one", https://vercel.com/docs/rolling-releases#starting-a-rolling-release).

## 1. Resolve the merged SHA
- PR number in `$ARGUMENTS`: `gh pr view <n> --json mergeCommit,state,title,mergedAt` → use `.mergeCommit.oid`; if state ≠ MERGED, stop and say so.
- A SHA: use it. Nothing: `git fetch -q origin && git rev-parse origin/main`.

## 2. Migration gate (before anything else)
```
git fetch -q origin; git diff --name-only <sha>~1..<sha> -- drizzle/ src/db/schema.ts
```
Non-empty → the PR's `migration safety` CI job should have confirmed before the merge that production already applied each new migration (CLAUDE.md "Migrations are MANUAL, applied BEFORE the merge"). Check it: the smoke's migration step below fails if prod is behind. A migration marked `-- migration-guard: allow-destructive after-deploy` is the exception: tell the user to run `/migrate-prod` NOW (it is user-invoked) and wait for it.

## 3. Find the smoke run for that SHA
The push to main creates the run **immediately** (within seconds of the merge), so look it up straight away:
```
gh run list --workflow=smoke.yml --branch main --event push --limit 10 --json databaseId,headSha,status,conclusion,url,createdAt
```
and take the entry with `headSha == <sha>`. Poll every 30 s for up to 2 min. Still no run → stop and report "smoke never triggered". Check the Actions tab for a disabled workflow or an outage, and check whether the merge commit message holds `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` or a `skip-checks: true` trailer: GitHub then skips push-triggered runs. Start it by hand with `gh workflow run smoke.yml -f sha=<sha>`.

While Rolling Releases were on (from 2026-09-21), Vercel posted no GitHub `deployment` / `deployment_status` records for production builds. Production records are back (e.g. bd58f9a, checked 2026-10-04), but the push run is still the one to read; never treat a missing deployment record as "Vercel did not deploy". To check what production serves, use `curl -s 'https://smartremit.ai/api/version?vcrrForceStable=true'`.

Other runs you may see for the same SHA:
- `deployment_status` (fallback; fires only if Vercel posts a Production deployment event): it waits behind the push run, then runs no test and repeats the push run's verdict. The push run is the one to read.
- `workflow_dispatch` (a manual re-run): in `gh run list`, its `headSha` is the head of the branch it was dispatched from, **not** its `sha` input. Its run title reads `Smoke <sha> (workflow_dispatch)`.

## 4. Watch to completion
`gh run watch <databaseId> --exit-status`.

The run starts at merge time. Its step "Wait until production serves this commit" covers the Vercel production build (~3–6 min): it polls `https://smartremit.ai/api/version?vcrrForceStable=true` until 12 consecutive polls report the merge SHA, and only then runs the migration check and Playwright. **Expect a run of ~3–8 min** (452ca7c took 3 min). It gives up after 25 min (job timeout 38 min). Don't read a long run as a hang.
- success → report green with the run URL. A green run also means production serves this SHA.
- failure at **"Wait until production serves this commit"** (its error is titled "Production did not serve this commit", after 25 min) → Playwright never ran, so this is **not** a test failure and **not** proof the code works. The causes: the Vercel build failed or is still queued, or a newer production deployment replaced it (or, if Rolling Releases were turned back on, an earlier rollout was still active, or this one is paused, aborted or rolled back). Check Vercel → Deployments. Report it as "deploy not live", not "smoke red".
  - Once this SHA is live, re-run with `gh workflow run smoke.yml -f sha=<sha>` (then find it with `gh run list --workflow=smoke.yml --event workflow_dispatch --limit 3`), or with `gh run rerun <databaseId>`. If a newer merge replaced it, that SHA's smoke run is the one that counts.
- failure at any other step → `gh run view <databaseId> --log-failed | tail -80`, name the failing step/spec and the assertion, and stop. Do not merge anything else on top until it is fixed (propose the fix as a new PR).

## 5. Update the Program Ledger
Run `/tracker-sync` (green or red): the merge, the smoke result and any fix-status change go to the ledger artifact. A red smoke is recorded as an `incident` event.

## 6. Report
SHA · migration gate result · smoke run URL + conclusion · failing spec (if red) · ledger synced.
