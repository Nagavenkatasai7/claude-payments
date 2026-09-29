import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createStaffStepUp, staffStepUpKey, STAFF_STEP_UP_WINDOW_MS, type StaffStepUpDeps } from '@/lib/staff-step-up';
import { STEP_UP_FIELD, isStepUpRequired, withStepUpSecret, withoutStepUpSecret } from '@/lib/staff-step-up-result';
import type { Staff } from '@/lib/types';

// The partner-staff 15-minute step-up (M3-14 follow-up). The marker is per SESSION (keyed by the
// sha256 of the session token, bound to the username, stamped with the proof time); the factor is
// the strongest one the account has (TOTP when enrolled, else the password), decided by the MFA
// store's enrolment record and never by the enrolment POLICY. Every attempt reserves on the staff
// login guard first; nothing here ever records or logs the submitted code / password.

const redis = fakeRedis();
let nowMs = Date.UTC(2026, 8, 29, 12, 0, 0);
const TOKEN = 'a'.repeat(64);
const staff: Staff = {
  username: 'pa-admin',
  name: 'A',
  role: 'admin',
  permissions: { canCancel: false, canResend: false, canAssign: false, canRevealPii: false },
  passwordHash: 'HASH',
  createdAt: new Date(nowMs).toISOString(),
  partnerId: 'pa',
};

const enrolled = vi.fn(async (_u: string) => true);
const verifyCode = vi.fn(async (_u: string, code: string) => code === '123456');
const verifyPassword = vi.fn(async (plain: string, hash: string) => plain === 'correct horse battery' && hash === 'HASH');
const getStaff = vi.fn(async (_u: string): Promise<Staff | null> => staff);
const reserve = vi.fn(async (_u: string, _ip: string) => ({ allowed: true, keys: ['k1'], justTripped: null as null | 'ui' | 'u' | 'ip' }));
const refund = vi.fn(async (_k: string[]) => {});
const record = vi.fn(async (_e: unknown) => {});

function make(over: Partial<StaffStepUpDeps> = {}) {
  return createStaffStepUp({
    redis,
    now: () => nowMs,
    mfa: { isEnrolled: enrolled, verifyCode },
    guard: { reserve, refund },
    verifyPassword,
    getStaff,
    audit: { record },
    ...over,
  });
}
const attempt = (secret: string) => ({ token: TOKEN, staff, secret, ip: '203.0.113.9', target: 'api_key.issue' as const, actorScope: 'partner' as const });

beforeEach(() => {
  redis.dump.clear();
  nowMs = Date.UTC(2026, 8, 29, 12, 0, 0);
  for (const f of [enrolled, verifyCode, verifyPassword, getStaff, reserve, refund, record]) f.mockClear();
  enrolled.mockImplementation(async () => true);
  reserve.mockImplementation(async () => ({ allowed: true, keys: ['k1'], justTripped: null }));
});

