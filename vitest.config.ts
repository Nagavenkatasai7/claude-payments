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
    // maxForks:1 + execArgv --max-old-space-size=13312:
    // agent*.test.ts mock @/db/client (via vi.hoisted + vi.mock) so the Neon
    // WebSocket driver and ws are never loaded — that's what caused the 12+ GB
    // non-reclaimable heap that OOM'd the 7 GB ubuntu-latest CI runner. With the
    // mock, the module-loading baseline is ~2-3 GB; PGlite WASM grows ~115 MB per
    // test. 13 GB is a generous ceiling that V8 will never approach; it is kept
    // because lowering it risks OOM if a future import re-introduces a heavy dep.
    // agent.test.ts (15 tests), agent-2.test.ts (16), agent-3.test.ts (14) are
    // split so no single file's PGlite WASM growth gets too large.
    //
    // DO NOT set isolate:false in poolOptions.forks — that sets isolateWorkers:false
    // (long-lived workers that reuse module registry), which freezes static mock
    // bindings in cached modules and breaks vi.mock() isolation between files.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
        execArgv: ['--max-old-space-size=13312'],
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
