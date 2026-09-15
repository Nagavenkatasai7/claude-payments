<!-- Generated 2026-09-15 by the phase0-whole-branch-review workflow (18 reviewer agents, 3-refuter panel per finding; 39 verifier agents were blocked by the auto-mode classifier, so borderline findings may be missing). Follow-up PRs: #246 js-yaml, #247 trace artifacts, #248 this doc set. -->

# Phase 0 Whole-Branch Review — SmartRemit

**Scope:** #237, #243, #242, #245, #241 (merged to `main` @ `e0271c2`); #244 open.

## 1. Verdict

**PR #244 — safe to merge, with one hard precondition.** The diff does exactly what it claims: deletes the literal credential fallbacks, replaces them with a fail-loud `requireEnv`, and adds a regression guard. Nothing on a money path changes. The precondition is operational, not code: `E2E_USERNAME` / `E2E_PASSWORD` do not exist as repo secrets, so `smoke.yml` and the nightly `prod-smoke` job go red at spec-load time the moment this lands. Create both secrets and complete the Task 4 account rotation **in the same sitting as the merge**. (`preview-smoke.yml` is unaffected — its gate job skips for want of `VERCEL_AUTOMATION_BYPASS_SECRET`.)

**Phase 0 is not closable yet.** Three items remain open after #244 merges: (a) the admin account is still unrotated, and the password is permanently in public git history, so deletion alone closes nothing; (b) `docs/AUDIT-2026-09-14.md` still publishes enough hash/length/count material to reconstruct that credential independently of the specs; (c) the nightly `audit` job stays red on `js-yaml`, so the signal Phase 0 was meant to restore is still masked. Close Phase 0 only after rotation is verified against production, the audit doc is scrubbed, and one clean nightly run is green.

## 2. Confirmed findings

| Sev | File:line | Finding | Fix |
|---|---|---|---|
| Critical | `tests/e2e/dashboard-smoke.spec.ts:5`, `support-smoke.spec.ts:10` | Live platform-admin credential committed in a public repo; missing secrets mean the fallback is what CI actually used against prod | Merge #244, **rotate the account** (seed does not rewrite an existing row), add both secrets |
| High | `scripts/outbox-status.ts:83` | Omits the sweep's 4th state (`awaiting_payment` + `funding_ref`), then prints "nothing needs a human" while customers sit charged | Add the `listAwaitingWithFunding` section to `needsHuman`; PGlite test pinning sections to `SweepResult` |
| High | `docs/AUDIT-2026-09-14.md:2466-2473` | SHA-1 prefix + exact HIBP count + length + username defeat the doc's own masking | Drop prefix/count/length (also `:2381`, `:4900`, `:89/98`) |
| High | `.claude/hooks/verify-on-stop.sh:16` | Gate skipped on a committed tree; `--changed --passWithNoTests` passes vacuously on untested code | Diff against `origin/main` merge-base; block when a changed `src/lib`/`scripts` file selects zero specs (vitest forces `passWithNoTests` with `--changed`) |
| Medium | `.claude/hooks/guard-git-main.sh:25` | `git push origin 'main'`, `eval`, `bash -c`, `$(…)` all bypass; `git checkout main && git push origin HEAD` bypasses (`:26`) | Tokenize the segment; carry branch state across segments; add `Bash(git push:*)` to `permissions.ask`. GitHub branch protection (enforce_admins) is the real gate — correct CLAUDE.md:57/105 |
| Medium | `.claude/settings.json:128` | Prefix rules miss `git push origin X --force`, `-f`, `--force-with-lease`, `+ref` — `component/*` anchors rewritable | Detect force anywhere in a tokenized `git push` segment inside the hook |
| Medium | `.claude/hooks/guard-git-main.sh:24` | False-positives on quoted text: read-only greps and PR bodies containing "git push" are denied | Same tokenization fix; split on operators outside quotes only |
| Medium | `.claude/hooks/verify-on-stop.sh:14` | `[ -x …/tsc ] || exit 0` silently disables the gate on a fresh clone/worktree | Block with an explicit "toolchain missing" reason when `changed` is non-empty |
| Medium | `.claude/hooks/icloud-dup-sweep.sh:25` | Unconditional `rm -rf` on a name-only heuristic at SessionStart; `Chapter 2.md` reproduced as a false positive | Require size/content corroboration; report-only by default |
| Medium | `.github/workflows/nightly.yml:49` | `js-yaml` 4.3.1 keeps the full-tree audit red (verified on run at `e0271c2`) | `npm update js-yaml` (range `^4.1.1` admits 4.3.2) |
| Medium | `.github/workflows/ci.yml:69` | Blocking audit still inside the single required `ci` job — next advisory merge-locks main again | Parallel non-required job, or `--audit-level=critical` + scheduled high job |
| Low | `.gitignore:1` | `node_modules.nosync` covered only by machine-local `.git/info/exclude` | Add `node_modules*` |
| Low | `.claude/hooks/icloud-dup-sweep.sh:26` | Prune misses the symlink target; walks ~39.9k dep paths | Prune `./node_modules.nosync`; fix the line-9 comment |
| Low | `tests/no-hardcoded-credentials.test.ts:10` | Fixed two-path list, one syntactic shape; bracket access/destructuring defaults pass | `readdirSync` over `tests/e2e/`; widen pattern (keep the non-empty-literal requirement) |
| Low | `tests/e2e/dashboard-smoke.spec.ts:30` | Credential-free landing test no longer loads locally without env | Resolve `requireEnv` lazily inside `loginAs` |
| Low | `.github/workflows/smoke.yml:41` | Playwright traces store `fill()` values verbatim; uploaded as public-repo artifacts (live artifact confirmed) | Strip `*.zip` before upload or drop trace upload on prod smoke |

## 3. Carry into Phase 1

1. Rotate + verify the admin account; delete the stale one; then scrub the audit doc.
2. `outbox-status.ts` parity test — the only finding touching money-path observability.
3. Hook hardening batch: tokenizing `guard-git-main.sh`, force-push detection, `verify-on-stop` merge-base + coverage assertion, `icloud-dup-sweep` prune and dry-run default. Commit a `tests/hooks/` matrix — none of the five hooks has a single test.
4. CI topology: audit out of the required job; `js-yaml` bump; `permissions: contents: read` pinned in `ci.yml`/`smoke.yml`.
5. Trace-artifact redaction; `.gitignore` one-liner; widen the credential regex guard.

## 4. What was reviewed

Five merged PRs plus one open one were read as a single branch of work: the tooling/hooks/skills bundle (#237), the dependency-bump-to-unblock-CI change (#243), the funding-webhook HMAC carve-out removal (#242), the `node_modules.nosync` tooling excludes (#245), and the audit/spec/plan documentation drop (#241), against #244's credential removal. Every finding was executed rather than argued: hooks were driven directly with `PreToolUse` payloads under `GUARD_BRANCH_OVERRIDE`, the sweep's false positive was reproduced in a scratch git tree, `npm audit` was run against the PR's own lockfile, a real published Playwright trace artifact was downloaded and parsed, and branch protection, repo visibility and the actual secret inventory were read from the GitHub API. A three-lens refuter panel then ran on each candidate; 16 findings survived and 18 were refuted or downgraded — notably the `.env` read-deny claim (empirically blocked), the `SELECT … INTO` and `provider !== 'mock'` items (real but pre-existing, already tracked as authz-08), and several PR attributions that turned out to be main-state rather than diff defects. Severities here reflect the panel's corrections, chiefly that server-side branch protection backstops every local git-hook bypass.
