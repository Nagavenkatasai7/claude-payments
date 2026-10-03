import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import {
  createStaffStepUp,
  staffStepUpKey,
  staffStepUpLimitKeys,
  STAFF_STEP_UP_WINDOW_MS,
  STEP_UP_SESSION_HOURLY_CAP,
  STEP_UP_USER_DAILY_CAP,
  type StaffStepUpDeps,
} from '@/lib/staff-step-up';
import { STEP_UP_FIELD, isStepUpRequired, withStepUpSecret, withoutStepUpSecret } from '@/lib/staff-step-up-result';
import type { Staff } from '@/lib/types';

// The partner-staff 15-minute step-up (M3-14 follow-up). The marker is per SESSION (keyed by the
// sha256 of the session token, bound to the username, stamped with the proof time); the factor is
// the strongest one the account has (TOTP when enrolled, else the password), decided by the MFA
// store's enrolment record and never by the enrolment POLICY. Every attempt reserves on the step-up's
// OWN buckets first (per session per hour, per user per day), never the /login buckets; nothing
// here ever records or logs the submitted code / password.

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
const record = vi.fn(async (_e: unknown) => {});

function make(over: Partial<StaffStepUpDeps> = {}) {
  return createStaffStepUp({
    redis,
    now: () => nowMs,
    mfa: { isEnrolled: enrolled, verifyCode },
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
  for (const f of [enrolled, verifyCode, verifyPassword, getStaff, record]) f.mockClear();
  enrolled.mockImplementation(async () => true);
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
  it('TOTP: a valid code marks the session, gives back its reservation and audits auth.stepup (no code)', async () => {
    const s = make();
    expect(await s.verify(attempt(' 123 456 '))).toEqual({ outcome: 'ok', factor: 'totp' });
    expect(verifyCode).toHaveBeenCalledWith('pa-admin', '123456');
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(true);
    const lk = staffStepUpLimitKeys('pa-admin', TOKEN, nowMs);
    expect(redis.dump.get(lk.user) ?? '0').toBe('0');
    expect(redis.dump.get(lk.session) ?? '0').toBe('0');
    expect(record).toHaveBeenCalledTimes(1);
    const ev = record.mock.calls[0][0] as Record<string, unknown>;
    expect(ev).toMatchObject({ action: 'auth.stepup', actorType: 'staff', actor: 'pa-admin', subjectId: 'pa-admin', partnerId: 'pa', ip: '203.0.113.9' });
    expect(ev.meta).toEqual({ factor: 'totp', target: 'api_key.issue', actorScope: 'partner' });
    expect(JSON.stringify(record.mock.calls)).not.toContain('123');
  });
  it('the lost-features targets (issue refund, approve a 2FA recovery) are audited by name', async () => {
    for (const target of ['refund.issue', 'customer.mfa.recovery.approve'] as const) {
      record.mockClear();
      expect(await make().verify({ ...attempt('123456'), target })).toEqual({ outcome: 'ok', factor: 'totp' });
      expect((record.mock.calls[0][0] as { meta: unknown }).meta).toEqual({ factor: 'totp', target, actorScope: 'partner' });
    }
  });
  it('TOTP: a wrong or malformed code is invalid, not marked, audited auth.stepup.failed (no code)', async () => {
    const s = make();
    for (const bad of ['654321', '12345', 'abcdef', '']) {
      expect(await s.verify(attempt(bad))).toEqual({ outcome: 'invalid', factor: 'totp' });
    }
    expect(verifyCode).toHaveBeenCalledTimes(1); // only the well-formed one reaches the store
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    const lk = staffStepUpLimitKeys('pa-admin', TOKEN, nowMs);
    expect(redis.dump.get(lk.session)).toBe('4'); // failures are kept
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
  it('the per-SESSION hourly cap: past it even a right code is refused, verifies nothing, and the tripping attempt is audited', async () => {
    const s = make();
    for (let i = 0; i < STEP_UP_SESSION_HOURLY_CAP; i++) expect((await s.verify(attempt('000000'))).outcome).toBe('invalid');
    verifyCode.mockClear();
    record.mockClear();
    expect(await s.verify(attempt('123456'))).toEqual({ outcome: 'throttled', factor: 'totp' });
    expect(verifyCode).not.toHaveBeenCalled();
    expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ action: 'auth.stepup.failed', meta: { reason: 'throttled' } });
    await s.verify(attempt('123456')); // only the tripping attempt is audited
    expect(record).toHaveBeenCalledTimes(1);
    // The next hour opens a new session bucket.
    nowMs += 60 * 60 * 1000;
    expect((await s.verify(attempt('123456'))).outcome).toBe('ok');
  });
  it('the per-USER daily cap spans sessions', async () => {
    const s = make();
    const perSession = STEP_UP_SESSION_HOURLY_CAP;
    let n = 0;
    for (let sess = 0; n < STEP_UP_USER_DAILY_CAP; sess++) {
      for (let i = 0; i < perSession && n < STEP_UP_USER_DAILY_CAP; i++, n++) {
        expect((await s.verify({ ...attempt('000000'), token: `t${sess}`.padEnd(64, 'x') })).outcome).toBe('invalid');
      }
    }
    expect(await s.verify({ ...attempt('123456'), token: 'fresh'.padEnd(64, 'y') })).toEqual({ outcome: 'throttled', factor: 'totp' });
  });
  it('never reads or writes the /login throttle buckets: a burned login budget does not block step-up', async () => {
    // Every login bucket far past its cap (as failed /login spam against the username would leave them).
    for (const k of ['staff_lf:ui:a', 'staff_lf:u:b', 'staff_lf:ip:c']) redis.dump.set(k, '999');
    const before = [...redis.dump.keys()].filter((k) => k.startsWith('staff_lf:')).map((k) => [k, redis.dump.get(k)]);
    const s = make();
    expect((await s.verify(attempt('000000'))).outcome).toBe('invalid');
    expect(await s.verify(attempt('123456'))).toEqual({ outcome: 'ok', factor: 'totp' });
    const after = [...redis.dump.keys()].filter((k) => k.startsWith('staff_lf:')).map((k) => [k, redis.dump.get(k)]);
    expect(after).toEqual(before);
  });
  it('the buckets are hashed (no raw username or token in a key) and carry a TTL', async () => {
    const expire = vi.spyOn(redis, 'expire');
    await make().verify(attempt('000000'));
    const lk = staffStepUpLimitKeys('pa-admin', TOKEN, nowMs);
    for (const k of [lk.user, lk.session]) {
      expect(k).not.toContain('pa-admin');
      expect(k).not.toContain(TOKEN);
      expect(expire).toHaveBeenCalledWith(k, expect.any(Number));
    }
    expire.mockRestore();
  });
  it('a failed give-back does not block the success; the audit row is written before the marker', async () => {
    const decr = redis.decr.bind(redis);
    redis.decr = async () => {
      throw new Error('redis down');
    };
    const order: string[] = [];
    const set = redis.set.bind(redis);
    redis.set = async (k: string, v: string, o?: { ex?: number; nx?: boolean }) => {
      if (k.startsWith('staff_stepup:')) order.push('mark');
      return set(k, v, o);
    };
    record.mockImplementationOnce(async () => {
      order.push('audit');
    });
    try {
      const s = make();
      expect(await s.verify(attempt('123456'))).toEqual({ outcome: 'ok', factor: 'totp' });
      expect(order).toEqual(['audit', 'mark']);
      expect(await s.isFresh(TOKEN, 'pa-admin')).toBe(true);
    } finally {
      redis.set = set;
      redis.decr = decr;
    }
  });
  it('a Redis error while reserving propagates (the caller refuses) and verifies nothing', async () => {
    const incr = redis.incr.bind(redis);
    redis.incr = async () => {
      throw new Error('redis down');
    };
    try {
      await expect(make().verify(attempt('123456'))).rejects.toThrow('redis down');
      expect(verifyCode).not.toHaveBeenCalled();
    } finally {
      redis.incr = incr;
    }
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
