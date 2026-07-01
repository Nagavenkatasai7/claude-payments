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
    // forks pool: each test file reimports modules in a long-lived forked worker.
    // isolate:true (default) clears the module registry between files, so
    // helpers-db's initPromise singleton is reset and PGlite instances lose all
    // references — normal V8 GC reclaims them.  This avoids the vmForks problem
    // where V8 VM contexts accumulated 4+ GB of un-GCed WASM-backed PGlite
    // memory across 83 files in a single worker (FATAL: heap out of memory).
    // vmForks could not fix this: VM context boundaries don't help GC of WASM
    // ArrayBuffer backing stores held at the native/V8 boundary.
    // 4 workers × ~400 MB peak each = 1.6 GB workers + 1.5 GB OS ≈ 3.1 GB —
    // well within 7 GB.  Wall-clock ≈ 5–6 min for the full suite.
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