describe('the session marker', () => {
  it('is keyed by the sha256 of the session token (never the token itself)', () => {
    expect(staffStepUpKey(TOKEN)).toMatch(/^staff_stepup:[0-9a-f]{64}$/);
    expect(staffStepUpKey(TOKEN)).not.toContain(TOKEN);
  });
  it('a session with no marker is not fresh', async () => {
    expect(await make().isFresh(TOKEN, 'pa-admin')).toBe(false);
  });
  it('a marked session is fresh for 15 minutes, then stale (even if the key outlived its TTL)', async () => {
    const s = make();
    await s.mark(TOKEN, 'pa-admin');
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(true);
    nowMs += STAFF_STEP_UP_WINDOW_MS;
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(true);
    nowMs += 1;
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
  });
  it('the marker sets a 15-minute TTL', async () => {
    const set = vi.spyOn(redis, 'set');
    await make().mark(TOKEN, 'pa-admin');
    expect(set).toHaveBeenCalledWith(staffStepUpKey(TOKEN), expect.any(String), { ex: STAFF_STEP_UP_WINDOW_MS / 1000 });
    set.mockRestore();
  });
  it('is bound to the username: another user on the same token hash is not fresh', async () => {
    const s = make();
    await s.mark(TOKEN, 'pa-admin');
    expect(await s.isFresh(TOKEN, 'pb-admin')).toBe(false);
  });
  it('another session of the same user is not fresh', async () => {
    const s = make();
    await s.mark(TOKEN, 'pa-admin');
    expect(await s.isFresh('b'.repeat(64), 'pa-admin')).toBe(false);
  });
  it('a stamp in the future, a malformed value or an empty token is never fresh', async () => {
    const s = make();
    redis.dump.set(staffStepUpKey(TOKEN), `pa-admin:${nowMs + 60_000}`);
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    redis.dump.set(staffStepUpKey(TOKEN), 'pa-admin:abc');
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    redis.dump.set(staffStepUpKey(TOKEN), 'garbage');
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    expect(await s.isFresh('', 'pa-admin')).toBe(false);
  });
  it('a Redis error propagates (the caller refuses: fail closed)', async () => {
    const get = redis.get;
    redis.get = async () => {
      throw new Error('redis down');
    };
    try {
      await expect(make().isFresh(TOKEN, 'pa-admin')).rejects.toThrow('redis down');
    } finally {
      redis.get = get;
    }
  });
});

describe('factorFor: the strongest factor the account has (the enrolment record, never the policy)', () => {
  it('enrolled → totp; not enrolled → password', async () => {
    expect(await make().factorFor('pa-admin')).toBe('totp');
    enrolled.mockImplementation(async () => false);
    expect(await make().factorFor('pa-admin')).toBe('password');
  });
  it('an enrolment lookup error demands TOTP (fail closed)', async () => {
    enrolled.mockImplementation(async () => {
      throw new Error('redis down');
    });
    expect(await make().factorFor('pa-admin')).toBe('totp');
  });
});

