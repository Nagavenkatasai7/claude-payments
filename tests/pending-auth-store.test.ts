import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createPendingAuthStore } from '@/lib/pending-auth-store';

function mk() {
  const redis = fakeRedis();
  let t = 1_700_000_000_000;
  const store = createPendingAuthStore(redis, { now: () => t });
  return { store, redis, advance: (ms: number) => (t += ms) };
}

describe('pending-auth-store', () => {
  it('create → peek returns phone + purpose without consuming', async () => {
    const { store } = mk();
    const token = await store.create('+12025550123', 'login');
    expect(await store.peek(token)).toEqual({ phone: '+12025550123', purpose: 'login' });
    // peek did not consume — a second peek still works
    expect(await store.peek(token)).toEqual({ phone: '+12025550123', purpose: 'login' });
  });

  it('consume returns it once then the token is gone (single-use)', async () => {
    const { store } = mk();
    const token = await store.create('+12025550123', 'register');
    expect(await store.consume(token)).toEqual({ phone: '+12025550123', purpose: 'register' });
    expect(await store.consume(token)).toBeNull();
    expect(await store.peek(token)).toBeNull();
  });

  it('carries the purpose (a reset token is distinguishable from a login token)', async () => {
    const { store } = mk();
    const reset = await store.create('+12025550123', 'reset');
    expect((await store.peek(reset))?.purpose).toBe('reset');
  });

  it('returns null for a missing/empty token', async () => {
    const { store } = mk();
    expect(await store.peek('')).toBeNull();
    expect(await store.peek('nope')).toBeNull();
    expect(await store.consume('nope')).toBeNull();
  });

  it('expires after 5 minutes (in-code guard)', async () => {
    const { store, advance } = mk();
    const token = await store.create('+12025550123', 'login');
    advance(5 * 60 * 1000 + 1);
    expect(await store.peek(token)).toBeNull();
    expect(await store.consume(token)).toBeNull();
  });

  // Program-Fix 49D: the TOTP step of a password-proven sign-in.
  it("an 'mfa' token carries its password binding; tokens without one keep the old shape", async () => {
    const { store } = mk();
    const mfa = await store.create('+12025550123', 'mfa', { bind: 'a'.repeat(32) });
    expect(await store.peek(mfa)).toEqual({ phone: '+12025550123', purpose: 'mfa', bind: 'a'.repeat(32) });
    const reg = await store.create('+12025550123', 'register');
    expect(await store.peek(reg)).toEqual({ phone: '+12025550123', purpose: 'register' });
  });

  it('counts code attempts per token and refuses past the cap (the token is dropped)', async () => {
    const { store } = mk();
    const token = await store.create('+12025550123', 'mfa', { bind: 'b'.repeat(32) });
    for (let i = 0; i < 5; i++) expect(await store.countAttempt(token)).toBe(true);
    expect(await store.countAttempt(token)).toBe(false);
    expect(await store.peek(token)).toBeNull();
  });

  it('countAttempt refuses a missing token', async () => {
    const { store } = mk();
    expect(await store.countAttempt('')).toBe(false);
  });
});
