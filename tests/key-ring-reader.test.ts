import { afterEach, describe, it, expect, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  EnvKeyProvider,
  EnvKeyRing,
  aadFor,
  decryptField,
  defaultProvider,
  encryptField,
  parseKeyRingEntries,
  sealFieldV2,
} from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import { REQUIRED_PRODUCTION_VARS } from '@/lib/boot-assert';

// Program-Fix 45 P3 — the key-ring READER. The app must read a v2 blob under
// any kid in the configured ring, while every WRITE stays byte-for-byte shaped
// as on main (v2 k0 under FIELD_ENCRYPTION_KEY, or v1 without a context).
//
// Keys are built at runtime (no key-shaped literals in the repo).
const KEY_0 = Buffer.alloc(32, 7);
const KEY_1 = Buffer.alloc(32, 9);
const KEY_2 = Buffer.alloc(32, 11);
const hex = (b: Buffer) => b.toString('hex');
const b64 = (b: Buffer) => b.toString('base64');
const b64url = (b: Buffer) => b.toString('base64url');

const C = ctx.transfer('tr_golden', 'payout_destination_enc');
// Hand-written AAD (NOT via aadFor) so the golden tests are independent.
const AAD_K0 = 'v2|k0|transfers|payout_destination_enc|tr_golden';
const AAD_K1 = 'v2|k1|transfers|payout_destination_enc|tr_golden';

/** Seal a v2 blob by hand, exactly as fix 46 specifies, under any kid. */
function sealByHand(plain: string, masterKey: Buffer, kid: string, aad: string): string {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()]);
  const tag = c.getAuthTag();
  const wiv = randomBytes(12);
  const w = createCipheriv('aes-256-gcm', masterKey, wiv);
  const wct = Buffer.concat([w.update(dek), w.final()]);
  const wrapped = Buffer.concat([wiv, w.getAuthTag(), wct]);
  return ['v2', kid, b64url(iv), b64url(tag), b64url(wrapped), b64url(ct)].join('.');
}

/** Open a blob by hand (independent of field-crypto's reader). */
function openByHand(blob: string, masterKey: Buffer, aad: string): string {
  const parts = blob.split('.');
  const [ivS, tagS, wS, ctS] = parts.slice(-4);
  const wrapped = Buffer.from(wS, 'base64url');
  const w = createDecipheriv('aes-256-gcm', masterKey, wrapped.subarray(0, 12));
  w.setAuthTag(wrapped.subarray(12, 28));
  const dek = Buffer.concat([w.update(wrapped.subarray(28)), w.final()]);
  const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(ivS, 'base64url'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ctS, 'base64url')), d.final()]).toString('utf8');
}

