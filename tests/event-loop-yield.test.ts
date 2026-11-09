import { describe, it, expect } from 'vitest';

// tests/setup.ts lets the event loop run between tests. A PGlite-heavy file
// otherwise runs every test on microtasks alone, so the worker never reads
// Vitest's RPC replies; past 60 s the RPC times out ("Timeout calling
// onTaskUpdate") and fails a shard whose tests all passed (CI shard 2:
// tests/tools.test.ts measured 44 s with no event-loop turn).
describe('the event loop runs between tests', () => {
  let ranBetween = false;

  it('schedules a macrotask and returns without yielding', () => {
    setImmediate(() => {
      ranBetween = true;
    });
  });

  it('sees the macrotask ran before it started', () => {
    expect(ranBetween).toBe(true);
  });
});
