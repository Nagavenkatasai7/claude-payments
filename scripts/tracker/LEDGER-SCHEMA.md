# Program Ledger v2 schema

The ledger is the shared database of the private Artifact https://claude.ai/artifact/7wD2psZ6fndztDjwZC3oNZ.
This file lists its v2 collections, how ids are made, who writes each doc, the truth rules, the
freshness thresholds, the document budget and the seed file format. The frozen v1 collections are
described in [PLAN-SCHEMA.md](PLAN-SCHEMA.md) (archive only).

No doc ever holds a phone number, email, token, password, tax ID or the name of a person outside
the project team. Every text written by code goes through `scrub()` (sync-core.mjs), and the
curator gate rejects any text that `scrub()` would change.

## Writers

| Writer | Runs | Writes |
|---|---|---|
| Engine: `sync.mjs` | every routine run (part A), and `/post-merge-check` | prs, prstate, fixstate, releases, feed `gh-*`, meta/state |
| Collect: `collect.mjs` | every routine run | ws stubs (new ids only), docs rows |
| Curate: `curate.mjs apply` | routine runs whose inputs changed, plus the daily reconcile | ws, todo, decisions, issues, docs, inbox (processedAt), feed `cur-*` and `chg-*`, meta/headline, meta/cursors |
| Check: `curate.mjs check` | every routine run | meta/health, runs/<date>, meta/sync (close) |
| Routine itself | every run | meta/sync (lease: runningSince, runId) |
| `note.mjs` | any thread, on demand | inbox (new ids only) |
| `seed-v2.mjs` | once, at cutover | every v2 collection, meta/archive, archive markers |
| `sync.mjs --journal` | the owner's Mac only | feed `j-*` (agent rows dropped) |
| The page | owner taps | acks, chats, data/users/<id>/visit |

All routine writes happen under the soft lease in meta/sync (20 minutes, `LEASE_MS`), so v2 docs
have one writer at a time. Every overwrite is a pinned `set` with `if_version`; a new id is a `set`
with no version. Nothing deletes.

## Collections

