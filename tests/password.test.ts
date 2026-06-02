import { describe, it, expect } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import { hashPassword, verifyPassword } from '@/lib/password';

describe('password', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('s3cret!');
    expect(await verifyPassword('s3cret!', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('s3cret!');
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces a different hash each time (random salt)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('rejects a malformed stored value', async () => {
    expect(await verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });

  it('still verifies a legacy scrypt salt:hash (migration back-compat)', async () => {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync('s3cret!', salt, 64).toString('hex');
    const legacy = `${salt}:${hash}`;
    expect(await verifyPassword('s3cret!', legacy)).toBe(true);
    expect(await verifyPassword('wrong', legacy)).toBe(false);
  });
});
