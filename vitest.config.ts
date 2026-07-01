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
    // clearMocks + unstubGlobals: good hygiene — clear spy call records and restore
    // vi.stubGlobal() stubs after each test. Redundant with the existing
    // vi.restoreAllMocks() in agent*.test.ts afterEach, but harmless.
    clearMocks: true,
    unstubGlobals: true,
    // forks pool: default isolate:true → isolateWorkers:true in tinypool, so each
    // test file runs in its own fresh forked process. helpers-db's module-level
    // _pgliteDb singleton allocates ONE PGlite WASM engine per file (preventing
    // repeated migration inside a file's beforeEach calls). The OS reclaims the
    // ~670 MB WASM ArrayBuffer when the worker process exits after each file.
    //
    // maxForks:1 + execArgv --max-old-space-size=10240: PGlite WASM linear memory
    // grows MONOTONICALLY — PostgreSQL WAL and shared buffers consume ~106 MB per
    // test and never shrink within a process. The original agent.test.ts (45 tests)
    // reached ~12.7 GB peak (8 GB module base + 45×106 MB), OOM-ing at 10 GB.
    // Fix: split into agent.test.ts (15), agent-2.test.ts (16), agent-3.test.ts (14).
    // Each file's process peaks at ~8 GB + 16×106 MB ≈ 9.7 GB — under 10 GB limit.
    // maxForks:2 with 10 GB each would need 2×10+2×0.67 ≈ 21.3 GB — exceeds
    // 16 GB runner. One fork at a time: 10+0.67+~2 GB overhead ≈ 12.7 GB peak.
    //
    // DO NOT set isolate:false in poolOptions.forks — that sets isolateWorkers:false
    // (long-lived workers that reuse module registry), which freezes static mock
    // bindings in cached modules and breaks vi.mock() isolation between files.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
        execArgv: ['--max-old-space-size=10240'],
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
