---
name: tracker-sync
description: Push the current program state to the SmartRemit Program Ledger artifact with the automated, append-only engine (scripts/tracker/sync.mjs). Reads GitHub and the ledger database; writes new PR, PR-state, fix-state and event docs, the session journal, and meta/state (main SHA, CI, smoke, what production serves). Use when the ledger-sync-due Stop hook asks, after every merge (called by /post-merge-check), after a verification run, when a plan is approved, at the start of a session, or when asked to update the tracker. The same procedure is the cloud routine's prompt.
argument-hint: "[--corpus] [note about what changed]"
---
# /tracker-sync — keep the Program Ledger true

Ledger: https://claude.ai/artifact/7wD2psZ6fndztDjwZC3oNZ (private to the owner). The database is the source of truth for status; the repo holds the tooling. Scratch dir below = this session's scratchpad (`/tmp/...` in the cloud routine).

**Engine:** `scripts/tracker/sync.mjs` (pure logic in `sync-core.mjs`, tested in `tests/tracker-sync-core.test.ts`). It supersedes `snapshot.mjs`, which stays in the repo but is no longer part of this procedure.

## Truth rules (non-negotiable)
- A fix is `done` only with **all three**: its PR(s) merged, the post-deploy smoke green on a SHA that contains them, and verification evidence for the finding (a live probe, a test that reproduces the finding now passing, or a Chrome check). Write that evidence into `evidence` in one or two sentences.
- Merged but not yet verified → `merged`. PR open → `in_review`. Branch with commits → `in_progress`. Plan approved and task written → `planned`. Otherwise `open`.
- Never mark `done` from a PR title or description alone. Never lower a `done` without writing an `incident` event that says why.
- No secrets, tokens or unmasked phone numbers/names in any document.

The engine enforces the automatable part: it writes `in_review` (open PR with `Program-Fix: <n>`) and `merged` (merged PR), never `done`, and never a status lower than the fix already has (open < planned < in_progress < in_review < merged < done). `done` is yours to write, by hand, with evidence (section 6).

**The ledger is the program's system of record (owner direction 2026-09-21).** Every action, decision and approval is recorded, in the same turn as the action:
- Agent launches and finishes (one start row and one finish row per agent the main thread launches) and `gh pr merge|close` commands are journaled by hooks automatically (`.claude/hooks/ledger-journal.mjs`). The Agent prompt is never logged.
- Owner decisions and approvals given in chat: append them at once, one line each:
  ```
  node scripts/tracker/journal.mjs add --kind approval --actor owner --title "Owner approves the Wave 2 plan" --detail "In chat, plan p1-w2 v3" --refs '{"plan":"p1-w2"}'
  ```
  Kinds: decision | approval | agent | plan | review | pr | merge | deploy | migration | owner-step | verify | milestone | incident | security. Actors: owner | claude | agent | github | ci. Results: ok | blocked | failed | running | info. Refs: `{fix:[n], pr:[n], plan:"p1-w2", sha:"abc1234"}`. Titles plain and specific; no secrets, phone numbers or names (text is scrubbed anyway).
- Every plan lives in `plans` (schema: `scripts/tracker/PLAN-SCHEMA.md`) and is updated whenever the plan changes (section 7).

**Always run the engine, even after a hand-written fix or event update.** Only the engine refreshes `meta/state` (main SHA, CI, smoke, what production serves); skipping it leaves the status strip and the "Needs attention" list stale (2026-09-16: a 'smoke pending' incident stayed up for 3 hours after it went green).

## Procedure (identical in a session and in the cloud routine)
ArtifactData, url = the ledger, throughout.

