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
    // maxForks:1 (no execArgv heap cap):
    // Each test file forks from the main Vitest process. By file ~87, the main
    // process has accumulated ~2 GB of test-result state. An explicit
    // --max-old-space-size (4 GB or 13 GB) tells V8 it may grow to that ceiling
    // before GCing — the forked worker then tries to claim up to 2 + 4 = 6 GB,
    // exhausting the 7 GB CI runner and OOMing. Without the flag V8 defaults to
    // ~1.4 GB old-space, GCs early and often, and the actual working set stays
    // near the 430 MB measured locally (agent tests peak RSS).
    //
    // DO NOT set isolate:false in poolOptions.forks — that sets isolateWorkers:false
    // (long-lived workers that reuse module registry), which freezes static mock
    // bindings in cached modules and breaks vi.mock() isolation between files.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
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
