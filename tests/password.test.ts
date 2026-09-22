import { describe, it, expect, vi } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';

// Pass-through spies on hash-wasm so the enumeration tests below can COUNT the
// Argon2 work (fix 21): every existing test still runs the real functions.
const hw = vi.hoisted(() => ({
  argon2id: vi.fn(),
  argon2Verify: vi.fn(),
}));
vi.mock('hash-wasm', async (orig) => {
  const real = await orig<typeof import('hash-wasm')>();
  hw.argon2id.mockImplementation(real.argon2id);
  hw.argon2Verify.mockImplementation(real.argon2Verify);
  return { ...real, argon2id: hw.argon2id, argon2Verify: hw.argon2Verify };
});

import { hashPassword, verifyPassword, verifyPasswordOrDummy } from '@/lib/password';

// Fix 21 — the dummy path. This describe runs FIRST in the file on purpose: the
// dummy hash is memoized per module instance, so the "computed once" assertion
// needs these to be the first verifyPasswordOrDummy calls in the file.
describe('verifyPasswordOrDummy (fix 21, no timing oracle)', () => {
  it('runs exactly one Argon2 verify for a missing account, computes the dummy hash once, and is always false', async () => {
    hw.argon2id.mockClear();
    hw.argon2Verify.mockClear();

    expect(await verifyPasswordOrDummy('pw-one', undefined)).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(1);
    expect(hw.argon2id).toHaveBeenCalledTimes(1); // the one-off per-instance dummy hash

    expect(await verifyPasswordOrDummy('pw-two', '')).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(2);

    expect(await verifyPasswordOrDummy('pw-three', null)).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(3);
    expect(hw.argon2id).toHaveBeenCalledTimes(1); // memoized: never re-hashed
  });

  it('behaves exactly like verifyPassword when a real hash is stored', async () => {
    const stored = await hashPassword('s3cret!');
    hw.argon2id.mockClear();
    hw.argon2Verify.mockClear();
    expect(await verifyPasswordOrDummy('s3cret!', stored)).toBe(true);
    expect(await verifyPasswordOrDummy('wrong', stored)).toBe(false);
    expect(hw.argon2Verify).toHaveBeenCalledTimes(2);
    expect(hw.argon2id).not.toHaveBeenCalled(); // no dummy work on the real path
    // Legacy scrypt values take the legacy path, same as verifyPassword.
    const salt = randomBytes(16).toString('hex');
    const legacy = `${salt}:${scryptSync('s3cret!', salt, 64).toString('hex')}`;
    expect(await verifyPasswordOrDummy('s3cret!', legacy)).toBe(true);
    expect(await verifyPasswordOrDummy('nope', legacy)).toBe(false);
  });
});

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