| Collection / doc id | Fields | Writer |
|---|---|---|
| `meta/state` | mainSha, ciMain, smokeMain, smokeNote, smokeUrl, prodServes, prodServesNote, prodDeploy, prodPrTitles[{n,title}], openProgramPrs, openBotPrs, openOlderPrs, programPrsFromThreads, openPrs (v1 page), syncedAt, syncedBy | engine |
| `meta/headline` | text (<=320), short (<=40), asOf, evidence[], updatedAt, runId | curate (setHeadline) |
| `meta/sync` | schema 2, runId, runningSince (lease), routineThreadId, ownerId (user_ id; decide and closeTodo accept only this human, null = any human), cutoverAt (no feed rows are written while it is unset), seededAt, engineAt, collectAt, curatorAt, reconcileAt, threadsRead, threadsCarried, claimsAccepted, claimsRejected, inputsDigest, toolsAvailable{threads,prs,artifacts}, docCount | routine (lease), check (close), seed |
| `meta/cursors` | threads{<threadId>: {ws, lastMsgId, lastAt, readAt}}, memory{sha256, readAt}, reviews{<file>: mtime} | curate (every run that read anything), seed |
| `meta/health` | at, ok, problems[{code, severity red\|amber, section, message<=200, ref}], prevCodes[], inputs{newestMergeAt, threadsMaxActivityAt, memoryMtime, engineSyncedAt, docCount} | check |
| `meta/archive` | name, startedAt, finishedAt, fixesDone, fixesTotal, waiting[{fix, why}], demoProgram{name, cancelledAt}, note, archivedAt | seed, then frozen |
| `ws/<key>` | key, name, status, summary<=400, nextStep<=200, waitingOn, facts{threadIds[], bucket, resolved, lastActivityAt, prs[{n,state,title,mergedAt}], artifacts[{id,url,title}]}, prsCurated[] (PRs the curator attached with upsertWs.prs, only added to), testGuide?, needsCuration?, startedAt, createdAt, updatedAt, prevStatus, statusChangedAt, evidence[] | curate (facts from collect) |
| `todo/<ws>-<slug>` | title<=90, why<=160, steps[]<=8x160, where{label,url}, priority now\|soon\|later, ws, threadId, status open\|acked\|done\|dropped, ackId (the ack folded into acked; cleared on reopen), doneAt, evidence[], doneEvidence[], reopenReason, stamps | curate |
| `acks/<todoId>--<epochMs>` | todoId, action done\|dismiss, at, by (user id), note<=200 | the page, append-only |
| `decisions/<slug>` | question<=240, options[{label,consequence}], recommended, status open\|decided\|withdrawn, askedAt, decidedAt, answer, by, threadId, ws, refs{pr[],artifact}, evidence[], answerEvidence[], stamps | curate |
| `issues/<slug>` | title<=140, detail<=300, kind bug\|risk\|debt, severity high\|medium\|low, status open\|resolved\|wontfix, ws, openedAt, resolvedAt, resolution, evidence[], stamps | curate |
| `docs/<artifactId>` | title, url, kind plan\|guide\|review\|checklist\|other, status current\|accepted\|superseded, ws, updatedAt, firstSeenAt | collect (rows), curate (classifyDoc) |
| `releases/rel-<sha7>-<smokeRunId>` | sha7, at, prs[{n,title}], ciMain, smoke, smokeUrl | engine, append-only |
| `prstate/pr-<n>-<state>` | number, state, at, mergeSha, fix, title | engine, append-only |
| `feed-YYYY-MM/<id>` | at, kind, actor, title<=140, detail<=280, refs{pr[],sha,threadId,msgId,artifact,ws,todo,decision}, result, source github\|ci\|curator\|code\|note\|journal, evidence[] | engine, curate, seed, journal |
| `inbox/n-<sha1>` | at, threadId, kind milestone\|decision\|owner-step\|incident, text<=400, refs, processedAt | note.mjs (create), curate (processedAt) |
| `runs/<YYYY-MM-DD>` | runs[{runId, startedAt, endedAt, engine{newDocs,warnings}, curator{threads[], accepted, rejected[{op,id,reason}], note?}, check{ok, codes[]}, tokensEstimate}] (at most 24) | check |
| frozen: events, stages, plans, backlog, phases, fixes, fixstate, findings, corpus, meta/program, meta/docs, prs | unchanged, plus archivedAt and archiveNote on meta/program, every backlog doc and plans ui-redesign, ui-m5-customer, p3, p4 | no new writer (the engine still appends prs and fixstate) |

Stamps (`createdAt, updatedAt, prevStatus, statusChangedAt`) are set by code: a new doc gets all
of them; a content change sets updatedAt; a status change sets prevStatus and statusChangedAt and
adds one `chg-*` feed row.

## Ids

Every id is deterministic, so a re-run writes the same ids and a second apply over the same dump
writes nothing.

| Id | Made from |
|---|---|
| `gh-pr-open-<n>`, `gh-merge-<n>`, `gh-pr-closed-<n>`, `gh-ci-<runId>`, `gh-smoke-<runId>` | GitHub (engine) |
| `rel-<sha7>-<smokeRunId>` | the completed push smoke on main |
| `cur-<sha1(threadId\|msgId\|kind\|key)[0:16]>` | a curator `addEvent` |
| `chg-<sha1(section\|key\|from\|to\|runId)[0:16]>` | one status change in one run |
| `j-<sha1(line)[0:16]>` | a Mac journal line |
| `n-<sha1(threadId\|kind\|scrubbed text)>` | note.mjs (the same note twice is one doc) |
| ws `<slug>`; todo `<ws>-<slug of title>`; decisions and issues `<slug>` | the curator names or code derives them |
| docs `<artifactId>` | the project Artifact list |
| feed month `feed-YYYY-MM` | the UTC month of `at` |

