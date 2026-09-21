---
name: post-merge-check
description: After a PR merges to main, gate on pending migrations, then watch the production deploy's post-deploy smoke.yml run for that SHA and report green/red with the failing job. Use right after any merge to main, or when asked "did the deploy go through?". Read-only on GitHub (gh reads); finishes with /tracker-sync.
argument-hint: "[PR number | merge SHA]"
---
# /post-merge-check — verify a merge to main landed safely

Encodes the CLAUDE.md rule "check the smoke.yml run on main after every merge" and docs/loops/post-merge-smoke-watch.md. Read-only; the only write it can trigger is handing off to /migrate-prod.

## 1. Resolve the merged SHA
- PR number in `$ARGUMENTS`: `gh pr view <n> --json mergeCommit,state,title,mergedAt` → use `.mergeCommit.oid`; if state ≠ MERGED, stop and say so.
- A SHA: use it. Nothing: `git fetch -q origin && git rev-parse origin/main`.

## 2. Migration gate (before anything else)
```
git fetch -q origin; git diff --name-only <sha>~1..<sha> -- drizzle/ src/db/schema.ts
```
Non-empty → tell the user to run `/migrate-prod` NOW (it is user-invoked) and wait for it. Until then the deploy serves code that selects columns prod does not have.

## 3. Wait for the smoke run for that SHA
Poll every 30 s, up to 15 min:
```
gh run list --workflow=smoke.yml --branch main --limit 10 --json databaseId,headSha,status,conclusion,url,createdAt
```
until an entry has `headSha == <sha>`. The run is created by Vercel's `deployment_status` event, so nothing for the first 3–5 min is normal. After 15 min with no run → stop and report "smoke never triggered"; check whether Vercel deployed at all: `gh api "repos/Nagavenkatasai7/claude-payments/deployments?sha=<sha>"`.

## 4. Watch to completion
`gh run watch <databaseId> --exit-status`.

Production uses Vercel **Rolling Releases** (10% for 5 min, then auto 100%). The run starts when the deployment is Ready, i.e. at the START of the rollout, so its step "Wait for the rolling release to reach 100%" polls `https://smartremit.ai/api/version?vcrrForceStable=true` until 12 consecutive polls report the merge SHA, and only then runs Playwright. **Expect a run of up to ~10 min** (about 6–7 min waiting, then the tests). Don't read a long run as a hang.
- success → report green with the run URL. A green run now also means the rollout reached 100%.
- failure at **"Wait for the rolling release to reach 100%"** (its error is titled "Rolling release did not reach 100%", after 15 min) → Playwright never ran, so this is **not** a test failure and **not** proof the code works. Production did not serve this SHA to every client. The rollout is paused, aborted or rolled back, or another production deployment is queued ahead of it or replaced it. Check Vercel → Deployments → Rolling Release. Once this SHA serves 100%, re-run the job with `gh run rerun <databaseId>`. If a newer merge replaced it, that SHA's smoke run is the one that counts. Report it as "rollout incomplete", not "smoke red".
- failure at any other step → `gh run view <databaseId> --log-failed | tail -80`, name the failing step/spec and the assertion, and stop. Do not merge anything else on top until it is fixed (propose the fix as a new PR).

## 5. Update the Program Ledger
Run `/tracker-sync` (green or red): the merge, the smoke result and any fix-status change go to the ledger artifact. A red smoke is recorded as an `incident` event.

## 6. Report
SHA · migration gate result · smoke run URL + conclusion · failing spec (if red) · ledger synced.
