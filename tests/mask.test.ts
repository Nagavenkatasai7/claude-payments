import { describe, it, expect } from 'vitest';
import { maskLast4, maskPhoneLast4 } from '@/lib/mask';

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

// Partner-demo R6a: the sender's phone in a RECIPIENT-facing message is shown
// as ••••<last 4 digits> only (U+2022 bullets — not '*', which WhatsApp renders
// as bold markup).
describe('maskPhoneLast4', () => {
  it('masks a full phone number to ••••<last 4 digits>', () => {
    expect(maskPhoneLast4('15551234567')).toBe('••••4567');
  });
  it('ignores formatting characters (+, spaces, dashes)', () => {
    expect(maskPhoneLast4('+1 555-123-4567')).toBe('••••4567');
  });
  it('never returns a short number whole (4 or fewer digits ⇒ ••••)', () => {
    expect(maskPhoneLast4('4567')).toBe('••••');
    expect(maskPhoneLast4('12')).toBe('••••');
  });
  it('handles undefined / empty / digit-free input defensively', () => {
    expect(maskPhoneLast4(undefined)).toBe('••••');
    expect(maskPhoneLast4('')).toBe('••••');
    expect(maskPhoneLast4('abc')).toBe('••••');
  });
  it('carries no WhatsApp formatting markup (* _ ~ `) and no whitespace', () => {
    for (const p of ['15551234567', '4567', '', undefined]) {
      expect(maskPhoneLast4(p)).not.toMatch(/[*_~`\s]/);
    }
  });
  it('never exposes more than 4 digits', () => {
    for (const p of ['15551234567', '919876543210', '+44 20 7946 0958', '12345']) {
      const out = maskPhoneLast4(p);
      expect(out.replace(/\D/g, '').length).toBeLessThanOrEqual(4);
      expect(out.startsWith('••••')).toBe(true);
    }
  });
});
