#!/usr/bin/env node
// Stop hook `ledger-sync-due`: asks Claude to run the tracker-sync skill before finishing when
// (c) an unflushed journal line (past the `flushed` marker) has kind approval, decision, incident,
//     merge, migration, owner-step or verify, or is a successful session `gh pr merge` row (kind
//     pr): these reach the page promptly, even when ls-remote fails;
// (b) the journal has unflushed bytes AND the last sync (`at` in last-sync.json) is more than
//     10 minutes old (or unknown): routine rows such as agent starts wait for the next window;
// (a) origin/main (git ls-remote, 3 s timeout) differs from mainSha in last-sync.json, which the
//     skill writes after a successful sync (journal.mjs mark-flushed --main-sha).
// (b) and (c) need no network, so ls-remote runs only when neither blocks.
// Never blocks when:
// - stop_hook_active is true (Claude Code's loop guard: at most one block per stop);
// - CLAUDE_CODE_REMOTE is set: Claude Code sets it to "true" in remote/web environments, which is
//   where the cloud routine runs (https://code.claude.com/docs/en/hooks.md); the routine syncs
//   on its own, with no journal;
// - LEDGER_SYNC_HOOK=off (manual escape hatch);
// - for (a): ls-remote fails or times out, or no sync has been recorded yet (no last-sync.json);
// - the check itself throws.
// Logic: stopDecision() in scripts/tracker/sync-core.mjs. Always exits 0.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';

try {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid input: treat as a plain stop */ }
  const remote = Boolean(process.env.CLAUDE_CODE_REMOTE);
  const disabled = process.env.LEDGER_SYNC_HOOK === 'off';
  if (input.stop_hook_active !== true && !remote && !disabled) {
    const core = await import(new URL('../../scripts/tracker/sync-core.mjs', import.meta.url).href);
    const journal = await import(new URL('../../scripts/tracker/journal.mjs', import.meta.url).href);
    const journalSize = journal.journalSize();
    const flushedOffset = journal.readFlushed();
    const lastSync = journal.readLastSync();
    const args = {
      stopHookActive: false, remote, disabled, journalSize, flushedOffset,
      pendingLines: journalSize > flushedOffset ? journal.readPendingLines(flushedOffset) : [],
      lastSyncAt: lastSync?.at ?? null,
      now: new Date().toISOString(),
      lastSyncMainSha: lastSync?.mainSha ?? null,
      remoteMainSha: null,
    };
    let decision = core.stopDecision(args);
    // The network check only matters when the journal alone does not already call for a sync.
    if (!decision && args.lastSyncMainSha) {
      const r = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
        cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const remoteMainSha = !r.error && r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] || '') || null : null;
      decision = core.stopDecision({ ...args, remoteMainSha });
    }
    // Synchronous write: process.exit() below must not drop an async pipe write.
    if (decision) writeSync(1, JSON.stringify(decision));
  }
} catch {
  // Never block or fail a stop because the ledger check itself broke.
}
process.exit(0);
