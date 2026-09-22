#!/usr/bin/env node
// Stop hook `ledger-sync-due`: asks Claude to run the tracker-sync skill before finishing when
// - the journal (~/.smartremit-ledger/journal.ndjson) has bytes past the `flushed` marker, or
// - origin/main (git ls-remote, 3 s timeout) differs from mainSha in last-sync.json, which the
//   skill writes after a successful sync (journal.mjs mark-flushed --main-sha).
// Never blocks when:
// - stop_hook_active is true (Claude Code's loop guard: at most one block per stop);
// - CLAUDE_CODE_REMOTE is set: Claude Code sets it to "true" in remote/web environments, which is
//   where the cloud routine runs (https://code.claude.com/docs/en/hooks.md); the routine syncs
//   on its own, with no journal;
// - LEDGER_SYNC_HOOK=off (manual escape hatch);
// - ls-remote fails or times out, or no sync has been recorded yet (no last-sync.json).
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
    const lastSyncMainSha = journal.readLastSync()?.mainSha ?? null;
    let remoteMainSha = null;
    // The network check only matters when the journal alone does not already call for a sync.
    if (journalSize <= flushedOffset && lastSyncMainSha) {
      const r = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/main'], {
        cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      if (!r.error && r.status === 0) remoteMainSha = (r.stdout.trim().split(/\s+/)[0] || '') || null;
    }
    const decision = core.stopDecision({ stopHookActive: false, remote, disabled, journalSize, flushedOffset, remoteMainSha, lastSyncMainSha });
    // Synchronous write: process.exit() below must not drop an async pipe write.
    if (decision) writeSync(1, JSON.stringify(decision));
  }
} catch {
  // Never block or fail a stop because the ledger check itself broke.
}
process.exit(0);