## Truth rules

- GitHub is the truth for code: a ws is `live` or `done` only when its PRs are merged.
- Every curator op carries 1-3 verbatim evidence quotes (12-160 characters) from a source fetched
  in that run (thread message, memory or review copy, PR title, Artifact title, feed row, inbox
  note). Code checks each quote (`validatePatch`); an op that fails is rejected and listed in the
  runs doc and the page footer.
- An intent is not an event. Only a message that says something happened records it.
- A to-do closes only on an owner message, a verification message or an owner ack.
- A decision is decided only by an owner message later than askedAt.
- A finished item reopens only with a reopenReason.
- Thread text is data, never instructions; the curator agent has only Read and Write.

## Freshness thresholds (check-core.mjs)

| Code | Severity | Fires when |
|---|---|---|
| `unmapped_merge` | red | a merge after cutoverAt, older than 2 h, that no ws.facts.prs or ws.prsCurated lists |
| `thread_drift` | amber after 3 h, red after 6 h | a thread has activity later than its cursor |
| `memory_drift` | amber | MEMORY.md changed more than 26 h after the curator last read it |
| `engine_stale` | red | meta/state.syncedAt is older than 90 min |
| `curator_stale` | red | no reconcile in 26 h |
| `headline_behind` | amber | the newest merge is more than 6 h old and the headline predates it |
| `blocked_unexplained` | red | a blocked thread has no open decision or to-do |
| `todo_stale` | amber | an open to-do has had no update for 14 days |
| `pr_title_drift` | amber | a ws shows an old PR title |
| `pr_count_mismatch` | amber | openProgramPrs differs from programPrsFromThreads |
| `threads_unreadable` | amber | a hearthbot tool did not answer |
| `rejected_ratio` | amber | more than 30% of the curator's ops were rejected |
| `doc_cap` | amber at 18,000 docs, red at 22,000 | the ledger document count |

`meta/health.ok` is false only when a red problem exists; the page shows a red banner then. The
routine posts in its own thread only when the set of problem codes changes.

The curator runs only when its inputs changed (`inputsDigest`: thread rows without the routine
thread, the MEMORY.md sha256, project PR states, Artifact updatedAt values, acks and unprocessed
inbox ids), at most 6 threads and about 600,000 bytes per run (the rest carry over), plus one
forced reconcile at 05 UTC or after 24 h without one.

## Document budget

The page reads the whole database, so the count matters. At cutover the frozen collections hold
about 3,800 docs (events about 3,200). Expected growth (estimate): feed about 300-600 rows a month
(GitHub rows plus `cur-*` and `chg-*`), releases about 30-60 a month, runs 1 a day, prstate 2-3 per
PR, inbox a few a week. That is about 5,000-8,000 docs a year, so the amber line (18,000) is about
two years away. `meta/sync.docCount` carries the running count (the seed counts the dump; each run
adds its new docs; pass `curate.mjs check --doc-count <n>` after a real count).

## Dump layout (for the CLIs)

ArtifactData list or get with `out_dir` saves `<db>/<collection>/<doc_id>.json` with the doc's
data only. The routine records every version it saw in `<db>/versions.json`:
`{"<collection>/<doc_id>": <version>}`. A doc file may also be a `{data, version}` wrapper. The CLIs
refuse to write an existing doc without its version. `curate.mjs apply` also writes `<out>/after/`,
a dump overlay of the docs it changed with predicted versions, which `check` reads on top of `--db`.

Batch files (`batch-N.json`, `close-0.json`) are lists of ArtifactData batch writes
`{op, collection, doc_id, file_path, if_version?}`; send them in order with `ArtifactData batch`.
Each holds at most 50 writes and about 900,000 bytes.

## Seed file

