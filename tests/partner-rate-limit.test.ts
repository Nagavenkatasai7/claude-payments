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
});
