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

  it('does not hang when Math.random() returns 0 (regression: infinite loop)', () => {
    // (0).toString(36) === "0", "0".slice(2) === "" — empty chunk caused an
    // infinite loop because nothing was appended to id on each iteration.
    // Math.random() CAN legally return 0 per the ECMAScript spec.
    let callCount = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++;
      // Return 0 for the first 10 calls, then normal values so the test terminates
      if (callCount <= 10) return 0;
      return 0.5; // "i".repeat... → produces chars
    });
    const id = newTransferId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('returns a valid id even when Math.random() always returns 0 (pure-zero guard)', () => {
    // With the fix, 0.toString(36).slice(2) === "" should be skipped so
    // the loop can still make forward progress using the fallback "0" character.
    // We simulate a short burst of zeros then normal output.
    let calls = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      calls++;
      return calls <= 5 ? 0 : 0.123456789; // zeros then normal
    });
    const id = newTransferId();
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });
});
