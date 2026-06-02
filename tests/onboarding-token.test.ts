import { describe, it, expect } from 'vitest';
import { fakeRedis } from './helpers';
import { createOnboardingTokenStore } from '@/lib/onboarding-token';

const PHONE_RAW = '+1 (555) 010-2030'; // normalizes to 15550102030
const NORM = '15550102030';

function store(redis = fakeRedis()) {
  return createOnboardingTokenStore(redis);
}

describe('onboarding token', () => {
  it('issues a 256-bit hex token that verifies back to the normalized phone', async () => {
    const s = store();
    const token = await s.createOnboardingToken(PHONE_RAW);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.verifyOnboardingToken(token)).toBe(NORM);
  });

  it('does NOT consume on verify — the token resolves repeatedly (register consumes)', async () => {
    const s = store();
    const token = await s.createOnboardingToken(NORM);
    expect(await s.verifyOnboardingToken(token)).toBe(NORM);
    // Still resolvable a second time — verify is read-only.
    expect(await s.verifyOnboardingToken(token)).toBe(NORM);
  });

  it('consumeOnboardingToken returns the phone once, then null (single-use)', async () => {
    const s = store();
    const token = await s.createOnboardingToken(NORM);
    expect(await s.consumeOnboardingToken(token)).toBe(NORM);
    expect(await s.consumeOnboardingToken(token)).toBeNull();
    // And after consume, verify no longer resolves it.
    expect(await s.verifyOnboardingToken(token)).toBeNull();
  });

  it('returns null for an unknown / forged token', async () => {
    const s = store();
    expect(await s.verifyOnboardingToken('deadbeef')).toBeNull();
    expect(await s.consumeOnboardingToken('deadbeef')).toBeNull();
  });

  it('stores only a hash at rest — the raw token never appears as a Redis key', async () => {
    const redis = fakeRedis();
    const s = store(redis);
    const token = await s.createOnboardingToken(NORM);
    expect([...redis.dump.keys()].some((k) => k.includes(token))).toBe(false);
    // and the value stored is the phone (so the store key is the hash, not the token)
    expect([...redis.dump.values()]).toContain(NORM);
  });
});
