import { describe, it, expect } from 'vitest';
import { createAuthStore } from '@/lib/auth-store';
import { fakeRedis } from './helpers';
import type { Staff } from '@/lib/types';

function staff(username: string, createdAt: string): Staff {
  return {
    username,
    name: username.toUpperCase(),
    role: 'agent',
    permissions: { canCancel: false, canResend: true, canAssign: false },
    passwordHash: 'salt:hash',
    createdAt,
  };
}

describe('auth-store staff', () => {
  it('round-trips a staff member', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('priya', '2026-05-21T01:00:00.000Z'));
    const loaded = await s.getStaff('priya');
    expect(loaded?.name).toBe('PRIYA');
  });

  it('returns null for an unknown staff member', async () => {
    expect(await createAuthStore(fakeRedis()).getStaff('nobody')).toBeNull();
  });

  it('lists staff sorted by createdAt', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('b', '2026-05-21T03:00:00.000Z'));
    await s.saveStaff(staff('a', '2026-05-21T01:00:00.000Z'));
    expect((await s.listStaff()).map((x) => x.username)).toEqual(['a', 'b']);
  });

  it('deletes a staff member', async () => {
    const s = createAuthStore(fakeRedis());
    await s.saveStaff(staff('a', '2026-05-21T01:00:00.000Z'));
    await s.deleteStaff('a');
    expect(await s.getStaff('a')).toBeNull();
    expect(await s.listStaff()).toHaveLength(0);
  });
});

describe('auth-store sessions', () => {
  it('creates a session and resolves it back to the username', async () => {
    const s = createAuthStore(fakeRedis());
    const token = await s.createSession('priya');
    expect(typeof token).toBe('string');
    expect(await s.getSessionUser(token)).toBe('priya');
  });

  it('returns null for an unknown session token', async () => {
    expect(await createAuthStore(fakeRedis()).getSessionUser('x')).toBeNull();
  });

  it('deletes a session', async () => {
    const s = createAuthStore(fakeRedis());
    const token = await s.createSession('priya');
    await s.deleteSession(token);
    expect(await s.getSessionUser(token)).toBeNull();
  });
});
