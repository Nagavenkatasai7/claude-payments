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
