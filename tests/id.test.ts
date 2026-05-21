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
