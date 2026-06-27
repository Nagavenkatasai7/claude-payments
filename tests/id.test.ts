import { describe, it, expect, vi, afterEach } from 'vitest';
import { newTransferId } from '@/lib/id';

describe('newTransferId', () => {
  it('returns an 8-character alphanumeric id', () => {
    const id = newTransferId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it('returns different ids on repeated calls', () => {
    expect(newTransferId()).not.toBe(newTransferId());
  });
});

describe('newTransferId — infinite-loop regression (bug-hunt)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an 8-char id even when Math.random() always returns 0 (no infinite loop)', () => {
    // The old Math.random().toString(36).slice(2) approach: (0).toString(36) === "0",
    // "0".slice(2) === "" — the while loop would spin forever appending "".
    // The crypto.getRandomValues implementation is immune to this.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const id = newTransferId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });
});
