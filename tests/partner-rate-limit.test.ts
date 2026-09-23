import { describe, it, expect } from 'vitest';
import { checkPartnerRateLimit } from '@/lib/partner-rate-limit';
import { fakeRedis } from './helpers';

const T = 1_000_000_000_000; // fixed "now" inside one minute window

describe('checkPartnerRateLimit', () => {
  it('allows up to the limit then blocks', async () => {
    const redis = fakeRedis();
    const hits = [];
    for (let i = 0; i < 4; i++) hits.push(await checkPartnerRateLimit(redis, 'acme', { limit: 3, now: T }));
    expect(hits.map((h) => h.allowed)).toEqual([true, true, true, false]);
    expect(hits[0].remaining).toBe(2);
    expect(hits[3].remaining).toBe(0);
  });

  it('is PER-PARTNER: A exhausting its budget does not throttle B', async () => {
    const redis = fakeRedis();
    await checkPartnerRateLimit(redis, 'acme', { limit: 1, now: T });
    const aSecond = await checkPartnerRateLimit(redis, 'acme', { limit: 1, now: T });
    const bFirst = await checkPartnerRateLimit(redis, 'globex', { limit: 1, now: T });
    expect(aSecond.allowed).toBe(false);
    expect(bFirst.allowed).toBe(true);
  });

  it('resets in the next minute window', async () => {
    const redis = fakeRedis();
    await checkPartnerRateLimit(redis, 'acme', { limit: 1, now: T });
    const sameWindow = await checkPartnerRateLimit(redis, 'acme', { limit: 1, now: T });
    const nextWindow = await checkPartnerRateLimit(redis, 'acme', { limit: 1, now: T + 60_000 });
    expect(sameWindow.allowed).toBe(false);
    expect(nextWindow.allowed).toBe(true);
  });

  // Program-Fix 44 P1: a per-KEY window alongside the per-partner one; both must pass.
  it('is also PER-KEY: key A is blocked at keyLimit while the partner has budget, and key B still passes', async () => {
    const redis = fakeRedis();
    const opts = { limit: 100, keyLimit: 2, now: T };
    const a = [];
    for (let i = 0; i < 3; i++) a.push(await checkPartnerRateLimit(redis, 'acme', { ...opts, keyId: 'pk_live_A' }));
    expect(a.map((h) => h.allowed)).toEqual([true, true, false]);
    expect(a[2].remaining).toBe(0);
    const b = await checkPartnerRateLimit(redis, 'acme', { ...opts, keyId: 'pk_live_B' });
    expect(b.allowed).toBe(true);
    expect(await redis.get(`ratelimit:key:pk_live_A:${Math.floor(T / 60_000)}`)).toBe('3');
  });

  it('the partner window still binds across keys (both must pass)', async () => {
    const redis = fakeRedis();
    const opts = { limit: 2, keyLimit: 100, now: T };
    await checkPartnerRateLimit(redis, 'acme', { ...opts, keyId: 'pk_live_A' });
    await checkPartnerRateLimit(redis, 'acme', { ...opts, keyId: 'pk_live_B' });
    const third = await checkPartnerRateLimit(redis, 'acme', { ...opts, keyId: 'pk_live_C' });
    expect(third.allowed).toBe(false);
  });

  it('the per-key default equals the partner default (120/min)', async () => {
    const redis = fakeRedis();
    const r = await checkPartnerRateLimit(redis, 'acme', { keyId: 'pk_live_A', now: T });
    expect(r.limit).toBe(120);
    expect(r.remaining).toBe(119);
  });
});

