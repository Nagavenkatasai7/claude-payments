import { describe, it, expect } from 'vitest';
import { newTransferId } from '@/lib/id';

describe('newTransferId', () => {
  it('returns an 8-character alphanumeric id', () => {
    const id = newTransferId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('returns different ids on repeated calls', () => {
    expect(newTransferId()).not.toBe(newTransferId());
  });

  it('skips Math.random() === 0 and still produces a valid 8-char id', () => {
    // Root bug: (0).toString(36) === '0'; '0'.slice(2) === '' — empty append means
    // id.length never advances, causing an infinite loop when r=0 repeats.
    // Fix: guard with `if (r > 0)` so zero values are skipped and retried.
    const orig = Math.random;
    let callCount = 0;
    Math.random = () => {
      callCount++;
      // Return 0 for first 5 calls; restore and return a reliable non-zero value thereafter.
      if (callCount <= 5) return 0;
      Math.random = orig;
      return 0.5;
    };
    try {
      const id = newTransferId();
      expect(id).toMatch(/^[a-z0-9]{8}$/);
      // The zero calls must have been skipped — function must have called Math.random more than 5 times
      expect(callCount).toBeGreaterThan(5);
    } finally {
      Math.random = orig;
    }
  });
});