1. **Dump the database.** Start from an empty `<scratch>/ledger-db` (`rm -rf` it first). `list` with `out_dir: <scratch>/ledger-db` for `prs` (limit 1000), `prstate` (1000), `fixstate` (1000), `events` (1000) and `fixes` (100). Page with `query.cursor` while a result has `next_cursor`. A missing collection is fine (the first write creates it).
2. **meta/state and its version.** `get` meta/state **with** the same `out_dir` (the engine keeps every key it does not own from that file) and note the `version` in the result text → V. The saved file has no version; it is only in the result. If meta/state does not exist, V = 0.
3. **Run the engine.**
   - Session: `node scripts/tracker/sync.mjs --db <scratch>/ledger-db --state-version V --by session --out <scratch>/ledger-sync --journal ~/.smartremit-ledger/journal.ndjson` (`--journal-from` defaults to the `flushed` marker).
   - Cloud routine: the same with `--by cloud` and no `--journal`.
   It reads GitHub with curl (locally with `gh auth token`, passed on stdin; in the cloud with no header, so the egress proxy authenticates it) and prints one line: `{mainSha, ci, smoke, prodServes, newDocs, batches, warnings, newOffset}`. It writes `batch-N.json` files and the doc files beside them. Running it twice against the same dump yields only the meta/state write.
4. **Write.** For each `batch-N.json` in order: ArtifactData `batch` with its entries as `writes`. Every entry is a `set`: new docs carry no version; meta/state is **alone in the last batch** and carries `if_version: V`.
   - `version_mismatch` on meta/state (someone wrote it in between): repeat step 2, re-run step 3 with the new V into a fresh `--out`, and send **only the last batch** (the earlier ones are already applied).
   - `version_mismatch` on any other entry (another writer created that doc between your list and your write; batches are all-or-nothing): repeat from step 1.
   - Never drop `if_version` to force a write.
5. **Close out (session only).** After every batch succeeded: `node scripts/tracker/journal.mjs mark-flushed <newOffset> --main-sha <mainSha>` with both values from the summary. This moves the journal marker and writes `~/.smartremit-ledger/last-sync.json`, which the Stop hook compares with `origin/main`. Report the summary line. Do not claim the page updated without the write results.

## 6. Hand-written status (done, and anything the engine cannot see)
- **done:** `set` a NEW doc `fixstate/fix-NN-done-<sha7 of the verified deploy>` = `{fix, status: "done", at, prs, mergeSha, source: "verification", evidence}`. Until the page overlays `fixstate`, also `update` `fixes/fix-NN` (`status`, `evidence`, `updatedAt`) pinned with its `if_version`.
- `in_progress` / `planned` (no PR yet): `set` `fixstate/fix-NN-<status>-<short ref>` with `source: "session"`.
- Phase state (plan approved, first fix merged, all fixes done): `update` `phases/phase-N` (`status`, `note`), pinned.
- Backlog items (`backlog/<key>`): set `status: "done"` when closed, with a one-line `detail`, pinned.
- Timeline rows go through the journal (`journal.mjs add`), not direct event writes.

## 7. Plans (`plans/<id>`: p0, p1-w1…p1-wN, p2, p3, p4)
- When a plan is written or revised, update its doc (`planVersion` +1, `updatedAt`, items) and journal a `plan` row.
- On approval: set `approval: {state: "approved", at, by: "owner", ref}` and `status: "approved"`, and journal an `approval` row.
- When a fix in a plan opens a PR, merges or is verified, update that item's `status` together with the fix.
- Working copies: `~/dev/program-ledger/plans/*.json`. Every write is pinned with `if_version`.

## 8. Library refresh (only with `--corpus`, or when a doc it indexes changed: the audit, security results, spec, phase plans, verification records, COMPONENTS/architecture docs, blueprint data)
```
python3 scripts/tracker/build-corpus.py "$PWD" <scratch>/ledger-corpus [docs/superpowers/plans/<phase plan>.md ...]
```
Send every `batch-N.json` it prints with ArtifactData `batch`. If `corpusParts` shrank, `delete` the stale `corpus/part-NNN` docs. Run it from the checkout that holds the git-ignored `CLAUDE-SECURITY-*/` results.

