import { describe, it, expect } from 'vitest';
import { isReasonValid } from '@/lib/ui/confirm-reason';
describe('isReasonValid', () => {
  it.each([
    ['', false], ['         ', false], ['too short', false], ['1234567890', true],
    ['   padded reason ok   ', true], ['a  \n  b  \t c', false], ['😀😀😀😀😀😀😀😀😀😀', true],
  ])('%j → %s', (r, ok) => expect(isReasonValid(r)).toBe(ok));
  it('respects a custom minimum', () => expect(isReasonValid('abcdef', 5)).toBe(true));
  it('a non-string (a forged form field) is never valid', () => {
    expect(isReasonValid(null as never)).toBe(false);
    expect(isReasonValid(undefined as never)).toBe(false);
  });
});
