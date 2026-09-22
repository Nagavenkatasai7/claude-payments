import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Playwright owns tests/e2e/. Keeping them out of Vitest avoids a double-run.
    // .claude/worktrees holds agent worktrees (full repo copies) — their stale
    // test copies must never run against this checkout's src.
    exclude: ['**/node_modules/**', '**/node_modules.nosync/**', '**/dist/**', 'tests/e2e/**', '.claude/**'],
    // CI-only: PGlite suites occasionally flake 1-3 tests under parallel runs
    // (they pass in isolation — see CLAUDE.md gotchas). One retry keeps known
    // flakes from evicting good PRs from the merge queue; locally retries stay
    // off so real failures (and flakes) remain loud.
    retry: process.env.CI ? 1 : 0,
    // Local memory cap: an uncapped full run forks one worker per core (11 on a 12-core Mac),
    // and 88 of the suites boot a PGlite (WASM Postgres) each, so one run peaked at 10.2 GB.
    // Parallel agents running it at once exhausted a 24 GB machine (2026-09-21). 4 workers
    // peaks at about 5.3 GB for about 6 s more wall time. CI keeps Vitest's default.
    // Override locally with VITEST_MAX_WORKERS. Agents run full suites via ~/dev/bin/vitest-full,
    // a machine-wide lock that allows one full run at a time.
    maxWorkers: process.env.CI ? undefined : Number(process.env.VITEST_MAX_WORKERS ?? 4),
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
