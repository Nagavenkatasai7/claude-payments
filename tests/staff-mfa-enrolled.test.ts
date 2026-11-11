import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

// Fix pack 3 (contract 12): staffMfaEnrolled is the fail-closed "has this staff
// account enrolled TOTP?" read the pack 3 actions gate on. A Redis error reads
// as NOT enrolled (never throws), and nothing is logged with the username.

const redis = fakeRedis();
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }));

import { staffMfaEnrolled, staffMfaKeys } from '@/lib/staff-mfa-store';

beforeEach(() => {
  redis.dump.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('staffMfaEnrolled', () => {
  it('enrolled -> true; not enrolled -> false; empty username -> false without a read', async () => {
    await redis.set(staffMfaKeys.secret('pa-admin'), 'sealed-secret');
    expect(await staffMfaEnrolled('pa-admin')).toBe(true);
    expect(await staffMfaEnrolled('pa-agent')).toBe(false);
    const get = vi.spyOn(redis, 'get');
    expect(await staffMfaEnrolled('')).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('a Redis error -> false (fail closed), no throw, nothing logged with the username', async () => {
    await redis.set(staffMfaKeys.secret('pa-secret-user'), 'sealed-secret');
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('redis down'));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await expect(staffMfaEnrolled('pa-secret-user')).resolves.toBe(false);
    for (const s of spies) {
      for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain('pa-secret-user');
    }
  });
});
