# Operational loops

Bounded, repeatable agent loops for the manual ops work this repo keeps doing by
hand. Each loop is a **feedback system with terminal states** — it observes fresh
state, takes one bounded action, verifies the result, and **stops** (it cannot run
forever). Discovered + audited via the Loop Library / Loop Doctor workflow.

| Loop | Replaces | Authority | Stops when |
|------|----------|-----------|------------|
| [Migration-apply guard](migration-apply-guard.md) | Hand-applying drizzle migrations to prod Neon | **prod write — approval-gated** | applied + verified · none pending (no-op) · destructive SQL or error → ask/stop |
| [Post-merge smoke watch](post-merge-smoke-watch.md) | Manually polling `smoke.yml` after every merge | read-only | smoke run reaches a terminal conclusion · never created (no-progress) |
| [iCloud dup-file sweep](icloud-dup-file-sweep.md) | `find … -delete` for stray `* 2.*` iCloud copies | local file delete (tracked → PR) | swept + build green · none found (no-op) · build breaks → restore + stop |

## How to use
- **Run on demand:** paste a loop's **Prompt** block into a session.
- **Wire to fire automatically:** the smoke-watch and dup-sweep are good Claude Code
  hook candidates (`Stop` / `PostToolUse`) — configure via the `update-config` skill.
  The migration guard writes to prod, so keep it human-triggered + approval-gated.

## The non-negotiable: no loop runs forever
Every loop here has an explicit **no-progress stop** and never retries a failed
action blindly. Polling loops terminate on the watched run's terminal state (plus a
"never appeared" stop); the sweep runs a single pass and stops if a removed file
reappears; the migration guard applies at most once per trigger.
