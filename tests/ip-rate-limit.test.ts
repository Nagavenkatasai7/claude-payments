import { describe, it, expect } from 'vitest';
import { checkIpRateLimit, clientIpFrom } from '@/lib/ip-rate-limit';
import { fakeRedis } from './helpers';

const T0 = 1_750_000_000_000; // fixed wall-clock for deterministic windows

describe('checkIpRateLimit — fixed window per (scope, ip)', () => {
  it('allows up to the limit, then blocks within the same window', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 3; i++) {
      const r = await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, now: T0 });
      expect(r.allowed).toBe(true);
    }
    const fourth = await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, now: T0 });
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it('a new window resets the budget', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 4; i++) await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, now: T0 });
    const nextWindow = await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, now: T0 + 60_001 });
    expect(nextWindow.allowed).toBe(true);
  });

  it('scopes and ips never share budgets', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 4; i++) await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, now: T0 });
    expect((await checkIpRateLimit(redis, 'rail', '1.2.3.4', { limit: 3, now: T0 })).allowed).toBe(true);
    expect((await checkIpRateLimit(redis, 'pay', '5.6.7.8', { limit: 3, now: T0 })).allowed).toBe(true);
  });
});

describe('checkIpRateLimit — colon-in-scope/ip collision regression', () => {
  // Bug: the Redis key was assembled as `iprl:${scope}:${ip}:${window}`.
  // scope='a:b', ip='c'  → key 'iprl:a:b:c:<win>'
  // scope='a',   ip='b:c'→ key 'iprl:a:b:c:<win>'  (collision!)
  // IPv6 addresses always contain colons, making real collisions likely.
  it('scope="a:b" ip="c" and scope="a" ip="b:c" use SEPARATE budgets', async () => {
    const redis = fakeRedis();
    const limit = 5;
    // Exhaust budget via scope='a:b', ip='c'
    for (let i = 0; i < 6; i++) {
      await checkIpRateLimit(redis, 'a:b', 'c', { limit, now: T0 });
    }
    // scope='a', ip='b:c' should have its own fresh budget
    const r = await checkIpRateLimit(redis, 'a', 'b:c', { limit, now: T0 });
    expect(r.allowed).toBe(true);
  });

  it('scope="x" ip="2001:db8::1" (IPv6 with colons) has its own budget', async () => {
    const redis = fakeRedis();
    const limit = 5;
    // Exhaust a different scope that could collide with the IPv6 key
    for (let i = 0; i < 6; i++) {
      await checkIpRateLimit(redis, 'x:2001', 'db8::1', { limit, now: T0 });
    }
    // The real IPv6 address should be unaffected
    const r = await checkIpRateLimit(redis, 'x', '2001:db8::1', { limit, now: T0 });
    expect(r.allowed).toBe(true);
  });
});

