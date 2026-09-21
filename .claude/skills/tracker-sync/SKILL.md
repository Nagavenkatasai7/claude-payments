---
name: tracker-sync
description: Push the current program state to the SmartRemit Program Ledger artifact (progress bars, fix table, timeline, cited assistant). Reads GitHub and the ledger database, writes changed PRs, CI/smoke state and events, and updates fix status with evidence. Use after every merge (called by /post-merge-check), after a verification run, when a phase plan is approved, at the start of a session, or when asked to update the tracker.
argument-hint: "[--corpus] [note about what changed]"
---
# /tracker-sync — keep the Program Ledger true

Ledger: https://claude.ai/artifact/7wD2psZ6fndztDjwZC3oNZ (private to the owner). The database is the source of truth for status; the repo holds the tooling. Scratch dir below = this session's scratchpad.

## Truth rules (non-negotiable)
- A fix is `done` only with **all three**: its PR(s) merged, the post-deploy smoke green on a SHA that contains them, and verification evidence for the finding (a live probe, a test that reproduces the finding now passing, or a Chrome check). Write that evidence into `evidence` in one or two sentences.
- Merged but not yet verified → `merged`. PR open → `in_review`. Branch with commits → `in_progress`. Plan approved and task written → `planned`. Otherwise `open`.
- Never mark `done` from a PR title or description alone. Never lower a `done` without writing an `incident` event that says why.
- No secrets, tokens or unmasked phone numbers/names in any document.

**The ledger is the program's system of record (owner direction 2026-09-21).**
- Record every action in `events`, agent runs included. When you start an agent, write one row. When its result comes back, write another with what it found or changed.
- Record every owner decision and every approval. Approvals are given in chat and recorded at once: who, when, and which plan version or PR.
- Every plan lives in `plans` (schema: `scripts/tracker/PLAN-SCHEMA.md`) and is updated whenever the plan changes.
- Write in the same turn as the action. Never batch it up for later.

**Always run the snapshot (step 2), even after a hand-written fix or event update.** Only the snapshot refreshes `meta/state` (main SHA, CI, smoke, deploy); skipping it leaves the status strip and the "Needs attention" list stale (2026-09-16: a 'smoke pending' incident stayed up for 3 hours after it went green).

## 1. Read the ledger
ArtifactData, url = the ledger:
- `list` collection `prs` (limit 200), `fixes` (limit 100), `plans` (limit 50), each with `out_dir: <scratch>/ledger-db`
- `get` meta/state with the same `out_dir`
- The results list each document's `version` (the saved files do NOT contain it; copy it from the listing). Write them to `<scratch>/ledger-db/versions.json` as `{"prs/pr-237": 2, "fixes/fix-04": 1, "meta/state": 7}`. The database refuses to overwrite an existing document without its version.

## 2. Snapshot GitHub
```
node scripts/tracker/snapshot.mjs --db <scratch>/ledger-db --versions <scratch>/ledger-db/versions.json --out <scratch>/ledger-snap
```
It prints `{mainSha, ciMain, smokeMain, prWrites, events, fixProposals, batches}` and writes `batch-N.json` (PRs, meta/state, events) plus `fix-proposals.json`. PR bodies should carry `Program-Fix: <n>` lines; legacy Phase 0 PRs are mapped in the script.

## 3. Write
- For each `batch-N.json`: ArtifactData `batch` with its entries as `writes` (they reference files; each batch is < 900 KB).
- For each entry in `fix-proposals.json` and anything this session changed (a task started, a PR opened, a verification passed): ArtifactData `update` on `fixes/fix-NN` with only the changed fields (`status`, `prs`, `mergeSha`, `smoke`, `evidence`, `updatedAt`), pinned with `if_version` from step 1.
- When a phase changes state (plan approved, first fix merged, all fixes done), `update` `phases/phase-N` (`status`, `note`).
- Add an `events/<yyyymmddThhmmss>-<slug>` doc for anything a reader should see in the timeline that the snapshot did not generate (verification runs, plan approvals, incidents, owner actions). Fields: `at` (ISO), `kind` (merge | verify | plan | review | incident | security | milestone), `title`, `detail`.
- Backlog items (`backlog/<key>`): set `status: "done"` when closed, with a one-line `detail`.

If a batch fails with `version_mismatch`, someone wrote in between: re-read that document, rebuild, resend. Never drop `if_version` to force it.

## 3a. Journal row shape (`events/<yyyymmddThhmmss>-<slug>`)
`{at, kind, actor, title, detail, model?, refs?, result?}`
- `kind`: decision | approval | agent | plan | review | pr | merge | deploy | migration | owner-step | verify | milestone | incident | security.
- `actor`: owner | claude | agent | github | ci.
- `model`: for agent rows, e.g. "Opus 5".
- `refs`: `{fix: [n], pr: [n], plan: "p1-w2", sha: "abc1234"}`.
- `result`: ok | blocked | failed | running | info.
- Titles are plain and specific ("Fix 10 re-check: 1 gap left"). No secrets, phone numbers or names.

## 3b. Plans (`plans/<id>`: p0, p1-w1…p1-wN, p2, p3, p4)
- When a plan is written or revised, update its doc (`planVersion` +1, `updatedAt`, items) and write a `plan` event.
- On approval: set `approval: {state: "approved", at, by: "owner", ref}` and `status: "approved"`, and write an `approval` event.
- When a fix in a plan opens a PR, merges or is verified, update that item's `status` together with the fix doc.
- Working copies: `~/dev/program-ledger/plans/*.json`. Every write is pinned with `if_version`.

## 4. Library refresh (only with `--corpus`, or when a doc it indexes changed: the audit, security results, spec, phase plans, verification records, COMPONENTS/architecture docs, blueprint data)
```
python3 scripts/tracker/build-corpus.py "$PWD" <scratch>/ledger-corpus [docs/superpowers/plans/<phase plan>.md ...]
```
Send every `batch-N.json` it prints with ArtifactData `batch`. If `corpusParts` shrank, `delete` the stale `corpus/part-NNN` docs. Run it from the checkout that holds the git-ignored `CLAUDE-SECURITY-*/` results.

## 5. Report
One line: main SHA · CI · smoke · fixes verified X/49 · what changed. Do not claim the page updated without the write results.
