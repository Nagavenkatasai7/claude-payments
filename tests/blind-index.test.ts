import { describe, it, expect } from 'vitest';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { blindIndex, deriveBlindIndexKey, BLIND_INDEX_INFO } from '@/lib/blind-index';
import { decodeMasterKey } from '@/lib/field-crypto';

// blind-index — the keyed HMAC that lets waitlist_signups dedupe on email/phone
// without storing either in the clear. The tests pin the DERIVATION (so a
// re-implementation cannot silently change every stored index) and the
// properties that make it safe: keyed (≠ any unkeyed hash of the value),
// key-separated from field encryption, and deterministic per key.

const HEX_KEY = '07'.repeat(32);
const OTHER_KEY = '11'.repeat(32);

describe('decodeMasterKey', () => {
  it('accepts a 64-hex-char key and a base64 32-byte key (the two shapes EnvKeyProvider accepts)', () => {
    expect(decodeMasterKey(HEX_KEY)).toEqual(Buffer.from(HEX_KEY, 'hex'));
    const b64 = Buffer.alloc(32, 9).toString('base64');
    expect(decodeMasterKey(b64)).toEqual(Buffer.alloc(32, 9));
  });

  it('rejects empty, short, and wrong-length keys', () => {
    expect(() => decodeMasterKey('')).toThrow(/FIELD_ENCRYPTION_KEY/);
    expect(() => decodeMasterKey('abc')).toThrow(/FIELD_ENCRYPTION_KEY/);
    expect(() => decodeMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/FIELD_ENCRYPTION_KEY/);
  });
});

describe('deriveBlindIndexKey', () => {
  it('is HKDF-SHA256(master, salt="", info=BLIND_INDEX_INFO, 32) — a purpose-separated sub-key, never the master itself', () => {
    const key = deriveBlindIndexKey(HEX_KEY);
    const expected = Buffer.from(hkdfSync('sha256', Buffer.from(HEX_KEY, 'hex'), '', BLIND_INDEX_INFO, 32));
    expect(key).toEqual(expected);
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from(HEX_KEY, 'hex'))).toBe(false);
  });

  it('throws (never falls back to an unkeyed hash) when the master key is missing', () => {
    expect(() => deriveBlindIndexKey('')).toThrow(/FIELD_ENCRYPTION_KEY/);
  });
});

describe('blindIndex', () => {
  it('is HMAC-SHA256(derivedKey, `${purpose}:${value}`) as lowercase hex', () => {
    const key = deriveBlindIndexKey(HEX_KEY);
    const expected = createHmac('sha256', key).update('email:a@b.co').digest('hex');
    expect(blindIndex('email', 'a@b.co', key)).toBe(expected);
    expect(blindIndex('email', 'a@b.co', key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed: differs from every unkeyed hash of the value and changes with the key', () => {
    const idx = blindIndex('email', 'a@b.co', deriveBlindIndexKey(HEX_KEY));
    expect(idx).not.toBe(createHash('sha256').update('a@b.co').digest('hex'));
    expect(idx).not.toBe(createHash('sha256').update('email:a@b.co').digest('hex'));
    expect(idx).not.toBe(blindIndex('email', 'a@b.co', deriveBlindIndexKey(OTHER_KEY)));
  });

  it('is purpose-separated: the same value under a different purpose is a different index', () => {
    const key = deriveBlindIndexKey(HEX_KEY);
    expect(blindIndex('email', '+15551234567', key)).not.toBe(blindIndex('phone', '+15551234567', key));
  });

  it('defaults the key to one derived from FIELD_ENCRYPTION_KEY (tests/setup.ts sets 07×32)', () => {
    expect(blindIndex('email', 'a@b.co')).toBe(blindIndex('email', 'a@b.co', deriveBlindIndexKey(HEX_KEY)));
  });
});