describe('verify', () => {
  it('TOTP: a valid code marks the session, refunds the reservation and audits auth.stepup (no code)', async () => {
    const s = make();
    expect(await s.verify(attempt(' 123 456 '))).toEqual({ outcome: 'ok', factor: 'totp' });
    expect(verifyCode).toHaveBeenCalledWith('pa-admin', '123456');
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(true);
    expect(refund).toHaveBeenCalledWith(['k1']);
    expect(record).toHaveBeenCalledTimes(1);
    const ev = record.mock.calls[0][0] as Record<string, unknown>;
    expect(ev).toMatchObject({ action: 'auth.stepup', actorType: 'staff', actor: 'pa-admin', subjectId: 'pa-admin', partnerId: 'pa', ip: '203.0.113.9' });
    expect(ev.meta).toEqual({ factor: 'totp', target: 'api_key.issue', actorScope: 'partner' });
    expect(JSON.stringify(record.mock.calls)).not.toContain('123');
  });
  it('TOTP: a wrong or malformed code is invalid, not marked, audited auth.stepup.failed (no code)', async () => {
    const s = make();
    for (const bad of ['654321', '12345', 'abcdef', '']) {
      expect(await s.verify(attempt(bad))).toEqual({ outcome: 'invalid', factor: 'totp' });
    }
    expect(verifyCode).toHaveBeenCalledTimes(1); // only the well-formed one reaches the store
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    expect(refund).not.toHaveBeenCalled();
    expect(record.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual(Array(4).fill('auth.stepup.failed'));
    expect(JSON.stringify(record.mock.calls)).not.toContain('654321');
  });
  it('password (not enrolled): the current password of the FRESH record marks; a wrong one does not', async () => {
    enrolled.mockImplementation(async () => false);
    const s = make();
    expect(await s.verify(attempt('wrong password!'))).toEqual({ outcome: 'invalid', factor: 'password' });
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    expect(await s.verify(attempt('correct horse battery'))).toEqual({ outcome: 'ok', factor: 'password' });
    expect(getStaff).toHaveBeenCalledWith('pa-admin');
    expect(verifyPassword).toHaveBeenLastCalledWith('correct horse battery', 'HASH');
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(true);
    expect(JSON.stringify(record.mock.calls)).not.toContain('horse');
    expect(JSON.stringify(record.mock.calls)).not.toContain('wrong password');
  });
  it('a TOTP-enrolled account can NOT step up with the password', async () => {
    const s = make();
    expect(await s.verify(attempt('correct horse battery'))).toEqual({ outcome: 'invalid', factor: 'totp' });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
  });
  it('password: a record that vanished is invalid', async () => {
    enrolled.mockImplementation(async () => false);
    getStaff.mockImplementationOnce(async () => null);
    expect(await make().verify(attempt('correct horse battery'))).toEqual({ outcome: 'invalid', factor: 'password' });
  });
  it('an oversized secret is invalid without a verify', async () => {
    enrolled.mockImplementation(async () => false);
    expect(await make().verify(attempt('x'.repeat(300)))).toEqual({ outcome: 'invalid', factor: 'password' });
    expect(verifyPassword).not.toHaveBeenCalled();
  });
  it('every attempt reserves on the login guard FIRST; a refused reservation verifies nothing', async () => {
    reserve.mockImplementation(async () => ({ allowed: false, keys: ['k1'], justTripped: 'ui' }));
    const s = make();
    expect(await s.verify(attempt('123456'))).toEqual({ outcome: 'throttled', factor: 'totp' });
    expect(reserve).toHaveBeenCalledWith('pa-admin', '203.0.113.9');
    expect(verifyCode).not.toHaveBeenCalled();
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    expect((record.mock.calls[0][0] as { action: string; meta: unknown }).meta).toMatchObject({ reason: 'throttled' });
    // Only the tripping attempt is audited, not every refused one.
    reserve.mockImplementation(async () => ({ allowed: false, keys: ['k1'], justTripped: null }));
    await s.verify(attempt('123456'));
    expect(record).toHaveBeenCalledTimes(1);
  });
  it('a Redis error while verifying propagates (the caller refuses)', async () => {
    reserve.mockImplementation(async () => {
      throw new Error('redis down');
    });
    await expect(make().verify(attempt('123456'))).rejects.toThrow('redis down');
    expect(verifyCode).not.toHaveBeenCalled();
  });
});

describe('the client-safe result', () => {
  it('isStepUpRequired recognises only the typed step_up_required result', () => {
    expect(isStepUpRequired({ ok: false, error: 'x', code: 'step_up_required', factor: 'totp' })).toBe(true);
    expect(isStepUpRequired({ ok: false, error: 'x' })).toBe(false);
    expect(isStepUpRequired({ ok: true })).toBe(false);
    expect(isStepUpRequired(null)).toBe(false);
    expect(STEP_UP_FIELD).toBe('stepUpSecret');
  });
});

describe('the retry FormData helpers (client)', () => {
  it('withoutStepUpSecret copies every field except the secret; withStepUpSecret adds it to a COPY', () => {
    const fd = new FormData();
    fd.set('mode', 'test');
    fd.append('multi', 'a');
    fd.append('multi', 'b');
    fd.set(STEP_UP_FIELD, 'old-secret');
    const base = withoutStepUpSecret(fd);
    expect(base.get(STEP_UP_FIELD)).toBeNull();
    expect(base.get('mode')).toBe('test');
    expect(base.getAll('multi')).toEqual(['a', 'b']);
    const retry = withStepUpSecret(base, '123456');
    expect(retry.get(STEP_UP_FIELD)).toBe('123456');
    expect(retry.get('mode')).toBe('test');
    expect(base.get(STEP_UP_FIELD)).toBeNull(); // the kept base never holds a secret
    expect(fd.get(STEP_UP_FIELD)).toBe('old-secret'); // the input is not mutated
  });
});