describe('clientIpFrom', () => {
  it('takes the FIRST x-forwarded-for entry (the platform-set client ip)', () => {
    expect(clientIpFrom(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
  });

  it('falls back to x-real-ip, then "unknown"', () => {
    expect(clientIpFrom(new Headers({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    expect(clientIpFrom(new Headers())).toBe('unknown');
  });
});


describe('retry-after header accuracy — regression (bug-hunt)', () => {
  // Verify the math used by enforceIpRateLimit is correct:
  // retryAfterSec should be the remaining window time, not the full windowSec.
  it('retryAfterSec is remaining window time, not full windowSec', () => {
    const windowSec = 60;
    const windowMs = windowSec * 1000;

    // T = window_start + 59s (1 second before window resets)
    const windowStart = 1_750_000_000_000 - (1_750_000_000_000 % windowMs);
    const now = windowStart + 59_000; // 59 s into the window, 1 s remaining
    const windowEnd = (Math.floor(now / windowMs) + 1) * windowMs;
    const retryAfterSec = Math.ceil((windowEnd - now) / 1000);

    // Should be 1 s remaining, NOT 60 s
    expect(retryAfterSec).toBe(1);
    expect(retryAfterSec).not.toBe(windowSec);
  });

  it('retryAfterSec at t=1ms into window is at most windowSec', () => {
    const windowSec = 60;
    const windowMs = windowSec * 1000;

    const windowStart = 1_750_000_000_000 - (1_750_000_000_000 % windowMs);
    const now = windowStart + 1; // 1 ms into the window
    const windowEnd = (Math.floor(now / windowMs) + 1) * windowMs;
    const retryAfterSec = Math.ceil((windowEnd - now) / 1000);

    // Should be windowSec (60) — that's the maximum
    expect(retryAfterSec).toBe(windowSec);
  });

  it('retryAfterSec is always in [1, windowSec]', () => {
    const windowSec = 60;
    const windowMs = windowSec * 1000;
    const base = 1_750_000_000_000;
    const baseWindow = base - (base % windowMs);

    for (const offset of [0, 1, 1000, 29_999, 30_000, 59_000, 59_999]) {
      const now = baseWindow + offset;
      const windowEnd = (Math.floor(now / windowMs) + 1) * windowMs;
      const retryAfterSec = Math.ceil((windowEnd - now) / 1000);
      expect(retryAfterSec).toBeGreaterThanOrEqual(1);
      expect(retryAfterSec).toBeLessThanOrEqual(windowSec);
    }
  });
});

// ── Program-Fix 23: the hosted pay-page guard ────────────────────────────────
// A page (not a route) cannot answer 429: it either renders the sheet or the
// same generic "inactive" sheet. isIpRateLimited() is the boolean the pages
// branch on. It FAILS OPEN on everything (Redis error, unknown IP) and never
// throws — a limiter outage must never hide a customer's payment sheet.
import { isIpRateLimited, PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT } from '@/lib/ip-rate-limit';
import type { RedisLike } from '@/lib/store';

function fwd(ip: string): Headers {
  return new Headers({ 'x-forwarded-for': ip });
}

describe('isIpRateLimited — page guard (fail-open, never throws)', () => {
  it('exports the page scope and limit: "paypage", 60 per window, distinct from the POST "pay" scope', () => {
    expect(PAY_PAGE_SCOPE).toBe('paypage');
    expect(PAY_PAGE_IP_LIMIT).toBe(60);
    expect(PAY_PAGE_SCOPE).not.toBe('pay');
  });

  it('the 60th call in a window is allowed (false) and the 61st is throttled (true)', async () => {
    const redis = fakeRedis();
    const deps = { redis, now: () => T0 };
    for (let i = 1; i <= 60; i++) {
      expect(await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT, 60, deps)).toBe(false);
    }
    expect(await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT, 60, deps)).toBe(true);
    // The key carries the page scope, never the POST scope.
    expect([...redis.dump.keys()].some((k) => k.startsWith('iprl|paypage|1.2.3.4|'))).toBe(true);
    expect([...redis.dump.keys()].some((k) => k.startsWith('iprl|pay|'))).toBe(false);
  });

  it('a different scope has its own budget', async () => {
    const redis = fakeRedis();
    const deps = { redis, now: () => T0 };
    for (let i = 0; i < 61; i++) await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT, 60, deps);
    expect(await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, PAY_PAGE_IP_LIMIT, 60, deps)).toBe(true);
    expect(await isIpRateLimited(fwd('1.2.3.4'), 'other', PAY_PAGE_IP_LIMIT, 60, deps)).toBe(false);
  });

  it('a new window resets the budget', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 61; i++) await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 60, 60, { redis, now: () => T0 });
    expect(await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 60, 60, { redis, now: () => T0 })).toBe(true);
    expect(await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 60, 60, { redis, now: () => T0 + 60_001 })).toBe(false);
  });

  it('a throwing Redis fails OPEN (false) and never throws', async () => {
    const throwing: RedisLike = {
      ...fakeRedis(),
      async incr() {
        throw new Error('upstash down');
      },
    };
    await expect(isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: throwing })).resolves.toBe(false);
    await expect(isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: throwing })).resolves.toBe(false);
  });

  it('a Redis whose expire throws (after a successful incr) still fails open', async () => {
    const half: RedisLike = {
      ...fakeRedis(),
      async expire() {
        throw new Error('expire failed');
      },
    };
    await expect(isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: half })).resolves.toBe(false);
  });

  it('no forwarded headers (IP "unknown") fails open and never touches Redis', async () => {
    const redis = fakeRedis();
    for (let i = 0; i < 100; i++) {
      expect(await isIpRateLimited(new Headers(), PAY_PAGE_SCOPE, 1, 60, { redis })).toBe(false);
    }
    expect(redis.dump.size).toBe(0);
  });

  it('a headers object whose get() throws fails open and never throws', async () => {
    const hostile = { get: () => { throw new Error('boom'); } } as unknown as Headers;
    await expect(isIpRateLimited(hostile, PAY_PAGE_SCOPE, 1, 60, { redis: fakeRedis() })).resolves.toBe(false);
  });
});
