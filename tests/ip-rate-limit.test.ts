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

describe('clientIpFrom', () => {
  it('takes the FIRST x-forwarded-for entry (the platform-set client ip)', () => {
    expect(clientIpFrom(new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
  });

  it('falls back to x-real-ip, then "unknown"', () => {
    expect(clientIpFrom(new Headers({ 'x-real-ip': '8.8.8.8' }))).toBe('8.8.8.8');
    expect(clientIpFrom(new Headers())).toBe('unknown');
  });
});
