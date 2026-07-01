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
    // forks pool: default isolate:true → isolateWorkers:true in tinypool, so each
    // test file runs in its own fresh forked process. helpers-db's module-level
    // _pgliteDb singleton allocates ONE PGlite WASM engine per file (preventing
    // repeated migration inside a file's beforeEach calls). The OS reclaims the
    // ~670 MB WASM ArrayBuffer when the worker process exits after each file.
    // At most 4 concurrent workers: 4 × ~670 MB = ~2.7 GB — safe.
    // Wall-clock ≈ 5–6 min. DO NOT set isolate:false in poolOptions.forks —
    // that sets isolateWorkers:false (long-lived workers that reuse module
    // registry), which freezes static mock bindings in cached modules and breaks
    // vi.mock() isolation between files.
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
