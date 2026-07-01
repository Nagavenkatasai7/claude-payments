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
    //
    // maxForks:1 + execArgv --max-old-space-size=8192: agent.test.ts (1372 lines,
    // full Next.js+app module tree + PGlite) consumes >6 GB of V8 heap alone,
    // confirmed by GC logs hitting the 6144 MB limit. maxForks:2 with 8 GB each
    // would require 2×8+2×0.67 ≈ 17.3 GB — exceeds the 16 GB runner. One fork
    // at a time at 8 GB: 8 + 0.67 ≈ 8.7 GB peak — fits comfortably. Serial
    // execution adds ~2 min vs 2-fork parallel but stays well within 20-min budget.
    //
    // DO NOT set isolate:false in poolOptions.forks — that sets isolateWorkers:false
    // (long-lived workers that reuse module registry), which freezes static mock
    // bindings in cached modules and breaks vi.mock() isolation between files.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
        execArgv: ['--max-old-space-size=8192'],
      },
    },
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
