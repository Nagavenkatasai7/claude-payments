import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Playwright owns tests/e2e/. Keeping them out of Vitest avoids a double-run.
    // .claude/worktrees holds agent worktrees (full repo copies) — their stale
    // test copies must never run against this checkout's src.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**', '.claude/**'],
    // vmForks: each test file runs in a fresh V8 VM subprocess — module cache is
    // discarded between files so PGlite instances don't bleed between files.
    // maxForks:2 balances memory vs wall-clock time.  One worker accumulates
    // >4 GB across 167 files and hits V8's per-process heap limit (OOM).
    // Four workers saturate the 7 GB runner RAM at the heavy-PGlite-test wave
    // (4 × ~1.4 GB = 5.8 GB workers + OS overhead > 7 GB → OS OOM killer).
    // Two workers peak at ~2 GB each (4 GB total) + 1.5 GB OS/orchestrator =
    // ~5.5 GB — comfortably within 7 GB.  Wall-clock ≈ 11 min for the full
    // suite, fitting in the 20-min CI timeout with ample headroom.
    pool: 'vmForks',
    poolOptions: { vmForks: { maxForks: 2 } },
    // 15 s per test: heavy PGlite migrations + GC pauses inside long-lived workers
    // can push simple tests past the 5 s default.  15 s gives ample headroom
    // without masking real hangs.
    testTimeout: 15000,
    // CI-only: PGlite suites occasionally flake 1-3 tests under parallel runs
    // (they pass in isolation — see CLAUDE.md gotchas). One retry keeps known
    // flakes from evicting good PRs from the merge queue; locally retries stay
    // off so real failures (and flakes) remain loud.
    retry: process.env.CI ? 1 : 0,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
