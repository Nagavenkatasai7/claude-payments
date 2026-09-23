import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    const alert = vi.fn(); // hermetic: never the real outbox path
    await expect(isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: throwing, alert })).resolves.toBe(false);
    await expect(isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: throwing, alert })).resolves.toBe(false);
    expect(alert).toHaveBeenCalledWith(PAY_PAGE_SCOPE);
  });

  it('a Redis whose expire throws (after a successful incr) still fails open', async () => {
    const half: RedisLike = {
      ...fakeRedis(),
      async expire() {
        throw new Error('expire failed');
      },
    };
    const alert = vi.fn();
    await expect(isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: half, alert })).resolves.toBe(false);
    expect(alert).toHaveBeenCalledOnce();
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
    await expect(isIpRateLimited(hostile, PAY_PAGE_SCOPE, 1, 60, { redis: fakeRedis(), alert: vi.fn() })).resolves.toBe(false);
  });
});

// ── Review S1: the page guard has a DEADLINE ──────────────────────────────────
// `retry: false` bounds errors, not hangs. A stalled Upstash must not stall
// every /pay/<id> render, so the guard races the limiter against a timer that
// resolves "allowed" (fail-open) and clears that timer either way.
import { PAY_PAGE_GUARD_TIMEOUT_MS } from '@/lib/ip-rate-limit';

describe('isIpRateLimited — deadline (fail-open on a stalled limiter)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function hanging(): RedisLike {
    return { ...fakeRedis(), incr: () => new Promise<number>(() => {}) }; // never settles
  }

  it('exports a 1500 ms default deadline', () => {
    expect(PAY_PAGE_GUARD_TIMEOUT_MS).toBe(1500);
  });

  it('a Redis whose incr never resolves ⇒ false once the deadline passes (default 1500 ms)', async () => {
    const p = isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: hanging() });
    await vi.advanceTimersByTimeAsync(1499);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(false);
  });

  it('deps.timeoutMs overrides the deadline', async () => {
    const p = isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: hanging(), timeoutMs: 200 });
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).resolves.toBe(false);
  });

  it('the fast path clears its timer (nothing keeps the function alive)', async () => {
    const redis = fakeRedis();
    expect(await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 60, 60, { redis })).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    // Over budget on the fast path still decides correctly, and still clears.
    for (let i = 0; i < 60; i++) await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 60, 60, { redis });
    expect(await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 60, 60, { redis })).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the deadline path clears its timer too, and a late limiter rejection is absorbed', async () => {
    const late: RedisLike = {
      ...fakeRedis(),
      incr: () => new Promise<number>((_, reject) => setTimeout(() => reject(new Error('late abort')), 3000)),
    };
    const p = isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: late });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(p).resolves.toBe(false);
    // Only the fake's own 3000 ms rejection timer remains; the guard's is gone.
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1500); // the late rejection fires: must not be an unhandled rejection
    expect(vi.getTimerCount()).toBe(0);
  });

  it('real timers: a 50 ms deadline settles in well under 2 s', async () => {
    vi.useRealTimers();
    const t0 = Date.now();
    await expect(isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: hanging(), timeoutMs: 50 })).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

// ── Program-Fix 48: window normalisation ─────────────────────────────────────
// windowSec 0 / negative / NaN used to yield a non-finite bucket key
// (`Math.floor(now / 0)` = Infinity) and `expire(key, 0)`, and enforceIpRateLimit
// recomputed Retry-After from the RAW value (`retry-after: NaN`). All 16 call
// sites pass literals >= 60 or the default today, so this is defensive.
import { normalizeWindowSec } from '@/lib/ip-rate-limit';
import type { NextRequest } from 'next/server';

describe('normalizeWindowSec (Program-Fix 48)', () => {
  it('undefined and non-finite fall back to the 60 s default', () => {
    expect(normalizeWindowSec(undefined)).toBe(60);
    expect(normalizeWindowSec(NaN)).toBe(60);
    expect(normalizeWindowSec(Infinity)).toBe(60);
    expect(normalizeWindowSec(-Infinity)).toBe(60);
  });

  it('values below 1 clamp to 1', () => {
    expect(normalizeWindowSec(0)).toBe(1);
    expect(normalizeWindowSec(-5)).toBe(1);
    expect(normalizeWindowSec(0.5)).toBe(1);
  });

  it('fractional values >= 1 are floored; integers pass through unchanged', () => {
    expect(normalizeWindowSec(90.7)).toBe(90);
    expect(normalizeWindowSec(60)).toBe(60);
    expect(normalizeWindowSec(3600)).toBe(3600);
    expect(normalizeWindowSec(86_400)).toBe(86_400);
  });
});

describe('checkIpRateLimit — degenerate windows produce finite keys (Program-Fix 48)', () => {
  for (const [label, windowSec, expectedWindowSec] of [
    ['0', 0, 1],
    ['-5', -5, 1],
    ['NaN', NaN, 60],
  ] as const) {
    it(`windowSec ${label} → finite bucket key and expire >= 2`, async () => {
      const redis = fakeRedis();
      const expire = vi.spyOn(redis, 'expire');
      const incr = vi.spyOn(redis, 'incr');
      await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, windowSec, now: T0 });
      const bucket = Math.floor(T0 / (expectedWindowSec * 1000));
      expect(incr).toHaveBeenCalledWith(`iprl|pay|1.2.3.4|${bucket}`);
      expect(expire).toHaveBeenCalledWith(`iprl|pay|1.2.3.4|${bucket}`, expectedWindowSec * 2);
    });
  }

  it('real call-site literals keep their exact keys (old and new builds share buckets)', async () => {
    for (const windowSec of [60, 3600, 86_400]) {
      const redis = fakeRedis();
      const incr = vi.spyOn(redis, 'incr');
      await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, windowSec, now: T0 });
      expect(incr).toHaveBeenCalledWith(`iprl|pay|1.2.3.4|${Math.floor(T0 / (windowSec * 1000))}`);
    }
    const redis = fakeRedis();
    const incr = vi.spyOn(redis, 'incr');
    await checkIpRateLimit(redis, 'pay', '1.2.3.4', { limit: 3, now: T0 });
    expect(incr).toHaveBeenCalledWith(`iprl|pay|1.2.3.4|${Math.floor(T0 / 60_000)}`);
  });
});

