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
// - Bash: only `gh pr merge|close`, with the PR number and exit code; a subagent's calls are skipped.
// agents.json is read-modify-written under a lock (withAgentsLock in journal.mjs), because
// parallel subagents stop concurrently. Never fails the tool call: prints nothing, always exits 0.
import { readFileSync } from 'node:fs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const core = await import(new URL('../../scripts/tracker/sync-core.mjs', import.meta.url).href);
  const now = new Date().toISOString();
  if (core.hookUsesAgents(input)) {
    const journal = await import(new URL('../../scripts/tracker/journal.mjs', import.meta.url).href);
    journal.withAgentsLock(() => {
      const step = core.hookToJournalEntries(input, now, journal.readAgents());
      if (step.changed) journal.writeAgents(core.pruneAgents(step.agents, now));
      for (const e of step.entries) journal.appendJournal(e);
    });
  } else {
    const { entries } = core.hookToJournalEntries(input, now, {});
    if (entries.length) {
      const journal = await import(new URL('../../scripts/tracker/journal.mjs', import.meta.url).href);
      for (const e of entries) journal.appendJournal(e);
    }
  }
} catch {
  // Journaling is best effort; the tool call it observes must never fail because of it.
}
process.exit(0);
