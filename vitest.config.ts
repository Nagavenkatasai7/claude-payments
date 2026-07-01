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
    // forks pool: each test file runs in a long-lived forked worker with
    // isolate:true (module registry cleared between files). helpers-db.ts stores
    // PGlite in global.__pgliteDb so ONE WASM engine is shared per worker
    // process rather than spawned per file. Per-file spawn accumulated ~670 MB
    // per instance and could not be GC'd mid-run (vitest retains test-function
    // closures that hold the drizzle→PGlite→WASM chain live across module resets,
    // making gc() ineffective — confirmed OOM at exactly 4 GB after ~6 files).
    // With a single global engine: 4 workers × ~670 MB = ~2.7 GB — safe.
    // Wall-clock ≈ 5–6 min for the full suite.
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4 } },
    // 15 s per test: heavy PGlite migrations can push simple tests past the 5 s
    // default.  15 s gives ample headroom without masking real hangs.
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