describe('enforceIpRateLimit — Retry-After uses the normalised window (Program-Fix 48)', () => {
  // Scoped module mock (vi.doMock + dynamic import) so the rest of this file keeps
  // the real module. Same '@upstash/redis' class-mock shape as tests/pay-page-guard.test.ts:34.
  afterEach(() => {
    vi.doUnmock('@upstash/redis');
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function enforceOverLimit(windowSec: number) {
    vi.resetModules();
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example.test');
    vi.stubEnv('KV_REST_API_TOKEN', 'test-token');
    vi.doMock('@upstash/redis', () => ({
      Redis: class {
        incr = async () => 999; // always over the limit
        expire = async () => 1;
      },
    }));
    const mod = await import('@/lib/ip-rate-limit');
    const req = { headers: new Headers({ 'x-forwarded-for': '1.2.3.4' }) } as unknown as NextRequest;
    return mod.enforceIpRateLimit(req, 'pay', 3, windowSec);
  }

  for (const windowSec of [0, -5, NaN]) {
    it(`windowSec ${windowSec} over limit → 429 with a positive integer retry-after`, async () => {
      const res = await enforceOverLimit(windowSec);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(429);
      const ra = res!.headers.get('retry-after');
      expect(ra).toMatch(/^[1-9]\d*$/);
      expect(Number(ra)).toBeLessThanOrEqual(normalizeWindowSec(windowSec));
    });
  }

  it('a normal 60 s window still answers 429 with retry-after in [1, 60]', async () => {
    const res = await enforceOverLimit(60);
    expect(res!.status).toBe(429);
    const ra = Number(res!.headers.get('retry-after'));
    expect(Number.isInteger(ra)).toBe(true);
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(60);
  });
});

// ── Program-Fix 45 (P2): a limiter error raises an ops signal ────────────────
// Both guards still FAIL OPEN, but a Redis error now raises the deduped
// `limiter-down` ops alert (fire-and-forget: never awaited on the request path).
describe('limiter errors raise an ops alert and still fail open (Program-Fix 45)', () => {
  const throwing = (): RedisLike => ({
    ...fakeRedis(),
    async incr() {
      throw new Error('upstash down');
    },
  });

  it('isIpRateLimited: a throwing Redis calls deps.alert with the scope and returns false', async () => {
    const alert = vi.fn();
    await expect(
      isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: throwing(), alert }),
    ).resolves.toBe(false);
    expect(alert).toHaveBeenCalledWith(PAY_PAGE_SCOPE);
  });

  it('isIpRateLimited: an alert that throws or rejects never breaks fail-open', async () => {
    const sync = vi.fn(() => { throw new Error('alert down'); });
    await expect(
      isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: throwing(), alert: sync }),
    ).resolves.toBe(false);
    const async_ = vi.fn(async () => { throw new Error('alert down'); });
    await expect(
      isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 1, 60, { redis: throwing(), alert: async_ }),
    ).resolves.toBe(false);
  });

  it('isIpRateLimited: a healthy limiter never alerts', async () => {
    const alert = vi.fn();
    await isIpRateLimited(fwd('1.2.3.4'), PAY_PAGE_SCOPE, 60, 60, { redis: fakeRedis(), now: () => T0, alert });
    expect(alert).not.toHaveBeenCalled();
  });

  describe('enforceIpRateLimit', () => {
    afterEach(() => {
      vi.doUnmock('@upstash/redis');
      vi.doUnmock('@/lib/limiter-alert');
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    async function enforceWith(incr: () => Promise<number>) {
      vi.resetModules();
      vi.stubEnv('KV_REST_API_URL', 'https://kv.example.test');
      vi.stubEnv('KV_REST_API_TOKEN', 'test-token');
      const raise = vi.fn().mockResolvedValue(undefined);
      vi.doMock('@/lib/limiter-alert', () => ({ raiseLimiterDownAlert: raise }));
      vi.doMock('@upstash/redis', () => ({
        Redis: class {
          incr = incr;
          expire = async () => 1;
        },
      }));
      const mod = await import('@/lib/ip-rate-limit');
      const req = { headers: new Headers({ 'x-forwarded-for': '1.2.3.4' }) } as unknown as NextRequest;
      return { res: await mod.enforceIpRateLimit(req, 'pay', 3, 60), raise };
    }

    it('a throwing Redis fails open (null) and raises a fail-open limiter alert for the scope', async () => {
      const { res, raise } = await enforceWith(async () => { throw new Error('upstash down'); });
      expect(res).toBeNull();
      expect(raise).toHaveBeenCalledWith('pay', 'fail-open');
    });

    it('a healthy limiter never alerts', async () => {
      const { res, raise } = await enforceWith(async () => 1);
      expect(res).toBeNull();
      expect(raise).not.toHaveBeenCalled();
    });
  });
});
