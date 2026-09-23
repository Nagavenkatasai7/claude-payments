import { describe, it, expect } from 'vitest';
import { resolveWaPhone, formatWaPhone, WA_PHONE, DEFAULT_WA_PHONE, waLink } from '@/app/landing/wa';

// Program-Fix 25 PR B (ui-01 / docs-03, §3.9): the landing WhatsApp number is
// env-driven (NEXT_PUBLIC_WHATSAPP_NUMBER, inlined at build) with today's number
// as the default, so nothing changes until the owner sets a production number.

describe('resolveWaPhone', () => {
  it('unset / empty → today\'s number (no-op)', () => {
    expect(DEFAULT_WA_PHONE).toBe('15556298293');
    expect(resolveWaPhone(undefined)).toBe(DEFAULT_WA_PHONE);
    expect(resolveWaPhone('')).toBe(DEFAULT_WA_PHONE);
    expect(resolveWaPhone('   ')).toBe(DEFAULT_WA_PHONE);
  });

  it('a digits-only 8–15 digit value is used as-is', () => {
    expect(resolveWaPhone('447700900123')).toBe('447700900123');
    expect(resolveWaPhone('12025550100')).toBe('12025550100');
  });

  it('anything else falls back (a malformed number fails silently in a deep link)', () => {
    expect(resolveWaPhone('+1 202 555 0100')).toBe(DEFAULT_WA_PHONE);
    expect(resolveWaPhone('1234567')).toBe(DEFAULT_WA_PHONE); // 7 digits
    expect(resolveWaPhone('1234567890123456')).toBe(DEFAULT_WA_PHONE); // 16 digits
    expect(resolveWaPhone('12025550100abc')).toBe(DEFAULT_WA_PHONE);
  });
});

describe('formatWaPhone (the footer label)', () => {
  it('formats a NANP number exactly like today\'s footer', () => {
    expect(formatWaPhone('15556298293')).toBe('+1 555 629 8293');
  });
  it('any other number → +digits', () => {
    expect(formatWaPhone('447700900123')).toBe('+447700900123');
  });
});

describe('WA_PHONE / waLink in this test env (no env set)', () => {
  it('keeps today\'s deep link byte-for-byte', () => {
    expect(WA_PHONE).toBe('15556298293');
    expect(waLink('hi')).toBe('https://api.whatsapp.com/send/?phone=15556298293&text=hi&type=phone_number&app_absent=0');
  });
});
