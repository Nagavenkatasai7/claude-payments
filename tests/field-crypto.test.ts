import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EnvKeyProvider,
  encryptField,
  decryptField,
  type EncryptionKeyProvider,
} from '@/lib/field-crypto';

// A fixed-key provider so tests never depend on env. Mirrors EnvKeyProvider's
// AES-256-GCM wrap/unwrap but with a deterministic master key we control.
function fixedProvider(masterKey: Buffer): EncryptionKeyProvider {
  return new EnvKeyProvider(masterKey);
}

const KEY_A = Buffer.alloc(32, 7); // 0x07 * 32
const KEY_B = Buffer.alloc(32, 9); // a DIFFERENT master key

describe('field-crypto round-trip', () => {
  it('round-trips an ASCII string', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('hello world', p);
    expect(decryptField(blob, p)).toBe('hello world');
  });

  it('round-trips a unicode string', () => {
    const p = fixedProvider(KEY_A);
    const plain = 'नमस्ते 🌍 — Привет — 日本語';
    const blob = encryptField(plain, p);
    expect(decryptField(blob, p)).toBe(plain);
  });

  it('round-trips the empty string', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('', p);
    expect(decryptField(blob, p)).toBe('');
  });

  it('does not leak the plaintext into the blob', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('4111111111111111', p);
    expect(blob).not.toContain('4111111111111111');
    expect(blob.startsWith('v1.')).toBe(true);
  });
});

describe('field-crypto randomized envelope (no deterministic ciphertext)', () => {
  it('produces DIFFERENT blobs for the same plaintext but both decrypt back', () => {
    const p = fixedProvider(KEY_A);
    const blob1 = encryptField('same secret', p);
    const blob2 = encryptField('same secret', p);
    expect(blob1).not.toBe(blob2); // random DEK + random IVs
    expect(decryptField(blob1, p)).toBe('same secret');
    expect(decryptField(blob2, p)).toBe('same secret');
  });
});

describe('field-crypto tamper detection (GCM auth tag)', () => {
  // Flip one byte of a given base64url segment and expect decrypt to throw.
  function tamperSegment(blob: string, index: number): string {
    const parts = blob.split('.');
    const seg = parts[index];
    const buf = Buffer.from(seg, 'base64url');
    buf[buf.length - 1] ^= 0x01; // flip a bit of the last byte
    parts[index] = buf.toString('base64url');
    return parts.join('.');
  }

  it('throws when the ciphertext is flipped', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('integrity-protected', p);
    // v1.<iv>.<tag>.<wrappedDek>.<ct> → ct is index 4
    expect(() => decryptField(tamperSegment(blob, 4), p)).toThrow();
  });

  it('throws when the auth tag is flipped', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('integrity-protected', p);
    expect(() => decryptField(tamperSegment(blob, 2), p)).toThrow();
  });

  it('throws when the wrapped data key is flipped', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('integrity-protected', p);
    expect(() => decryptField(tamperSegment(blob, 3), p)).toThrow();
  });
});

describe('field-crypto key isolation', () => {
  it('throws when decrypting under a different master key (crypto-shred / KMS swap)', () => {
    const blob = encryptField('cross-key', fixedProvider(KEY_A));
    expect(() => decryptField(blob, fixedProvider(KEY_B))).toThrow();
  });
});

describe('field-crypto format / version validation', () => {
  it('throws on an unknown version prefix', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('x', p);
    const bad = blob.replace(/^v1\./, 'v2.');
    expect(() => decryptField(bad, p)).toThrow();
  });

  it('throws on a malformed blob (wrong number of segments)', () => {
    const p = fixedProvider(KEY_A);
    expect(() => decryptField('v1.onlytwo.parts', p)).toThrow();
  });

  it('throws on a non-string / empty blob', () => {
    const p = fixedProvider(KEY_A);
    expect(() => decryptField('', p)).toThrow();
  });
});

describe('EnvKeyProvider master-key validation', () => {
  it('accepts a 64-hex-char master key', () => {
    const hexKey = randomBytes(32).toString('hex');
    const p = new EnvKeyProvider(hexKey);
    const blob = encryptField('hex-key works', p);
    expect(decryptField(blob, p)).toBe('hex-key works');
  });

  it('accepts a base64 32-byte master key', () => {
    const b64Key = randomBytes(32).toString('base64');
    const p = new EnvKeyProvider(b64Key);
    const blob = encryptField('b64-key works', p);
    expect(decryptField(blob, p)).toBe('b64-key works');
  });

  it('throws at use when the decoded master key is not 32 bytes', () => {
    const shortHex = randomBytes(16).toString('hex'); // 16 bytes, not 32
    const p = new EnvKeyProvider(shortHex);
    expect(() => p.wrapDataKey(randomBytes(32))).toThrow(
      'FIELD_ENCRYPTION_KEY missing or not 32 bytes',
    );
  });

  it('throws at use on an empty master key', () => {
    const p = new EnvKeyProvider('');
    expect(() => encryptField('x', p)).toThrow(
      'FIELD_ENCRYPTION_KEY missing or not 32 bytes',
    );
  });

  it('wrap then unwrap returns the original DEK', () => {
    const p = fixedProvider(KEY_A);
    const dek = randomBytes(32);
    const wrapped = p.wrapDataKey(dek);
    expect(wrapped.equals(dek)).toBe(false); // wrapped is iv||tag||ct, not the raw key
    expect(p.unwrapDataKey(wrapped).equals(dek)).toBe(true);
  });
});

describe('field-crypto malformed-blob length guards (GCM tag length)', () => {
  it('throws when the auth tag is truncated to 4 bytes (should reject, not silently decrypt)', () => {
    // Node.js crypto accepts GCM tags of 4, 8, 12-16 bytes per NIST SP 800-38D. A
    // stored or injected blob with a 4-byte tag decrypts successfully unless we
    // validate the tag length explicitly. This test pins the 16-byte requirement.
    const p = fixedProvider(KEY_A);
    const blob = encryptField('secret-value', p);
    const parts = blob.split('.');
    // Truncate the tag (index 2) from 16 bytes to 4 bytes
    const fullTag = Buffer.from(parts[2], 'base64url');
    const shortTag = fullTag.subarray(0, 4).toString('base64url');
    const weakenedBlob = [parts[0], parts[1], shortTag, parts[3], parts[4]].join('.');
    expect(() => decryptField(weakenedBlob, p)).toThrow(/malformed blob/);
  });

  it('throws when the IV is truncated below 12 bytes', () => {
    const p = fixedProvider(KEY_A);
    const blob = encryptField('secret-value', p);
    const parts = blob.split('.');
    // Truncate the IV (index 1) from 12 bytes to 8 bytes
    const fullIv = Buffer.from(parts[1], 'base64url');
    const shortIv = fullIv.subarray(0, 8).toString('base64url');
    const weakenedBlob = [parts[0], shortIv, parts[2], parts[3], parts[4]].join('.');
    expect(() => decryptField(weakenedBlob, p)).toThrow(/malformed blob/);
  });
});

describe('field-crypto default provider (env-driven)', () => {
  it('builds an EnvKeyProvider lazily from env.fieldEncryptionKey', async () => {
    const masterHex = randomBytes(32).toString('hex');
    vi.resetModules();
    vi.doMock('@/lib/env', () => ({
      env: { fieldEncryptionKey: masterHex },
    }));
    const mod = await import('@/lib/field-crypto');
    const blob = mod.encryptField('via env default provider');
    expect(mod.decryptField(blob)).toBe('via env default provider');
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });
});
