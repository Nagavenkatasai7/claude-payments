import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import { hashPassword, verifyPassword, needsRehash } from '@/lib/password';

// Build a legacy scrypt `salt:hash` the EXACT way the old password.ts did, so
// the back-compat path is exercised against a real pre-migration value.
function legacyScrypt(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

afterEach(() => {
  delete process.env.PASSWORD_PEPPER;
});

describe('password — Argon2id', () => {
  it('hashPassword emits a $argon2id$ PHC string', async () => {
    const stored = await hashPassword('s3cret!');
    expect(stored.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  });

  it('verifyPassword is true for the correct password', async () => {
    const stored = await hashPassword('s3cret!');
    expect(await verifyPassword('s3cret!', stored)).toBe(true);
  });

  it('verifyPassword is false for a wrong password', async () => {
    const stored = await hashPassword('s3cret!');
    expect(await verifyPassword('nope', stored)).toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('returns false on a malformed stored value', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('x', '$argon2id$garbage')).toBe(false);
  });
});

describe('password — legacy scrypt back-compat', () => {
  it('verifies a hand-made legacy scrypt salt:hash', async () => {
    const legacy = legacyScrypt('s3cret!');
    expect(legacy).toContain(':');
    expect(legacy.startsWith('$argon2')).toBe(false);
    expect(await verifyPassword('s3cret!', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
  });
});

describe('password — needsRehash', () => {
  it('is true for a legacy scrypt hash', () => {
    expect(needsRehash(legacyScrypt('s3cret!'))).toBe(true);
  });

  it('is false for a fresh argon2id hash at target params', async () => {
    const stored = await hashPassword('s3cret!');
    expect(needsRehash(stored)).toBe(false);
  });

  it('is true for an argon2id hash below the target params', () => {
    // m below the 19456 floor ⇒ lazy upgrade needed.
    const weak = '$argon2id$v=19$m=4096,t=2,p=1$c29tZXNhbHQ$c29tZWhhc2g';
    expect(needsRehash(weak)).toBe(true);
  });
});

describe('password — pepper', () => {
  it('a wrong pepper fails verify', async () => {
    process.env.PASSWORD_PEPPER = 'pepper-A';
    const stored = await hashPassword('s3cret!');
    expect(await verifyPassword('s3cret!', stored)).toBe(true);

    process.env.PASSWORD_PEPPER = 'pepper-B';
    expect(await verifyPassword('s3cret!', stored)).toBe(false);
  });

  it('changes the produced hash vs no pepper', async () => {
    const noPepper = await hashPassword('s3cret!');
    process.env.PASSWORD_PEPPER = 'pepper-A';
    const peppered = await hashPassword('s3cret!');
    // Different salts make the strings differ regardless; assert the pepper is
    // actually applied by verifying cross-checks fail.
    expect(await verifyPassword('s3cret!', noPepper)).toBe(false);
    delete process.env.PASSWORD_PEPPER;
    expect(await verifyPassword('s3cret!', peppered)).toBe(false);
  });
});
