#!/usr/bin/env node
// PostToolUse(Agent), PostToolUse(Bash) and SubagentStop hook: appends one line per event to the
// Program Ledger journal (~/.smartremit-ledger/journal.ndjson), which the tracker-sync engine
// turns into events/j-* docs. Logic: hookToJournalEntries() in scripts/tracker/sync-core.mjs.
// - Agent: main-thread launches only (input without agent_id); description + type, NEVER the prompt.
// - Bash: only `gh pr merge|close`, with the PR number and exit code; a subagent's calls are skipped.
// - SubagentStop: agent type + the first 280 scrubbed chars of its last message.
// Never fails the tool call: prints nothing and always exits 0.
import { readFileSync } from 'node:fs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const core = await import(new URL('../../scripts/tracker/sync-core.mjs', import.meta.url).href);
  const entries = core.hookToJournalEntries(input, new Date().toISOString());
  if (entries.length) {
    const journal = await import(new URL('../../scripts/tracker/journal.mjs', import.meta.url).href);
    for (const e of entries) journal.appendJournal(e);
  }
} catch {
  // Journaling is best effort; the tool call it observes must never fail because of it.
}
process.exit(0);
