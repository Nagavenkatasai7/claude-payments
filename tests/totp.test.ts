/**
 * Program-Fix 17b — RFC 6238 TOTP (HMAC-SHA1, 30 s step) on node:crypto.
 * Vectors: RFC 6238 Appendix B (https://www.rfc-editor.org/rfc/rfc6238#appendix-B),
 * SHA1 column, seed = ASCII "12345678901234567890".
 */
import { describe, it, expect } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totpAt,
  totpOtpauthUri,
  totpStep,
  verifyTotp,
} from '@/lib/totp';

const SEED = Buffer.from('12345678901234567890', 'ascii');

describe('totp (RFC 6238)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('Appendix B SHA1 vector T=%i → %s (8 digits)', (t, code) => {
    expect(totpAt(SEED, t * 1000, 8)).toBe(code);
  });

  it('6-digit code at T=59 is 287082', () => {
    expect(totpAt(SEED, 59_000)).toBe('287082');
  });

  it('HOTP RFC 4226 Appendix D counter 0 and 9', () => {
    expect(hotp(SEED, 0)).toBe('755224');
    expect(hotp(SEED, 9)).toBe('520489');
  });

  it('base32 round-trips (RFC 4648 vectors, no padding, case/space-insensitive decode)', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi').toString()).toBe('foobar');
    expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar');
    const s = generateTotpSecret();
    expect(s.length).toBe(20);
    expect(base32Decode(base32Encode(s)).equals(s)).toBe(true);
    expect(() => base32Decode('MZ1W')).toThrow();
  });

  it('accepts the current, previous and next step (±1) and returns the matched step', () => {
    const now = 1_700_000_015_000;
    const step = totpStep(now);
    expect(verifyTotp(SEED, totpAt(SEED, now), now)).toBe(step);
    expect(verifyTotp(SEED, totpAt(SEED, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(SEED, totpAt(SEED, now + 30_000), now)).toBe(step + 1);
  });

  it('rejects a code two steps away', () => {
    const now = 1_700_000_015_000;
    expect(verifyTotp(SEED, totpAt(SEED, now - 60_000), now)).toBeNull();
    expect(verifyTotp(SEED, totpAt(SEED, now + 60_000), now)).toBeNull();
  });

  it('rejects anything that is not exactly 6 digits (never reaches timingSafeEqual with unequal lengths)', () => {
    const now = 1_700_000_015_000;
    const good = totpAt(SEED, now);
    for (const bad of ['', '12345', '1234567', 'abcdef', `${good} `, `+${good.slice(1)}`, '１２３４５６']) {
      expect(verifyTotp(SEED, bad, now)).toBeNull();
    }
    // Surrounding whitespace from a paste is trimmed by the caller only; spaces
    // inside are never accepted here.
    expect(verifyTotp(SEED, `${good.slice(0, 3)} ${good.slice(3)}`, now)).toBeNull();
  });

  it('replay guard: a step at or below the last accepted step is refused', () => {
    const now = 1_700_000_015_000;
    const step = totpStep(now);
    const code = totpAt(SEED, now);
    expect(verifyTotp(SEED, code, now, { lastStep: step - 1 })).toBe(step);
    expect(verifyTotp(SEED, code, now, { lastStep: step })).toBeNull();
    // an older (still in-window) code after a newer one was used
    expect(verifyTotp(SEED, totpAt(SEED, now - 30_000), now, { lastStep: step })).toBeNull();
  });

  it('otpauth URI encodes label and issuer, carries the base32 secret and defaults', () => {
    const uri = totpOtpauthUri({ issuer: 'SmartRemit', account: 'ops user@x', secretBase32: 'MZXW6YTBOI' });
    expect(uri).toBe(
      'otpauth://totp/SmartRemit:ops%20user%40x?secret=MZXW6YTBOI&issuer=SmartRemit&algorithm=SHA1&digits=6&period=30',
    );
  });
});