## What the engine writes (append-only, deterministic ids)
| Doc | When | Fields |
|---|---|---|
| `prs/pr-<n>` | first time a program PR (#237+, not dependabot, not `loop/`) is seen among the 60 most recently updated | `number, title, url, createdAt, fix` |
| `prstate/pr-<n>-<open\|merged\|closed>` | each state a PR reaches (the page takes the latest) | `number, state, at, mergeSha, fix` |
| `fixstate/fix-NN-<in_review\|merged>-<pr<n>\|sha7>` | open / merged PR with `Program-Fix` (or the legacy map) | `fix, status, at, prs, mergeSha, source: "github"` |
| `events/gh-pr-open-<n>`, `gh-merge-<n>`, `gh-pr-closed-<n>` | PR opened / merged / closed unmerged | `at, kind, actor: github, title, detail, refs, result, source` |
| `events/gh-ci-<runId>` | failed push CI run on main | kind `incident` |
| `events/gh-smoke-<runId>` | completed push Smoke run on main | success → `verify`; failure → `incident` |
| `events/j-<sha1(line)[0:16]>` | each journal line | as journaled, `source: "journal"` |
| `meta/state` (overwrite, `if_version`) | every run | `mainSha, ciMain, smokeMain, smokeNote, prodServes, prodServesNote, prodDeploy, openPrs, syncedAt, syncedBy, program, currentPhase` + every other existing key |

`prodServes` = mainSha when the latest push-triggered Smoke run for it succeeded (the smoke waits until production's `/api/version` reports the commit, so success proves production serves it); otherwise the newest sha with a successful push Smoke, with a note. Only push runs count: a `workflow_dispatch` run's `head_sha` is the dispatching branch's head, not the commit under test. Hand-written or `snapshot.mjs` events for the same PR merge / open / smoke are recognized by title, so the first run does not duplicate them.

## Hooks (`.claude/settings.json`; fields per https://code.claude.com/docs/en/hooks.md)
- `PostToolUse` matcher `Agent` and matcher `Bash`, and `SubagentStop` → `ledger-journal.mjs`. Main thread only: input with `agent_id` (a subagent's own tool call) is skipped. A main-thread Agent launch is recorded by `tool_response.agentId` in `~/.smartremit-ledger/agents.json` and journaled as "Agent started: <description>". `SubagentStop` journals "Agent finished: <description>" (first 280 scrubbed chars of `last_assistant_message`) only for the first stop of a recorded agent; later stops only update its stored last message, and unknown `agent_id`s (nested helpers, Claude Code's internal agents, which stop with an empty `agent_type`) are skipped. A foreground Agent (`status: "completed"`) gets both rows from its PostToolUse, since its SubagentStop fires first. `agents.json` is updated under a lock (a stale lock is renamed aside; a holder removes the lock only if its inode and owner token still match), after the journal row is appended, and pruned (finished > 24 h, unfinished > 7 days). Text is scrubbed (phones incl. bare 10+ digit numbers, emails, API keys incl. `sk-ant-`, AWS key ids, JWTs, bearer tokens) in both the journal and `agents.json`. Always exits 0.
- `Stop` → `ledger-sync-due.mjs` (beside the tsc/eslint/vitest gate). It blocks once (never while `stop_hook_active`) when (c) an unflushed journal line has kind `incident`, `merge` or `migration`, or is a successful session `gh pr merge` row (a Bash PostToolUse carries no exit code, but PostToolUse fires only on success; a non-zero exit fires PostToolUseFailure); (b) the journal is longer than the `flushed` marker and the last sync (`at` in `last-sync.json`) is more than 60 minutes old or unknown; or (a) `git ls-remote origin main` (3 s timeout; on error it does not block; run only when (b) and (c) do not block) differs from `mainSha` in `last-sync.json`. Routine rows (`approval`, `decision`, `verify`, `owner-step`, agent starts and finishes, `gh pr close`) therefore wait for the next 60-minute window (narrowed from 10 min/7 kinds on 2026-09-22 — owner decision, the hook was blocking too often and draining usage). **Cloud safety:** it never blocks when `CLAUDE_CODE_REMOTE` is set (Claude Code sets it to `"true"` in remote/web sessions, where the cloud routine runs), and `~/.smartremit-ledger` is created lazily. `LEDGER_SYNC_HOOK=off` disables it by hand.
