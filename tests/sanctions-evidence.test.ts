import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { inputHash, resetEvidenceKeyForTests } from '@/lib/sanctions/evidence';

// Program-Fix 14 step 3: the evidence row proves WHICH input was screened
// without storing it. A plain SHA-256 of a name is brute-forceable from a
// name dictionary, so the hash is an HMAC keyed off FIELD_ENCRYPTION_KEY.
describe('inputHash', () => {
  const original = process.env.FIELD_ENCRYPTION_KEY;
  afterEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = original;
    resetEvidenceKeyForTests();
  });

  it('is deterministic and normalisation-stable', () => {
    const a = inputHash('John Doe');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(inputHash('John Doe')).toBe(a);
    expect(inputHash('  JOHN   doe. ')).toBe(a);
    expect(inputHash('Jane Roe')).not.toBe(a);
  });

  it('is NOT the plain SHA-256 of the name (raw or normalised)', () => {
    const h = inputHash('John Doe');
    expect(h).not.toBe(createHash('sha256').update('John Doe').digest('hex'));
    expect(h).not.toBe(createHash('sha256').update('john doe').digest('hex'));
  });

  it('accepts a hex64 key and the same key as base64-32 (the single decodeMasterKey path)', () => {
    const hex = '0909090909090909090909090909090909090909090909090909090909090909';
    process.env.FIELD_ENCRYPTION_KEY = hex;
    resetEvidenceKeyForTests();
    const fromHex = inputHash('Mom');
    process.env.FIELD_ENCRYPTION_KEY = Buffer.from(hex, 'hex').toString('base64');
    resetEvidenceKeyForTests();
    expect(inputHash('Mom')).toBe(fromHex);
  });

  it('a different key gives a different hash', () => {
    const before = inputHash('Mom');
    process.env.FIELD_ENCRYPTION_KEY = '0a'.repeat(32);
    resetEvidenceKeyForTests();
    expect(inputHash('Mom')).not.toBe(before);
  });

  it('never throws: a missing or invalid key yields null (screening must not break)', () => {
    process.env.FIELD_ENCRYPTION_KEY = '';
    resetEvidenceKeyForTests();
    expect(inputHash('Mom')).toBeNull();
    process.env.FIELD_ENCRYPTION_KEY = 'not-a-key';
    resetEvidenceKeyForTests();
    expect(inputHash('Mom')).toBeNull();
  });
});
