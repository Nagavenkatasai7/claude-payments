import { describe, it, expect } from 'vitest';
import { normalizePhone, isValidPhone } from '@/lib/phone';

describe('normalizePhone', () => {
  it('strips + characters', () => {
    expect(normalizePhone('+919876543210')).toBe('919876543210');
  });

  it('strips spaces', () => {
    expect(normalizePhone('+91 98765 43210')).toBe('919876543210');
  });

  it('strips dashes', () => {
    expect(normalizePhone('91-9876-543-210')).toBe('919876543210');
  });

  it('handles undefined gracefully', () => {
    expect(normalizePhone(undefined)).toBe('');
  });

  it('handles null gracefully', () => {
    expect(normalizePhone(null)).toBe('');
  });

  it('handles empty string', () => {
    expect(normalizePhone('')).toBe('');
  });

  it('passes through a clean digit string unchanged', () => {
    expect(normalizePhone('919876543210')).toBe('919876543210');
  });

  it('returns empty string when toString() throws (never-throw invariant for unknown inputs)', () => {
    // A revoked Proxy, tampered prototype, or untrusted deserialized object may have
    // a toString() that throws. normalizePhone must never propagate that exception.
    const malformed = {
      toString() {
        throw new TypeError('boom');
      },
    };
    expect(normalizePhone(malformed)).toBe('');
  });
});

describe('isValidPhone', () => {
  it('returns true for a 10-digit number', () => {
    expect(isValidPhone('9876543210')).toBe(true);
  });

  it('returns true for a 12-digit India number', () => {
    expect(isValidPhone('919876543210')).toBe(true);
  });

  it('returns true for a 15-digit number (max E.164)', () => {
    expect(isValidPhone('123456789012345')).toBe(true);
  });

  it('returns false for a 9-digit number (too short)', () => {
    expect(isValidPhone('987654321')).toBe(false);
  });

  it('returns false for a 16-digit number (too long)', () => {
    expect(isValidPhone('1234567890123456')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isValidPhone('')).toBe(false);
  });

  it('returns false for a string with non-digit characters', () => {
    expect(isValidPhone('91987654321a')).toBe(false);
  });
});
