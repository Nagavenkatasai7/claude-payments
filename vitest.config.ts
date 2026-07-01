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
    // threads pool: each test file runs in its own worker_thread with a SEPARATE
    // V8 isolate (separate heap, no parent-heap inheritance). helpers-db's
    // module-level _pgliteDb singleton allocates ONE PGlite WASM engine per
    // thread. The thread exits after the file completes, reclaiming ~670 MB.
    //
    // WHY threads instead of forks:
    // forks uses fork(2) (copy-on-write). After running ~127 test files, the
    // main Vitest process accumulates ~4 GB of V8 heap (module resolver cache,
    // test result state, tinypool message buffers). The next fork inherits all
    // of this via COW — V8's GC sees the inherited pages as live (it cannot
    // distinguish COW from real allocations), so Mark-Compact frees ZERO bytes
    // and the worker immediately OOMs (confirmed from CI GC logs).
    // worker_threads have truly separate V8 isolates: the thread heap starts
    // empty, accumulates only what the test file actually allocates (~few hundred
    // MB), and never hits the 4 GB adaptive limit on the 7 GB CI runner.
    //
    // isolate:true is the default for threads — each file gets a fresh module
    // registry, preserving vi.mock() isolation between files. DO NOT set
    // isolate:false — that reuses the module registry across files and freezes
    // static mock bindings in cached modules.
    //
    // maxThreads:1 keeps memory bounded (one ~670 MB PGlite instance at a time).
    //
    // Worker thread heap limit: Node.js 22 rejects --max-old-space-size in
    // execArgv (ERR_WORKER_INVALID_EXEC_ARGV) and Vitest's pool doesn't expose
    // resourceLimits. Instead the npm test script runs vitest under
    // `node --max-old-space-size=2048`, which sets V8's global flag before any
    // isolates are created — worker isolates inherit it as their default limit.
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 1,
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
