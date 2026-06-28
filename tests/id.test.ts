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
});

describe('newTransferId — Math.random()===0 infinite-loop regression', () => {
  // Bug: Math.random().toString(36).slice(2) returns '' when Math.random()===0
  // (since (0).toString(36)==="0" and "0".slice(2)===""). The while loop then
  // never makes progress and hangs forever.
  it('still returns an 8-char id when Math.random() returns 0 on the first call', () => {
    const orig = Math.random;
    let call = 0;
    // Return 0 once, then delegate to the real random to unblock the loop
    Math.random = () => (call++ === 0 ? 0 : orig());
    try {
      const id = newTransferId();
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    } finally {
      Math.random = orig;
    }
  });

  it('never produces an empty chunk that stalls progress (stress)', () => {
    const orig = Math.random;
    let calls = 0;
    // Alternate: 0 (empty chunk), then a real value — ensures the guard skips empty chunks
    Math.random = () => (calls++ % 2 === 0 ? 0 : orig());
    try {
      const id = newTransferId();
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    } finally {
      Math.random = orig;
    }
  });
});
