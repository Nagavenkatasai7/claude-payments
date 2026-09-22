#!/usr/bin/env node
// PostToolUse(Agent), PostToolUse(Bash) and SubagentStop hook: appends journal lines to the
// Program Ledger journal (~/.smartremit-ledger/journal.ndjson), which the tracker-sync engine
// turns into events/j-* docs. Logic: hookToJournalEntries() in scripts/tracker/sync-core.mjs.
// ONE start row and ONE finish row per agent the MAIN thread launches:
// - Agent (main thread only: input without agent_id): records {agentId, description,
//   subagent_type, model} under tool_response.agentId in ~/.smartremit-ledger/agents.json and
//   journals "Agent started: <description>". NEVER the prompt.
// - SubagentStop: journals "Agent finished: <description>" (first 280 scrubbed chars of
//   last_assistant_message) only for an agent_id in agents.json that is not finished yet, then
//   marks it finished. Later stops of that agent only update its stored last message; unknown ids
//   (nested helpers, Claude Code's internal agents) are skipped.
//   Field names: https://code.claude.com/docs/en/hooks.md (Agent tool_response `agentId`;
//   SubagentStop input `agent_id`, `last_assistant_message`; common field `agent_id` is present
//   only inside a subagent).
// - Bash: only `gh pr merge|close`, with the PR number and exit code; a subagent's calls are
//   skipped. Bash tool_response has no exit code; PostToolUse fires only on success (a non-zero
//   exit fires PostToolUseFailure), so a plain PostToolUse means exit 0 (bashExitCode in sync-core).
// The I/O is recordHookEvent() in scripts/tracker/journal.mjs (tested in
// tests/tracker-journal-io.test.ts): agents.json is read-modify-written under a lock
// (withAgentsLock), because parallel subagents stop concurrently, and each journal row is
// appended BEFORE agents.json is written, so a failed append never marks an agent finished.
// Never fails the tool call: prints nothing, always exits 0.
import { readFileSync } from 'node:fs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const journal = await import(new URL('../../scripts/tracker/journal.mjs', import.meta.url).href);
  journal.recordHookEvent(input);
} catch {
  // Journaling is best effort; the tool call it observes must never fail because of it.
}
process.exit(0);
