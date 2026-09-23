import { afterEach, describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EnvKeyProvider,
  encryptField,
  decryptField,
  aadFor,
  sealFieldV2,
  __setFieldCryptoWriteV2ForTests,
  type EncryptionKeyProvider,
} from '@/lib/field-crypto';
import { ctx, outboxSealedCtx } from '@/lib/crypto-context';
import { env } from '@/lib/env';

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

describe('field-crypto lone surrogates — regression (bug-hunt)', () => {
  it('throws when plaintext contains a lone high surrogate (U+D800)', () => {
    const p = fixedProvider(KEY_A);
    // '\uD800' is a lone high surrogate — not valid Unicode, not round-trippable via UTF-8
    expect(() => encryptField('\uD800', p)).toThrow('lone surrogates');
  });

  it('throws when plaintext contains a lone low surrogate (U+DC00)', () => {
    const p = fixedProvider(KEY_A);
    expect(() => encryptField('\uDC00', p)).toThrow('lone surrogates');
  });

  it('throws for the partial emoji surrogate (U+D83D)', () => {
    const p = fixedProvider(KEY_A);
    expect(() => encryptField('\uD83D', p)).toThrow('lone surrogates');
  });

  it('still round-trips a valid emoji (properly paired surrogates)', () => {
    const p = fixedProvider(KEY_A);
    // U+1F600 GRINNING FACE — encoded as surrogate pair D83D DE00 in UTF-16
    const blob = encryptField('\u{1F600}', p);
    expect(decryptField(blob, p)).toBe('\u{1F600}');
  });
});


// ── Program-Fix 46A: v2 envelope, context bound into the AAD (reader side) ──
describe('field-crypto v2 (context-bound AAD)', () => {
  const p = fixedProvider(KEY_A);
  const CTX = { table: 'customers', column: 'full_name_enc', row: ['acme', '15550001111'] };

  afterEach(() => __setFieldCryptoWriteV2ForTests(false));

  it('aadFor pins the exact AAD string (kid k0 bound in)', () => {
    expect(aadFor(CTX)).toBe('v2|k0|customers|full_name_enc|acme|15550001111');
    expect(aadFor({ table: 'transfers', column: 'payout_destination_enc', row: ['a|b c'] })).toBe(
      'v2|k0|transfers|payout_destination_enc|a%7Cb%20c',
    );
    expect(aadFor({ table: 'purpose', column: 'customer_ref', row: [] })).toBe('v2|k0|purpose|customer_ref|');
  });

  it('sealFieldV2 emits v2.<kid>.<iv>.<tag>.<wdek>.<ct>', () => {
    const blob = sealFieldV2('Jane Roe', p, CTX);
    const parts = blob.split('.');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toBe('k0');
  });

  it('v2 opens only with its exact ctx', () => {
    const blob = sealFieldV2('Jane Roe', p, CTX);
    expect(decryptField(blob, p, CTX)).toBe('Jane Roe');
    expect(decryptField(blob, p, { ...CTX, row: [...CTX.row] })).toBe('Jane Roe');
  });

  it('v2 moved to another column/row/table fails the GCM tag', () => {
    const blob = sealFieldV2('Jane Roe', p, CTX);
    expect(() => decryptField(blob, p, { ...CTX, column: 'date_of_birth_enc' })).toThrow();
    expect(() => decryptField(blob, p, { ...CTX, row: ['acme', '15550002222'] })).toThrow();
    expect(() => decryptField(blob, p, { ...CTX, row: ['other', '15550001111'] })).toThrow();
    expect(() => decryptField(blob, p, { ...CTX, table: 'waitlist_signups' })).toThrow();
    // Row-part boundaries are unambiguous: ['a|b'] never equals ['a','b'].
    const joined = sealFieldV2('x', p, { table: 't', column: 'c', row: ['a|b'] });
    expect(() => decryptField(joined, p, { table: 't', column: 'c', row: ['a', 'b'] })).toThrow();
  });

  it('a ctx-mismatch error never echoes the row key (no PII in errors)', () => {
    const blob = sealFieldV2('Jane Roe', p, CTX);
    let msg = '';
    try {
      decryptField(blob, p, { ...CTX, row: ['acme', '15550009999'] });
    } catch (err) {
      msg = String(err instanceof Error ? err.message : err);
    }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('1555000');
    expect(msg).not.toContain('acme');
  });

  it('v2 without ctx throws', () => {
    const blob = sealFieldV2('Jane Roe', p, CTX);
    expect(() => decryptField(blob, p)).toThrow(/context/);
  });

  it('v2 with an unknown kid is refused', () => {
    const blob = sealFieldV2('Jane Roe', p, CTX).replace(/^v2\.k0\./, 'v2.k1.');
    expect(() => decryptField(blob, p, CTX)).toThrow();
  });

  it('v2 with the wrong number of segments is malformed', () => {
    expect(() => decryptField('v2.k0.a.b.c', p, CTX)).toThrow(/malformed/);
  });

  it('v1 opens with any ctx (ctx ignored on legacy blobs)', () => {
    const blob = encryptField('legacy', p);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(decryptField(blob, p, CTX)).toBe('legacy');
    expect(decryptField(blob, p, { table: 'x', column: 'y', row: ['z'] })).toBe('legacy');
  });

  it('v1 opens with a malformed or empty ctx (hot path never validates ctx on v1)', () => {
    const blob = encryptField('legacy', p);
    const junk = { table: 'BAD TABLE!', column: '', row: [undefined as unknown as string] };
    expect(decryptField(blob, p, junk)).toBe('legacy');
    expect(decryptField(blob, p, { table: '', column: '', row: [] })).toBe('legacy');
  });

  it('46B: encryptField writes v2 whenever it is given a ctx (no seam needed)', () => {
    const blob = encryptField('now v2', p, CTX);
    expect(blob.startsWith('v2.k0.')).toBe(true);
    expect(blob.split('.')).toHaveLength(6);
    expect(decryptField(blob, p, CTX)).toBe('now v2');
    // Bound to its context: it does not open anywhere else.
    expect(() => decryptField(blob, p, { ...CTX, column: 'date_of_birth_enc' })).toThrow();
  });

  it('46B: encryptField without a ctx still writes v1 (nothing to bind; the src guard test forbids it)', () => {
    const blob = encryptField('no ctx', p);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob.split('.')).toHaveLength(5);
  });

  it('46B: the retired seam is a no-op in both directions (false never brings v1 back)', () => {
    __setFieldCryptoWriteV2ForTests(false);
    expect(encryptField('after false', p, CTX).startsWith('v2.k0.')).toBe(true);
    __setFieldCryptoWriteV2ForTests(true);
    expect(encryptField('after true', p, CTX).startsWith('v2.k0.')).toBe(true);
    expect(encryptField('no ctx', p).startsWith('v1.')).toBe(true);
  });

  it('the seam refuses to turn on in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => __setFieldCryptoWriteV2ForTests(true)).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('v2 refuses an invalid ctx at seal and open time', () => {
    expect(() => sealFieldV2('x', p, { table: 'Bad Table', column: 'c', row: [] })).toThrow();
    expect(() => sealFieldV2('x', p, { table: 't', column: 'c', row: [undefined as unknown as string] })).toThrow();
    const blob = sealFieldV2('x', p, { table: 't', column: 'c', row: ['r'] });
    expect(() => decryptField(blob, p, { table: 't', column: '', row: ['r'] })).toThrow();
  });

  it('v2 tamper detection still holds', () => {
    const blob = sealFieldV2('Jane Roe', p, CTX);
    const parts = blob.split('.');
    const ct = Buffer.from(parts[5], 'base64url');
    ct[0] ^= 0x01;
    parts[5] = ct.toString('base64url');
    expect(() => decryptField(parts.join('.'), p, CTX)).toThrow();
  });
});


