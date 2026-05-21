import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/password';

describe('password', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('s3cret!');
    expect(verifyPassword('s3cret!', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('s3cret!');
    expect(verifyPassword('wrong', stored)).toBe(false);
  });

  it('produces a different hash each time (random salt)', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects a malformed stored value', () => {
    expect(verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });
});
