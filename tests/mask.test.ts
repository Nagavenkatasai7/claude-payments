import { describe, it, expect } from 'vitest';
import { maskLast4 } from '@/lib/mask';

describe('maskLast4', () => {
  it('returns the last 4 of a long value', () => {
    expect(maskLast4('A1234567')).toBe('4567');
  });
  it('returns the whole short value when 4 or fewer chars', () => {
    expect(maskLast4('99')).toBe('99');
  });
  it('handles undefined / empty defensively', () => {
    expect(maskLast4(undefined)).toBe('');
    expect(maskLast4('')).toBe('');
  });
});
