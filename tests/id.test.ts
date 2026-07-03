import { describe, it, expect, vi, afterEach } from 'vitest';
import { newTransferId } from '@/lib/id';

describe('newTransferId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an 8-character alphanumeric id', () => {
    const id = newTransferId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('returns different ids on repeated calls', () => {
    expect(newTransferId()).not.toBe(newTransferId());
  });

  it('terminates when Math.random() always returns 0 (pure-zero guard: chunk||"0" fallback)', () => {
    // When Math.random() returns 0: (0).toString(36) = "0"; "0".slice(2) = "" (empty).
    // Without the fix, id += "" never advances id.length → infinite loop.
    // With the fix, id += "" || "0" always makes progress → terminates in 8 calls.
    //
    // The escape hatch (calls > 100 → return 0.5) prevents CI from hanging on the
    // unfixed path.  With the fix, the escape hatch is never reached (calls = 8).
    const orig = Math.random;
    let calls = 0;
    Math.random = () => {
      calls++;
      if (calls > 100) return 0.5; // escape hatch — only reachable in the unfixed path
      return 0;
    };
    try {
      const id = newTransferId();
      expect(id).toMatch(/^[a-z0-9]{8}$/);
      // Fixed path: 8 calls exactly (one per '0' character).
      // Unfixed path with escape hatch: 100+ calls → assertion fails, revealing the bug.
      expect(calls).toBeLessThanOrEqual(8);
    } finally {
      Math.random = orig;
    }
  });
});
