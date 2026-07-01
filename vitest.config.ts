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
    // vmForks: each test file runs in a fresh V8 VM subprocess — module cache is
    // discarded between files, so peak heap = one file's footprint (~300 MB) rather
    // than the sum of all parallel workers.  maxForks:1 serialises execution to
    // keep memory flat; the suite is I/O-bound (PGlite) not CPU-bound, so
    // concurrency would not help much anyway.
    pool: 'vmForks',
    poolOptions: { vmForks: { maxForks: 1 } },
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
