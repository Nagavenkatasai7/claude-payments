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
    // clearMocks: mockClear() after each test — clears .mock.calls/.results/.instances
    // but NOT the implementation. Stops spy call-record accumulation in agent.test.ts:
    // the file-scope selectSettlementRoute spy was accumulating ALL 45 tests' call
    // arguments, growing the live heap at ~57 MB/s NET — the root cause of the OOM
    // progression (6 GB→30s, 8 GB→34s, 10 GB→42s). clearMocks cuts that to near-zero
    // per-test accumulation; the ~8.4 GB module-loading base stays well under 10 GB.
    clearMocks: true,
    // unstubGlobals: restores vi.stubGlobal() after each test. The beforeEach in
    // agent.test.ts calls vi.stubGlobal('fetch', vi.fn()...) — without this, vitest's
    // stubs registry retains references to every per-test fetch spy created, preventing
    // GC of their accumulated call records even after clearMocks empties them.
    unstubGlobals: true,
    // forks pool: default isolate:true → isolateWorkers:true in tinypool, so each
    // test file runs in its own fresh forked process. helpers-db's module-level
    // _pgliteDb singleton allocates ONE PGlite WASM engine per file (preventing
    // repeated migration inside a file's beforeEach calls). The OS reclaims the
    // ~670 MB WASM ArrayBuffer when the worker process exits after each file.
    //
    // maxForks:1 + execArgv --max-old-space-size=10240: agent.test.ts (45 tests,
    // full Next.js+app module tree + PGlite) builds up ~8.4 GB base from module
    // loading. GC logs confirmed ~57 MB/s NET spy accumulation (now fixed by
    // clearMocks+unstubGlobals). 10 GB limit provides ample headroom.
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