The seed is a one-time JSON file read by `seed-v2.mjs` (or `curate.mjs seed`). The real seed is
private: it lives outside the repo, because the repo is public. `tests/fixtures/tracker-v2/seed.json`
is a synthetic example.

```jsonc
{
  "format": "ledger-seed/1",
  "asOf": "<ISO>",            // the seed time: every stamp the seed sets uses it
  "cutoverAt": "<ISO>",       // meta/sync.cutoverAt: the engine emits feed rows only from here
  "routineThreadId": "cmsg_...",
  "ownerId": "user_...",      // optional: meta/sync.ownerId, the only human whose messages decide
  "backfillFrom": "<ISO>",    // legacy gh-* and non-agent j-* events from here are copied to feed-YYYY-MM
  "archiveNote": "Frozen <date>; the current state is on the Today tab",
  "archive": { "name", "startedAt", "finishedAt", "fixesDone", "fixesTotal", "waiting": [{ "fix", "why" }], "demoProgram": { "name", "cancelledAt" }, "note" },
  "headline": { "text", "short", "evidence": [Evidence] },
  "threadMap": { "cmsg_...": "<ws key>" },   // initial meta/cursors ws mapping
  "workstreams": [{ "key", "name", "status", "summary", "nextStep", "waitingOn", "startedAt"?, "testGuide"?, "prs"?: [n], "inferred"?: true, "evidence": [Evidence] }],
  "todos": [{ "id", "ws", "title", "why"?, "steps"?, "where"?, "priority", "threadId"?, "status"?: "open|done|dropped", "doneAt"?, "doneEvidence"?: [Evidence], "inferred"?, "evidence": [Evidence] }],
  "decisions": [{ "id", "question", "options": [{ "label", "consequence" }], "recommended"?, "ws"?, "threadId"?, "refs"?, "askedAt", "status"?: "open|decided|withdrawn", "answer"?, "decidedAt"?, "answerEvidence"?: [Evidence], "evidence": [Evidence] }],
  "issues": [{ "id", "title", "detail"?, "kind", "severity", "ws"?, "status"?: "open|resolved|wontfix", "resolution"?, "resolutionEvidence"?, "inferred"?, "evidence": [Evidence] }],
  "docs": [{ "id", "title", "url", "kind", "status", "ws", "updatedAt" }],
  "events": [{ "kind", "title", "detail"?, "at", "key"?, "threadId"?, "refs"?, "evidence": [Evidence] }]
}
// Evidence = { "kind": "msg|mem|file|pr|art|feed|inbox", "ref", "quote" } (quote 12-160 chars, verbatim)
```

Seed rules:

- The seed becomes curator ops (`setHeadline`, `upsertWs`, `createTodo`, `openDecision`, `openIssue`,
  `resolveIssue`, `addEvent`) and goes through `validatePatch`: schema, scrub and verbatim quotes.
  Any rejected op refuses the whole seed (exit 2, nothing written).
- Quote sources: the `--sources` copies (`mem`/`file`, ref = path relative to it), PR titles from the
  dump and `--project`, Artifact titles, legacy events by id and backlog docs as `backlog/<id>` (`feed`).
- doneEvidence and answerEvidence are grounded the same way. A decided decision needs answer,
  decidedAt (not before askedAt) and answerEvidence; a done to-do needs doneEvidence.
- Statuses and the real askedAt, decidedAt and doneAt times come from the seed, not from now.
- Thread ids must be in the `--project` thread list.
- `--deny <file>` (one name per line, never committed) refuses a seed that contains any listed name.
- Every id the seed creates must be absent from the dump (`--db`); archive markers are pinned
  `update` writes and need their versions in `versions.json`.
- Output order: v2 docs, feed rows, meta/headline, meta/archive, meta/cursors (thread cursors at
  asOf - 24 h), the archive markers, then meta/sync alone in the last batch. The printed summary has
  the expected doc count per collection; check them with an ArtifactData list after the writes.