function withRing(extra: string | undefined, currentKid?: string) {
  vi.stubEnv('FIELD_ENCRYPTION_KEY', hex(KEY_0));
  if (extra !== undefined) vi.stubEnv('FIELD_ENCRYPTION_PREVIOUS_KEYS', extra);
  if (currentKid !== undefined) vi.stubEnv('FIELD_ENCRYPTION_CURRENT_KID', currentKid);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('key ring — reads by the blob kid', () => {
  it('a k1 blob opens when k1 is in the ring (default provider from env)', () => {
    withRing(`k1:${b64(KEY_1)}`);
    const blob = sealByHand('acct 1234', KEY_1, 'k1', AAD_K1);
    expect(decryptField(blob, defaultProvider(), C)).toBe('acct 1234');
  });

  it('a k1 blob opens with an explicit EnvKeyRing (hex and base64 entries, spaces tolerated)', () => {
    const ring = new EnvKeyRing(KEY_0, ` k1:${hex(KEY_1)} , k2:${b64(KEY_2)} `);
    expect(decryptField(sealByHand('one', KEY_1, 'k1', AAD_K1), ring, C)).toBe('one');
    const aad2 = 'v2|k2|transfers|payout_destination_enc|tr_golden';
    expect(decryptField(sealByHand('two', KEY_2, 'k2', aad2), ring, C)).toBe('two');
  });

  it('a k0 v2 blob (as main writes it) still opens under FIELD_ENCRYPTION_KEY with a ring configured', () => {
    withRing(`k1:${b64(KEY_1)}`);
    const blob = sealByHand('k0 value', KEY_0, 'k0', AAD_K0);
    expect(decryptField(blob, defaultProvider(), C)).toBe('k0 value');
    // and one written by encryptField itself
    const own = encryptField('k0 own', defaultProvider(), C);
    expect(decryptField(own, defaultProvider(), C)).toBe('k0 own');
  });

  it('a v1 blob still opens under k0 with a ring configured', () => {
    withRing(`k1:${b64(KEY_1)}`);
    const v1 = encryptField('legacy', new EnvKeyProvider(KEY_0));
    expect(v1.startsWith('v1.')).toBe(true);
    expect(decryptField(v1, defaultProvider(), C)).toBe('legacy');
  });

  it('v1 never tries ring keys: a v1 blob sealed under the k1 key does not open (no trial decryption)', () => {
    withRing(`k1:${b64(KEY_1)}`);
    const v1UnderK1 = encryptField('x', new EnvKeyProvider(KEY_1));
    expect(() => decryptField(v1UnderK1, defaultProvider(), C)).toThrow();
  });

  it('an unknown kid throws (ring without k1)', () => {
    withRing(undefined);
    const blob = sealByHand('x', KEY_1, 'k1', AAD_K1);
    expect(() => decryptField(blob, defaultProvider(), C)).toThrow(/unknown key id/);
  });

  it('a non-ring provider is NEVER used for a non-k0 kid, even when it holds the right key', () => {
    const blob = sealByHand('x', KEY_1, 'k1', AAD_K1);
    expect(() => decryptField(blob, new EnvKeyProvider(KEY_1), C)).toThrow(/unknown key id/);
  });

  it('a kid edited k0 → k1 fails GCM (AAD-bound), even when k1 holds the SAME key', () => {
    const blob = sealByHand('x', KEY_0, 'k0', AAD_K0);
    const edited = blob.replace(/^v2\.k0\./, 'v2.k1.');
    const sameKeyRing = new EnvKeyRing(KEY_0, `k1:${hex(KEY_0)}`);
    expect(() => decryptField(edited, sameKeyRing, C)).toThrow();
    const otherKeyRing = new EnvKeyRing(KEY_0, `k1:${hex(KEY_1)}`);
    expect(() => decryptField(edited, otherKeyRing, C)).toThrow();
  });

  it('a v2 blob relabelled as v1 (kid segment dropped) throws — no downgrade to the unbound path', () => {
    const ring = new EnvKeyRing(KEY_0, `k1:${hex(KEY_1)}`);
    for (const [blob, kid] of [
      [sealByHand('x', KEY_0, 'k0', AAD_K0), 'k0'],
      [sealByHand('x', KEY_1, 'k1', AAD_K1), 'k1'],
    ] as const) {
      const relabelled = blob.replace(new RegExp(`^v2\\.${kid}\\.`), 'v1.');
      expect(relabelled.split('.')).toHaveLength(5);
      expect(() => decryptField(relabelled, ring, C)).toThrow();
      expect(() => decryptField(relabelled, ring)).toThrow();
    }
  });

  it('a kid edited k1 → k0 fails', () => {
    const ring = new EnvKeyRing(KEY_0, `k1:${hex(KEY_1)}`);
    const blob = sealByHand('x', KEY_1, 'k1', AAD_K1);
    expect(() => decryptField(blob.replace(/^v2\.k1\./, 'v2.k0.'), ring, C)).toThrow();
  });

  it('a k1 blob moved to another row fails (context still bound)', () => {
    const ring = new EnvKeyRing(KEY_0, `k1:${hex(KEY_1)}`);
    const blob = sealByHand('x', KEY_1, 'k1', AAD_K1);
    expect(() => decryptField(blob, ring, ctx.transfer('tr_other', 'payout_destination_enc'))).toThrow();
  });

  it.each(['K1', 'k01', 'k1000', 'k', 'kx', '__proto__', 'constructor', 'k1 ', 'k-1', ''])(
    'a malformed kid %j throws "unknown key id" before any key use',
    (kid) => {
      const ring = new EnvKeyRing(KEY_0, `k1:${hex(KEY_1)}`);
      const blob = sealByHand('x', KEY_1, 'k1', AAD_K1).replace(/^v2\.k1\./, `v2.${kid}.`);
      expect(() => decryptField(blob, ring, C)).toThrow(/unknown key id|malformed/);
    },
  );
});

describe('key ring — FIELD_ENCRYPTION_PREVIOUS_KEYS parsing', () => {
  it('parses a kid:key comma list into a Map', () => {
    const m = parseKeyRingEntries(`k1:${hex(KEY_1)},k2:${b64(KEY_2)}`);
    expect([...m.keys()]).toEqual(['k1', 'k2']);
    expect(m.get('k1')?.equals(KEY_1)).toBe(true);
    expect(m.get('k2')?.equals(KEY_2)).toBe(true);
  });

  it('empty or unset → an empty ring', () => {
    expect(parseKeyRingEntries('').size).toBe(0);
    expect(parseKeyRingEntries(undefined).size).toBe(0);
    expect(parseKeyRingEntries(' , ').size).toBe(0);
  });

  it('refuses a k0 entry (k0 is always FIELD_ENCRYPTION_KEY, never shadowed)', () => {
    expect(() => parseKeyRingEntries(`k0:${hex(KEY_1)}`)).toThrow(/FIELD_ENCRYPTION_PREVIOUS_KEYS/);
  });

  it('refuses a duplicate kid, a bad kid and a key that is not 32 bytes — never echoing the value', () => {
    const secretish = hex(KEY_1);
    for (const raw of [
      `k1:${secretish},k1:${secretish}`,
      `kx:${secretish}`,
      `k1:${secretish.slice(0, 20)}`,
      'k1',
      `:${secretish}`,
    ]) {
      let msg = '';
      try {
        parseKeyRingEntries(raw);
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(/FIELD_ENCRYPTION_PREVIOUS_KEYS/);
      expect(msg).not.toContain(secretish.slice(0, 20));
    }
  });

  it('a malformed optional env never breaks a k0 read, a v1 read or a write; only a k1 read throws', () => {
    withRing('garbage-without-a-colon');
    const k0 = sealByHand('k0 ok', KEY_0, 'k0', AAD_K0);
    expect(decryptField(k0, defaultProvider(), C)).toBe('k0 ok');
    const v1 = encryptField('v1 ok', new EnvKeyProvider(KEY_0));
    expect(decryptField(v1, defaultProvider(), C)).toBe('v1 ok');
    const written = encryptField('write ok', defaultProvider(), C);
    expect(openByHand(written, KEY_0, AAD_K0)).toBe('write ok');
    const k1 = sealByHand('x', KEY_1, 'k1', AAD_K1);
    expect(() => decryptField(k1, defaultProvider(), C)).toThrow(/FIELD_ENCRYPTION_PREVIOUS_KEYS/);
  });

  it('a k0 entry in the env does not change which key opens k0', () => {
    withRing(`k0:${hex(KEY_1)}`);
    const k0 = sealByHand('still FEK', KEY_0, 'k0', AAD_K0);
    expect(decryptField(k0, defaultProvider(), C)).toBe('still FEK');
  });
});

describe('aadFor with the blob kid (fix 45 extends fix 46)', () => {
  it('binds a ring kid; the default stays the pinned k0 string', () => {
    expect(aadFor(C)).toBe(AAD_K0);
    expect(aadFor(C, 'k0')).toBe(AAD_K0);
    expect(aadFor(C, 'k1')).toBe(AAD_K1);
    expect(aadFor(C, 'k42')).toBe('v2|k42|transfers|payout_destination_enc|tr_golden');
  });

  it.each(['K1', 'k01', 'k1000', '__proto__', 'k1|x', ''])('refuses the kid %j', (kid) => {
    expect(() => aadFor(C, kid)).toThrow(/unknown key id/);
  });
});

describe('GOLDEN: P3 writes exactly what main writes', () => {
  // Segment lengths of the v2/v1 envelope: iv 12 B → 16 chars, tag 16 B → 22,
  // wrapped DEK (12 + 16 + 32 B) → 80, ct = plaintext bytes in base64url.
  const b64urlLen = (n: number) => Math.ceil((n * 4) / 3);

  // Program-Fix 45 P4: the writer may now seal under a ring kid (see
  // tests/key-ring-writer.test.ts); a kid the ring lacks is still refused.
  it('sealFieldV2 refuses a kid the ring does not hold', () => {
    const ring = new EnvKeyRing(KEY_0, `k1:${hex(KEY_1)}`);
    expect(() => sealFieldV2('x', ring, C, 'k2')).toThrow(/unknown key id/);
  });

  // Program-Fix 45 P4 flips this: with CURRENT_KID=k1 the writer now writes k1
  // (tests/key-ring-writer.test.ts). The PRODUCTION config (CURRENT_KID unset)
  // still writes exactly this k0 shape, even with a k1 ring configured.
  it('encryptField with a ctx → v2.k0 under FIELD_ENCRYPTION_KEY with a k1 ring and CURRENT_KID unset', () => {
    withRing(`k1:${b64(KEY_1)}`);
    const plain = 'IFSC0001 / 000123456789';
    const blob = encryptField(plain, defaultProvider(), C);
    const parts = blob.split('.');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toBe('k0');
    expect(parts[2]).toHaveLength(16);
    expect(parts[3]).toHaveLength(22);
    expect(parts[4]).toHaveLength(80);
    expect(parts[5]).toHaveLength(b64urlLen(Buffer.byteLength(plain)));
    expect(blob).toMatch(/^v2\.k0\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{80}\.[A-Za-z0-9_-]+$/);
    // Opens by hand under FIELD_ENCRYPTION_KEY and the hand-written k0 AAD.
    expect(openByHand(blob, KEY_0, AAD_K0)).toBe(plain);
    // …and NOT under the k1 key.
    expect(() => openByHand(blob, KEY_1, AAD_K0)).toThrow();
  });

  it('encryptField without a ctx → v1 (5 segments, AAD "v1") under FIELD_ENCRYPTION_KEY', () => {
    withRing(`k1:${b64(KEY_1)}`, 'k1');
    const blob = encryptField('legacy shape', defaultProvider());
    const parts = blob.split('.');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toHaveLength(16);
    expect(parts[2]).toHaveLength(22);
    expect(parts[3]).toHaveLength(80);
    expect(openByHand(blob, KEY_0, 'v1')).toBe('legacy shape');
  });

  it('defaultProvider() still wraps under FIELD_ENCRYPTION_KEY and is an EnvKeyProvider', () => {
    withRing(`k1:${b64(KEY_1)}`, 'k1');
    const p = defaultProvider();
    expect(p).toBeInstanceOf(EnvKeyProvider);
    const dek = randomBytes(32);
    const wrapped = p.wrapDataKey(dek);
    expect(new EnvKeyProvider(KEY_0).unwrapDataKey(wrapped).equals(dek)).toBe(true);
    expect(() => new EnvKeyProvider(KEY_1).unwrapDataKey(wrapped)).toThrow();
  });
});

describe('boot-assert parity: the ring envs are optional', () => {
  it('none of the three new names is boot-required', () => {
    const required: readonly string[] = REQUIRED_PRODUCTION_VARS;
    for (const n of ['FIELD_ENCRYPTION_PREVIOUS_KEYS', 'FIELD_ENCRYPTION_CURRENT_KID', 'PASSWORD_PEPPER_PREVIOUS']) {
      expect(required).not.toContain(n);
    }
  });
});
