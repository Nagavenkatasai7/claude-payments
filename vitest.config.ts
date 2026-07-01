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
    // maxForks:4 gives four parallel workers (~42 files each, ~1 GB peak per
    // worker) instead of one worker that would accumulate >4 GB across 167 files
    // and OOM.  vmFork isolation means each worker has its own initPromise /
    // PGlite, so parallel-run flakes from shared state are eliminated.
    pool: 'vmForks',
    poolOptions: { vmForks: { maxForks: 4 } },
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
