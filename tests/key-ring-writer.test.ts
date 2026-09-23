import { afterEach, describe, it, expect, vi } from 'vitest';
import { createDecipheriv } from 'node:crypto';
import {
  EnvKeyProvider,
  EnvKeyRing,
  decryptField,
  defaultProvider,
  encryptField,
  sealFieldV2,
} from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';

// Program-Fix 45 P4 — the key-ring WRITER. encryptField seals under the
// configured current kid (FIELD_ENCRYPTION_CURRENT_KID, default k0), wrapping
// the DEK with THAT kid's ring key. It fails closed: a current kid that is
// malformed or missing from the ring refuses the write. With the production
// config (the env unset) every write is byte-shaped exactly as before: v2.k0
// under FIELD_ENCRYPTION_KEY.
//
// Keys are built at runtime (no key-shaped literals in the repo).
const KEY_0 = Buffer.alloc(32, 7);
const KEY_1 = Buffer.alloc(32, 9);
const hex = (b: Buffer) => b.toString('hex');
const b64 = (b: Buffer) => b.toString('base64');

const C = ctx.transfer('tr_golden', 'payout_destination_enc');
// Hand-written AAD strings (NOT via aadFor), so these tests are independent.
const AAD_K0 = 'v2|k0|transfers|payout_destination_enc|tr_golden';
const AAD_K1 = 'v2|k1|transfers|payout_destination_enc|tr_golden';

/** Open a v2/v1 blob by hand with raw node:crypto (independent of the reader). */
function openByHand(blob: string, masterKey: Buffer, aad: string): string {
  const [ivS, tagS, wS, ctS] = blob.split('.').slice(-4);
  const wrapped = Buffer.from(wS, 'base64url');
  const w = createDecipheriv('aes-256-gcm', masterKey, wrapped.subarray(0, 12));
  w.setAuthTag(wrapped.subarray(12, 28));
  const dek = Buffer.concat([w.update(wrapped.subarray(28)), w.final()]);
  const d = createDecipheriv('aes-256-gcm', dek, Buffer.from(ivS, 'base64url'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ctS, 'base64url')), d.final()]).toString('utf8');
}

const V2_SHAPE = (kid: string) =>
  new RegExp(`^v2\\.${kid}\\.[A-Za-z0-9_-]{16}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{80}\\.[A-Za-z0-9_-]+$`);

function env(opts: { ring?: string; current?: string }) {
  vi.stubEnv('FIELD_ENCRYPTION_KEY', hex(KEY_0));
  if (opts.ring !== undefined) vi.stubEnv('FIELD_ENCRYPTION_PREVIOUS_KEYS', opts.ring);
  if (opts.current !== undefined) vi.stubEnv('FIELD_ENCRYPTION_CURRENT_KID', opts.current);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GOLDEN (production config): writes are byte-shaped exactly as before', () => {
  it('CURRENT_KID unset → v2.k0 under FIELD_ENCRYPTION_KEY', () => {
    env({});
    const blob = encryptField('IFSC0001 / 000123456789', defaultProvider(), C);
    expect(blob).toMatch(V2_SHAPE('k0'));
    expect(openByHand(blob, KEY_0, AAD_K0)).toBe('IFSC0001 / 000123456789');
  });

  it('CURRENT_KID empty or explicitly k0 → v2.k0, even with a k1 ring configured', () => {
    for (const current of ['', 'k0', ' k0 ']) {
      env({ ring: `k1:${b64(KEY_1)}`, current });
      const blob = encryptField('same', defaultProvider(), C);
      expect(blob).toMatch(V2_SHAPE('k0'));
      expect(openByHand(blob, KEY_0, AAD_K0)).toBe('same');
      vi.unstubAllEnvs();
    }
  });

  it('an injected plain provider with CURRENT_KID unset still writes v2.k0 (every existing call site)', () => {
    env({});
    const blob = encryptField('x', new EnvKeyProvider(KEY_1), C);
    expect(blob).toMatch(V2_SHAPE('k0'));
    expect(openByHand(blob, KEY_1, AAD_K0)).toBe('x');
  });

  it('a write without a ctx stays v1 under k0 (no kid slot), whatever CURRENT_KID says', () => {
    env({ ring: `k1:${b64(KEY_1)}`, current: 'k1' });
    const blob = encryptField('legacy', defaultProvider());
    expect(blob.split('.')).toHaveLength(5);
    expect(blob.startsWith('v1.')).toBe(true);
    expect(openByHand(blob, KEY_0, 'v1')).toBe('legacy');
  });
});

describe('the current kid (rotation-ready, never used in production)', () => {
  it('CURRENT_KID=k1 with k1 in the ring → v2.k1, the DEK wrapped under the k1 key', () => {
    env({ ring: `k1:${b64(KEY_1)}`, current: 'k1' });
    const blob = encryptField('rotated', defaultProvider(), C);
    expect(blob).toMatch(V2_SHAPE('k1'));
    expect(openByHand(blob, KEY_1, AAD_K1)).toBe('rotated');
    expect(() => openByHand(blob, KEY_0, AAD_K1)).toThrow(); // not wrapped under k0
    expect(() => openByHand(blob, KEY_1, AAD_K0)).toThrow(); // the kid is bound
    // and the reader opens it
    expect(decryptField(blob, defaultProvider(), C)).toBe('rotated');
  });

  it('sealFieldV2 with an explicit ring kid wraps under THAT kid', () => {
    const ring = new EnvKeyRing(KEY_0, `k1:${hex(KEY_1)}`);
    const blob = sealFieldV2('explicit', ring, C, 'k1');
    expect(blob).toMatch(V2_SHAPE('k1'));
    expect(openByHand(blob, KEY_1, AAD_K1)).toBe('explicit');
  });

  it('sealFieldV2 never uses a plain provider for a non-k0 kid', () => {
    expect(() => sealFieldV2('x', new EnvKeyProvider(KEY_1), C, 'k1')).toThrow(/unknown key id/);
  });
});

describe('fail closed: a bad current kid refuses the write', () => {
  it('CURRENT_KID=k1 but the ring lacks k1 → throws, naming only the env var', () => {
    env({ current: 'k1' });
    let msg = '';
    try {
      encryptField('x', defaultProvider(), C);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/FIELD_ENCRYPTION_CURRENT_KID/);
    expect(msg).not.toContain(hex(KEY_0).slice(0, 16));
  });

  it('CURRENT_KID=k1 with an injected plain provider → throws (never silently k0 or the plain key)', () => {
    env({ current: 'k1' });
    expect(() => encryptField('x', new EnvKeyProvider(KEY_1), C)).toThrow(/FIELD_ENCRYPTION_CURRENT_KID/);
  });

  it.each(['K1', 'k01', 'k1000', '__proto__', 'kx', 'k1|x', 'k-1'])(
    'a malformed CURRENT_KID %j throws before any key use',
    (current) => {
      env({ ring: `k1:${b64(KEY_1)}`, current });
      expect(() => encryptField('x', defaultProvider(), C)).toThrow(/FIELD_ENCRYPTION_CURRENT_KID is not a valid key id/);
    },
  );

  it('a malformed ring env with CURRENT_KID=k1 throws (the write is refused)', () => {
    env({ ring: 'garbage', current: 'k1' });
    expect(() => encryptField('x', defaultProvider(), C)).toThrow();
  });
});