// ── Program-Fix 46B: FIELD_CRYPTO_REJECT_V1 (reader switch, OFF by default) ──
describe('field-crypto FIELD_CRYPTO_REJECT_V1', () => {
  const p = fixedProvider(KEY_A);
  const COLUMN = ctx.customer('acme', '15550001111', 'full_name_enc');
  const legacy = () => encryptField('legacy', p); // no ctx ⇒ a v1 blob, as legacy rows are

  afterEach(() => vi.unstubAllEnvs());

  it('flag unset (the default): a v1 blob opens under a column ctx and apply_link', () => {
    vi.stubEnv('FIELD_CRYPTO_REJECT_V1', '');
    expect(env.fieldCryptoRejectV1).toBe(false);
    expect(decryptField(legacy(), p, COLUMN)).toBe('legacy');
    expect(decryptField(legacy(), p, outboxSealedCtx('apply_link'))).toBe('legacy');
  });

  it('flag set to anything but "true" stays off', () => {
    vi.stubEnv('FIELD_CRYPTO_REJECT_V1', '1');
    expect(env.fieldCryptoRejectV1).toBe(false);
    expect(decryptField(legacy(), p, COLUMN)).toBe('legacy');
  });

  it('flag on: v1 is refused for a column ctx and for outbox apply_link', () => {
    vi.stubEnv('FIELD_CRYPTO_REJECT_V1', 'true');
    expect(env.fieldCryptoRejectV1).toBe(true);
    expect(() => decryptField(legacy(), p, COLUMN)).toThrow(/v1/);
    expect(() => decryptField(legacy(), p, ctx.integration('acme', 'wa_app_secret_enc'))).toThrow(/v1/);
    expect(() => decryptField(legacy(), p, outboxSealedCtx('apply_link'))).toThrow(/v1/);
  });

  it('flag on: v1 is still accepted for the permanent exemptions (staffMfa, customer_ref)', () => {
    vi.stubEnv('FIELD_CRYPTO_REJECT_V1', 'true');
    expect(decryptField(legacy(), p, ctx.staffMfa('seed-admin'))).toBe('legacy');
    expect(decryptField(legacy(), p, ctx.purpose('customer_ref'))).toBe('legacy');
  });

  it('flag on: v2 blobs are unaffected', () => {
    vi.stubEnv('FIELD_CRYPTO_REJECT_V1', 'true');
    const blob = encryptField('fresh', p, COLUMN);
    expect(decryptField(blob, p, COLUMN)).toBe('fresh');
  });

  it('flag on: the refusal never echoes the row key', () => {
    vi.stubEnv('FIELD_CRYPTO_REJECT_V1', 'true');
    let msg = '';
    try {
      decryptField(legacy(), p, COLUMN);
    } catch (err) {
      msg = String(err instanceof Error ? err.message : err);
    }
    expect(msg).not.toBe('');
    expect(msg).not.toContain('1555000');
    expect(msg).not.toContain('acme');
  });
});
