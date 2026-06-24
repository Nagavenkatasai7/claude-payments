# Operational loops

Bounded, repeatable agent loops for the manual ops work this repo keeps doing by
hand. Each loop is a **feedback system with terminal states** — it observes fresh
state, takes one bounded action, verifies the result, and **stops** (it cannot run
forever). Discovered + audited via the Loop Library / Loop Doctor workflow.

### Operational (the manual ops cadence)
| Loop | Replaces | Authority | Stops when |
|------|----------|-----------|------------|
| [Migration-apply guard](migration-apply-guard.md) | Hand-applying drizzle migrations to prod Neon | **prod write — approval-gated** | applied + verified · none pending (no-op) · destructive SQL or error → ask/stop |
| [Post-merge smoke watch](post-merge-smoke-watch.md) | Manually polling `smoke.yml` after every merge | read-only | smoke run reaches a terminal conclusion · never created (no-progress) |
| [iCloud dup-file sweep](icloud-dup-file-sweep.md) | `find … -delete` for stray `* 2.*` iCloud copies | local file delete (tracked → PR) | swept + build green · none found (no-op) · build breaks → restore + stop |

### Lifecycle · CI/CD · security (adapted from published Loop Library loops)
| Loop | Closes | Authority | Stops when |
|------|--------|-----------|------------|
| [Release-gate integrity audit](release-gate-integrity-audit.md) | `strict=false` / `--admin` merge-gate bypass left un-restored | read-only; restore → **approval-gated** | protection intact + all recent merges green (no-op) · red merge → blocked |
| [Dependency-CVE burndown](dependency-cve-burndown.md) | `npm audit` gate fails but never fixes (e.g. nodemailer HIGH) | dep change → **PR** | none high/critical (no-op) · unfixable → parked + skipped |
| [Flaky-test stabilizer](flaky-test-stabilizer.md) | CI retry masking "flake accumulation" | edits tests → **PR** | consecutive-pass streak holds · couldn't reproduce (no-progress) |
| [Security-invariant audit](security-invariant-audit.md) | New public surfaces silently skipping self-gate / spine invariants | read-only (find + report) | every changed surface passes (no-op) · one pass over changed surfaces |

## How to use
- **Run on demand:** paste a loop's **Prompt** block into a session.
- **Wire to fire automatically:** the smoke-watch and dup-sweep are good Claude Code
  hook candidates (`Stop` / `PostToolUse`) — configure via the `update-config` skill.
  The migration guard writes to prod, so keep it human-triggered + approval-gated.

## The non-negotiable: no loop runs forever
Every loop has an explicit **no-progress stop** and never retries a failed action
blindly. Polling loops terminate on the watched run's terminal state; single-pass
sweeps/audits are bounded to a fixed set (changed surfaces, a merge window) and stop
when it's exhausted; the burndown processes one item per cycle and parks-and-skips
anything unfixable so every cycle makes progress; the flaky stabilizer reproduces
within a bounded budget and gates on a finite consecutive-pass streak.
