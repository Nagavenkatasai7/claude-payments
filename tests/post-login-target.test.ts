import { describe, it, expect, vi } from 'vitest';
import { fakeRedis } from './helpers';
import { inviteMfaPending, MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import { postLoginTarget } from '@/lib/post-login-target';
import type { Staff } from '@/lib/types';

// UI redesign M3-9, Task 9.1: where a successful password sign-in lands. Only an account carrying
// the invite marker (set at invite acceptance) that has not enrolled yet is sent to enrolment;
// every other account keeps today's /admin-dashboard. The global WHO-must-enrol policy is loop A's
// and is NOT read here (policyRequired is forced off).

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const staff = (o: Partial<Staff> = {}): Staff => ({
  username: 'u1',
  name: 'U',
  role: 'agent',
  permissions: perms,
  passwordHash: 'x',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'pa',
  ...o,
});

describe('inviteMfaPending', () => {
  it('a platform account is never pending and never touches Redis', async () => {
    const redis = fakeRedis();
    const exists = vi.spyOn(redis, 'exists');
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    expect(await inviteMfaPending(staff({ partnerId: undefined, role: 'admin' }), { redis, isEnrolled: async () => false })).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });
  it('a partner account without the marker is not pending, even when loop A policy would require enrolment', async () => {
    // Partner ADMINS are in the policy's scope (partnerAdmins: true); the helper must not read it.
    expect(await inviteMfaPending(staff({ role: 'admin' }), { redis: fakeRedis(), isEnrolled: async () => false })).toBe(false);
  });
  it('marked and not enrolled → pending', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    expect(await inviteMfaPending(staff(), { redis, isEnrolled: async () => false })).toBe(true);
  });
  it('marked and enrolled → not pending, and the marker is cleared lazily', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    expect(await inviteMfaPending(staff(), { redis, isEnrolled: async () => true })).toBe(false);
    expect(await redis.get(`${MFA_PENDING_PREFIX}u1`)).toBeNull();
  });
  it('an empty-string partnerId is treated as no tenant (never pending, no Redis call)', async () => {
    const redis = fakeRedis();
    const exists = vi.spyOn(redis, 'exists');
    expect(await inviteMfaPending(staff({ partnerId: '' }), { redis, isEnrolled: async () => false })).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });
});

describe('postLoginTarget', () => {
  it('a platform admin → /admin-dashboard', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    expect(await postLoginTarget(staff({ partnerId: undefined, role: 'admin' }), { redis, isEnrolled: async () => false })).toBe(
      '/admin-dashboard',
    );
  });
  it('a partner agent without the marker → /partner', async () => {
    expect(await postLoginTarget(staff(), { redis: fakeRedis(), isEnrolled: async () => false })).toBe('/partner');
  });
  it('a partner admin and a partner finance member without the marker → /partner', async () => {
    for (const role of ['admin', 'support', 'finance'] as const) {
      expect(await postLoginTarget(staff({ role }), { redis: fakeRedis(), isEnrolled: async () => false })).toBe('/partner');
    }
  });
  it('platform agent and support staff → /admin-dashboard', async () => {
    for (const role of ['agent', 'support'] as const) {
      expect(await postLoginTarget(staff({ partnerId: undefined, role }), { redis: fakeRedis(), isEnrolled: async () => false })).toBe(
        '/admin-dashboard',
      );
    }
  });
  it('an empty-string partnerId is never platform scope → /partner (whose gate sends it to /login)', async () => {
    expect(await postLoginTarget(staff({ partnerId: '' }), { redis: fakeRedis(), isEnrolled: async () => false })).toBe('/partner');
  });
  it('with the marker, not enrolled → /partner/security?enroll=1', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    expect(await postLoginTarget(staff(), { redis, isEnrolled: async () => false })).toBe('/partner/security?enroll=1');
  });
  it('with the marker, enrolled → /partner', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    expect(await postLoginTarget(staff(), { redis, isEnrolled: async () => true })).toBe('/partner');
  });
  it('a marked finance member (a /partner-only role) → enrolment too', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}u1`, '1');
    expect(await postLoginTarget(staff({ role: 'finance' }), { redis, isEnrolled: async () => false })).toBe('/partner/security?enroll=1');
  });
});
