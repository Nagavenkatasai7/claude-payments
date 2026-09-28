import { describe, it, expect, vi, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { partnerMfaEnrolmentPending, MFA_PENDING_PREFIX } from '@/lib/partner-mfa-gate';
import type { Staff } from '@/lib/types';

const perms = { canCancel: false, canResend: false, canAssign: false, canRevealPii: false };
const staff = (o: Partial<Staff> = {}): Staff => ({
  username: 'pa-ops',
  name: 'O',
  role: 'agent',
  permissions: perms,
  passwordHash: 'x',
  createdAt: '2026-01-01T00:00:00Z',
  partnerId: 'pa',
  ...o,
});
afterEach(() => vi.unstubAllEnvs());

describe('partnerMfaEnrolmentPending', () => {
  it('the marker prefix is the invite contract (M3-9 writes it)', () => {
    expect(MFA_PENDING_PREFIX).toBe('staffmfa:pending:');
  });
  it('no marker and the global policy off → not pending (no store call)', async () => {
    const isEnrolled = vi.fn(async () => false);
    expect(await partnerMfaEnrolmentPending(staff(), { redis: fakeRedis(), isEnrolled })).toBe(false);
    expect(isEnrolled).not.toHaveBeenCalled();
  });
  it('marker set and not enrolled → pending', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}pa-ops`, '1');
    expect(await partnerMfaEnrolmentPending(staff(), { redis, isEnrolled: async () => false })).toBe(true);
    expect(await redis.get(`${MFA_PENDING_PREFIX}pa-ops`)).toBe('1');
  });
  it('another account’s marker does not apply', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}someone-else`, '1');
    expect(await partnerMfaEnrolmentPending(staff(), { redis, isEnrolled: async () => false })).toBe(false);
  });
  it('marker set and enrolled → not pending, and the marker is deleted', async () => {
    const redis = fakeRedis();
    await redis.set(`${MFA_PENDING_PREFIX}pa-ops`, '1');
    expect(await partnerMfaEnrolmentPending(staff(), { redis, isEnrolled: async () => true })).toBe(false);
    expect(await redis.get(`${MFA_PENDING_PREFIX}pa-ops`)).toBeNull();
  });
  it('the global policy (read-only use) still applies: required + not enrolled → pending', async () => {
    const policyRequired = vi.fn(() => true);
    expect(
      await partnerMfaEnrolmentPending(staff({ role: 'admin' }), {
        redis: fakeRedis(),
        isEnrolled: async () => false,
        policyRequired,
      }),
    ).toBe(true);
    expect(policyRequired).toHaveBeenCalledWith(expect.objectContaining({ username: 'pa-ops' }));
  });
  it('the global policy required + enrolled → not pending', async () => {
    expect(
      await partnerMfaEnrolmentPending(staff({ role: 'admin' }), {
        redis: fakeRedis(),
        isEnrolled: async () => true,
        policyRequired: () => true,
      }),
    ).toBe(false);
  });
  it('the default policy is the real one with { partnerAdmins: true }: flag off → not pending', async () => {
    vi.stubEnv('STAFF_MFA_REQUIRED', '');
    expect(
      await partnerMfaEnrolmentPending(staff({ role: 'admin' }), { redis: fakeRedis(), isEnrolled: async () => false }),
    ).toBe(false);
  });
  it('the default policy covers a PARTNER admin when the flag is on (partnerAdmins: true)', async () => {
    vi.stubEnv('STAFF_MFA_REQUIRED', 'true');
    expect(
      await partnerMfaEnrolmentPending(staff({ role: 'admin' }), { redis: fakeRedis(), isEnrolled: async () => false }),
    ).toBe(true);
    // The policy is admins only: a partner agent is not required by the flag (only by the marker).
    expect(await partnerMfaEnrolmentPending(staff(), { redis: fakeRedis(), isEnrolled: async () => false })).toBe(false);
  });
});
