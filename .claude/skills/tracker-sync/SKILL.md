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

## 1. Read the ledger
ArtifactData, url = the ledger:
- `list` collection `prs` (limit 200), `fixes` (limit 100), both with `out_dir: <scratch>/ledger-db`
- `get` meta/state with the same `out_dir`

## 2. Snapshot GitHub
```
node scripts/tracker/snapshot.mjs --db <scratch>/ledger-db --out <scratch>/ledger-snap
```
It prints `{mainSha, ciMain, smokeMain, prWrites, events, fixProposals, batches}` and writes `batch-N.json` (PRs, meta/state, events) plus `fix-proposals.json`. PR bodies should carry `Program-Fix: <n>` lines; legacy Phase 0 PRs are mapped in the script.

## 3. Write
- For each `batch-N.json`: ArtifactData `batch` with its entries as `writes` (they reference files; each batch is < 900 KB).
- For each entry in `fix-proposals.json` and anything this session changed (a task started, a PR opened, a verification passed): ArtifactData `update` on `fixes/fix-NN` with only the changed fields (`status`, `prs`, `mergeSha`, `smoke`, `evidence`, `updatedAt`), pinned with `if_version` from step 1.
- When a phase changes state (plan approved, first fix merged, all fixes done), `update` `phases/phase-N` (`status`, `note`).
- Add an `events/<yyyymmddThhmmss>-<slug>` doc for anything a reader should see in the timeline that the snapshot did not generate (verification runs, plan approvals, incidents, owner actions). Fields: `at` (ISO), `kind` (merge | verify | plan | review | incident | security | milestone), `title`, `detail`.
- Backlog items (`backlog/<key>`): set `status: "done"` when closed, with a one-line `detail`.

## 4. Library refresh (only with `--corpus`, or when a doc it indexes changed: the audit, security results, spec, phase plans, verification records, COMPONENTS/architecture docs, blueprint data)
```
python3 scripts/tracker/build-corpus.py "$PWD" <scratch>/ledger-corpus [docs/superpowers/plans/<phase plan>.md ...]
```
Send every `batch-N.json` it prints with ArtifactData `batch`. If `corpusParts` shrank, `delete` the stale `corpus/part-NNN` docs. Run it from the checkout that holds the git-ignored `CLAUDE-SECURITY-*/` results.

## 5. Report
One line: main SHA · CI · smoke · fixes verified X/49 · what changed. Do not claim the page updated without the write results.
