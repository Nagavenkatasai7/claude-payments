import { describe, it, expect, vi } from 'vitest';
import { fakeRedis } from './helpers';
import {
  createStaffLoginGuard,
  isSeedAdminRecord,
  staffLoginKeys,
  STAFF_IP_CAP,
  STAFF_U_CAP,
  STAFF_UI_CAP,
} from '@/lib/staff-login-guard';
import type { Staff } from '@/lib/types';

// Program-Fix 17a — the staff reserve-before-compare guard.

const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);
const HOUR = 60 * 60 * 1000;

function mk(now = () => T0) {
  const redis = fakeRedis();
  return { redis, guard: createStaffLoginGuard(redis, { now }) };
}

function staff(over: Partial<Staff> = {}): Staff {
  return {
    username: 'admin',
    name: 'Admin',
    role: 'admin',
    permissions: { canCancel: true, canResend: true, canAssign: true },
    passwordHash: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('reserve (staff-login-guard)', () => {
  it('11th attempt from one IP refused', async () => {
    const { guard } = mk();
    for (let i = 0; i < STAFF_UI_CAP; i++) {
      expect((await guard.reserve('ops', '1.2.3.4')).allowed).toBe(true);
    }
    const r = await guard.reserve('ops', '1.2.3.4');
    expect(r.allowed).toBe(false);
    expect(r.justTripped).toBe('ui');
    // Only the FIRST refusal past the cap reports the trip (one throttled audit row per bucket).
    expect((await guard.reserve('ops', '1.2.3.4')).justTripped).toBeNull();
    // A different IP for the same username still has its own ui budget.
    expect((await guard.reserve('ops', '5.6.7.8')).allowed).toBe(true);
  });

  it('the all-IP username cap refuses at attempt 31', async () => {
    const { guard } = mk();
    for (let i = 0; i < STAFF_U_CAP; i++) {
      expect((await guard.reserve('ops', `10.0.0.${i}`)).allowed).toBe(true);
    }
    const r = await guard.reserve('ops', '10.0.1.1');
    expect(r).toMatchObject({ allowed: false, justTripped: 'u' });
  });

  it('the per-IP cap refuses the 51st attempt across usernames', async () => {
    const { guard } = mk();
    for (let i = 0; i < STAFF_IP_CAP; i++) {
      expect((await guard.reserve(`user${i}`, '9.9.9.9')).allowed).toBe(true);
    }
    expect(await guard.reserve('someone-else', '9.9.9.9')).toMatchObject({ allowed: false, justTripped: 'ip' });
  });

  it('a seedExempt reservation bumps ONLY the ui bucket (never u, never ip)', async () => {
    const { guard, redis } = mk();
    // Saturate the per-IP and the username buckets first.
    for (let i = 0; i < STAFF_IP_CAP + 5; i++) await guard.reserve(`user${i}`, '9.9.9.9');
    for (let i = 0; i < STAFF_U_CAP + 5; i++) await guard.reserve('admin', `10.0.0.${i}`);
    expect(Number(redis.dump.get(staffLoginKeys.ip('9.9.9.9', T0)))).toBeGreaterThan(STAFF_IP_CAP);
    expect(Number(redis.dump.get(staffLoginKeys.u('admin', T0)))).toBeGreaterThan(STAFF_U_CAP);

    const r = await guard.reserve('admin', '9.9.9.9', { seedExempt: true });
    expect(r.allowed).toBe(true);
    expect(r.keys).toEqual([staffLoginKeys.ui('admin', '9.9.9.9', T0)]);
    // ui still applies to the seed admin.
    for (let i = 1; i < STAFF_UI_CAP; i++) await guard.reserve('admin', '9.9.9.9', { seedExempt: true });
    expect((await guard.reserve('admin', '9.9.9.9', { seedExempt: true })).allowed).toBe(false);
  });

  it("an 'unknown' client IP never touches the shared per-IP bucket (one bucket would lock out everyone behind it)", async () => {
    const { guard, redis } = mk();
    for (let i = 0; i < STAFF_IP_CAP + 5; i++) {
      expect((await guard.reserve(`user${i}`, 'unknown')).allowed).toBe(true);
    }
    expect(redis.dump.has(staffLoginKeys.ip('unknown', T0))).toBe(false);
    // The per-username buckets still apply.
    for (let i = 0; i < STAFF_UI_CAP; i++) await guard.reserve('ops', 'unknown');
    expect((await guard.reserve('ops', 'unknown')).allowed).toBe(false);
  });

  it('arms the TTL on the first write of each bucket only', async () => {
    const { guard, redis } = mk();
    const expire = vi.spyOn(redis, 'expire');
    await guard.reserve('ops', '1.2.3.4');
    expect(expire).toHaveBeenCalledTimes(3);
    await guard.reserve('ops', '1.2.3.4');
    expect(expire).toHaveBeenCalledTimes(3);
  });

  it('stores no raw username or IP in any key', async () => {
    const { guard, redis } = mk();
    await guard.reserve('ops-user', '203.0.113.7');
    for (const k of redis.dump.keys()) {
      expect(k).not.toContain('ops-user');
      expect(k).not.toContain('203.0.113.7');
    }
  });

  it('buckets roll over with the clock (hour / day)', async () => {
    let t = T0;
    const { guard } = mk(() => t);
    for (let i = 0; i <= STAFF_UI_CAP; i++) await guard.reserve('ops', '1.2.3.4');
    expect((await guard.reserve('ops', '1.2.3.4')).allowed).toBe(false);
    t = T0 + HOUR;
    expect((await guard.reserve('ops', '1.2.3.4')).allowed).toBe(true);
  });
});

describe('refund + clear (staff-login-guard)', () => {
  it('20 successful logins do not throttle: refund gives every key back', async () => {
    const { guard, redis } = mk();
    for (let i = 0; i < 20; i++) {
      const r = await guard.reserve('ops', '1.2.3.4');
      expect(r.allowed).toBe(true);
      await guard.refund(r.keys);
    }
    expect(redis.dump.get(staffLoginKeys.ip('1.2.3.4', T0))).toBeUndefined();
    expect(redis.dump.get(staffLoginKeys.u('ops', T0))).toBeUndefined();
    expect(redis.dump.get(staffLoginKeys.ui('ops', '1.2.3.4', T0))).toBeUndefined();
  });

  it('refund only gives back THIS attempt: earlier failures on the IP stay counted', async () => {
    const { guard, redis } = mk();
    for (let i = 0; i < 5; i++) await guard.reserve(`other${i}`, '1.2.3.4');
    const r = await guard.reserve('ops', '1.2.3.4');
    await guard.refund(r.keys);
    expect(redis.dump.get(staffLoginKeys.ip('1.2.3.4', T0))).toBe('5');
  });

  it('refund skips a key that has expired (never creates a TTL-less -1 key)', async () => {
    const { guard, redis } = mk();
    const r = await guard.reserve('ops', '1.2.3.4');
    for (const k of r.keys) await redis.del(k); // TTL elapsed between reserve and refund
    const decr = vi.spyOn(redis, 'decr');
    await guard.refund(r.keys);
    expect(decr).not.toHaveBeenCalled();
    for (const k of r.keys) expect(redis.dump.has(k)).toBe(false);
  });

  it('clear drops the username ui (this IP) and u counters, not the per-IP one', async () => {
    const { guard, redis } = mk();
    for (let i = 0; i < 3; i++) await guard.reserve('ops', '1.2.3.4');
    await guard.clear('ops', '1.2.3.4');
    expect(redis.dump.has(staffLoginKeys.ui('ops', '1.2.3.4', T0))).toBe(false);
    expect(redis.dump.has(staffLoginKeys.u('ops', T0))).toBe(false);
    expect(redis.dump.get(staffLoginKeys.ip('1.2.3.4', T0))).toBe('3');
  });
});

describe('isSeedAdminRecord', () => {
  it('true only for the configured name on a platform admin record', () => {
    expect(isSeedAdminRecord(staff(), 'admin')).toBe(true);
  });
  it('false when the seed name is empty', () => {
    expect(isSeedAdminRecord(staff({ username: '' }), '')).toBe(false);
  });
  it('false for a same-named partner-staff record or a non-admin role (no inherited exemption)', () => {
    expect(isSeedAdminRecord(staff({ partnerId: 'acme' }), 'admin')).toBe(false);
    expect(isSeedAdminRecord(staff({ role: 'agent' }), 'admin')).toBe(false);
    expect(isSeedAdminRecord(null, 'admin')).toBe(false);
  });
  it('false for any other username', () => {
    expect(isSeedAdminRecord(staff({ username: 'ops' }), 'admin')).toBe(false);
  });
});
