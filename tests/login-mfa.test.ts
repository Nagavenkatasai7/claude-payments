/**
 * Program-Fix 17b — the staff sign-in's TOTP second step.
 *
 * Opt-in: an account that has not enrolled signs in exactly as before. An
 * enrolled account gets NO session from the password alone: login() mints a
 * 5-minute pending token (httpOnly __Host- cookie) and sends it to /login/mfa,
 * whose action mints the session through the same path as login() (the
 * __Host-sr_staff cookie, 30 min idle / 12 h absolute windows). Bad codes
 * consume the SAME login-guard reservations, and a password success never
 * clears them while a code is still owed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createPartnerStore, type PartnerStore } from '@/lib/partner-store';
import type { AuditEvent } from '@/db/repos/aux-repos';

const redis = fakeRedis();
const ringRedis = fakeRedis();
let pgPartnerStore: PartnerStore;
const cookieJar = new Map<string, string>();
let currentIp = '198.51.100.7';
const T0 = Date.UTC(2026, 8, 23, 10, 1, 0);
let clock = T0;

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n)! } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (a: string | { name: string }) => cookieJar.delete(typeof a === 'string' ? a : a.name),
  }),
  headers: async () => new Headers({ 'x-forwarded-for': currentIp }),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/partner-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/partner-store')>('@/lib/partner-store');
  return { ...actual, getPartnerStore: () => pgPartnerStore };
});
vi.mock('@/lib/seed', () => ({ ensureSeedAdmin: async () => {} }));
vi.mock('@/lib/staff-login-guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-login-guard')>('@/lib/staff-login-guard');
  return { ...actual, getStaffLoginGuard: () => actual.createStaffLoginGuard(redis, { now: () => clock }) };
});
vi.mock('@/lib/staff-mfa-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-mfa-store')>('@/lib/staff-mfa-store');
  return { ...actual, getStaffMfaStore: () => actual.createStaffMfaStore(redis, { now: () => clock }) };
});
vi.mock('@/lib/ip-rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ip-rate-limit')>('@/lib/ip-rate-limit');
  return {
    ...actual,
    isIpRateLimited: (h: Headers, scope: string, limit: number, windowSec?: number) =>
      actual.isIpRateLimited(h, scope, limit, windowSec, { redis: ringRedis, now: () => clock }),
  };
});
const audited: AuditEvent[] = [];
vi.mock('@/lib/staff-auth-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-auth-audit')>('@/lib/staff-auth-audit');
  return {
    ...actual,
    getStaffAuthAudit: () =>
      actual.createStaffAuthAudit({
        record: async (e) => {
          audited.push(e);
        },
        ipKey: () => Buffer.alloc(32, 3),
        warn: () => {},
      }),
  };
});

import { login } from '@/app/login/actions';
import { verifyMfa } from '@/app/login/mfa/actions';
import { getAuthStore } from '@/lib/auth-store';
import { createStaffMfaStore } from '@/lib/staff-mfa-store';
import { hashPassword } from '@/lib/password';
import { base32Decode, totpAt } from '@/lib/totp';
import { SESSION_COOKIE } from '@/lib/session-cookie';
import { MFA_PENDING_COOKIE } from '@/lib/staff-mfa-cookie';
import type { Staff } from '@/lib/types';
import { runStaffBreakGlass, type BreakGlassRedis } from '../scripts/staff-break-glass';

const SEED = 'admin';
const OK = 'REDIRECT:/admin-dashboard';
const TO_MFA = 'REDIRECT:/login/mfa';
const THROTTLED = 'Too many attempts. Try again later.';
let GOOD_HASH: string;
const secrets = new Map<string, Buffer>();

function row(over: Partial<Staff>): Staff {
  return {
    username: 'ops',
    name: 'Ops',
    role: 'admin',
    permissions: { canCancel: false, canResend: false, canAssign: false },
    passwordHash: GOOD_HASH,
    createdAt: '2026-05-27T00:00:00Z',
    ...over,
  };
}

const mfa = () => createStaffMfaStore(redis, { now: () => clock });

async function enrol(username: string): Promise<Buffer> {
  const begun = await mfa().beginEnrolment(username);
  if (!begun.ok) throw new Error('enrol refused');
  const secret = base32Decode(begun.secretBase32);
  expect(await mfa().confirmEnrolment(username, totpAt(secret, clock))).toBe('ok');
  secrets.set(username, secret);
  clock += 30_000; // the enrolment code's step is spent
  return secret;
}

async function run(p: Promise<string | null>): Promise<string> {
  try {
    return (await p) ?? 'null';
  } catch (e) {
    return (e as Error).message;
  }
}

function pw(username: string, password = 'correct-password'): Promise<string> {
  const fd = new FormData();
  fd.set('username', username);
  fd.set('password', password);
  return run(login(null, fd));
}

function code(c: string): Promise<string> {
  const fd = new FormData();
  fd.set('code', c);
  return run(verifyMfa(null, fd));
}

const goodCode = (username: string) => totpAt(secrets.get(username)!, clock);

beforeEach(async () => {
  redis.dump.clear();
  ringRedis.dump.clear();
  cookieJar.clear();
  audited.length = 0;
  secrets.clear();
  clock = T0;
  currentIp = '198.51.100.7';
  GOOD_HASH ??= await hashPassword('correct-password');
  pgPartnerStore = createPartnerStore(await freshDb());
  await getAuthStore().saveStaff(row({ username: SEED, name: 'Main Admin' }));
  await getAuthStore().saveStaff(row({ username: 'ops' }));
});
afterEach(() => {
  delete process.env.STAFF_MFA_EXEMPT;
  delete process.env.STAFF_MFA_REQUIRED;
});

describe('staff sign-in second step (Program-Fix 17b)', { retry: 0 }, () => {
  it('not enrolled → the password alone signs in, exactly as before (no pending cookie)', async () => {
    expect(await pw('ops')).toBe(OK);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(true);
    expect(cookieJar.has(MFA_PENDING_COOKIE)).toBe(false);
  });

  it('enrolled → the password mints NO session; a pending cookie sends it to /login/mfa', async () => {
    await enrol('ops');
    expect(await pw('ops')).toBe(TO_MFA);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    expect(cookieJar.get(MFA_PENDING_COOKIE)).toMatch(/^[0-9a-f]{64}$/);
    expect(audited.some((e) => e.action === 'auth.login')).toBe(false);
  });

  it('the right code mints the session (a live __Host- session), drops the pending cookie and audits auth.login', async () => {
    await enrol('ops');
    await pw('ops');
    expect(await code(goodCode('ops'))).toBe(OK);
    const token = cookieJar.get(SESSION_COOKIE)!;
    expect(await getAuthStore().getSessionUser(token)).toBe('ops');
    expect(cookieJar.has(MFA_PENDING_COOKIE)).toBe(false);
    const row = audited.find((e) => e.action === 'auth.login');
    expect(row?.meta).toMatchObject({ mfa: true });
  });

  it('a pasted code with spaces around/inside still works; a wrong code is refused and audited', async () => {
    await enrol('ops');
    await pw('ops');
    expect(await code('000000')).toBe('That code is not valid. Try again.');
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    const failed = audited.filter((e) => e.action === 'auth.mfa.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ actorType: 'system', actor: 'login', subjectId: 'ops' });
    const c = goodCode('ops');
    expect(await code(` ${c.slice(0, 3)} ${c.slice(3)} `)).toBe(OK);
  });

  it('a code cannot be replayed on a second sign-in', async () => {
    await enrol('ops');
    await pw('ops');
    const c = goodCode('ops');
    expect(await code(c)).toBe(OK);
    cookieJar.clear();
    await pw('ops');
    expect(await code(c)).toBe('That code is not valid. Try again.');
  });

  it('5 codes per pending token, then back to the password step', async () => {
    await enrol('ops');
    await pw('ops');
    for (let i = 0; i < 5; i++) expect(await code('000000')).toBe('That code is not valid. Try again.');
    expect(await code(goodCode('ops'))).toBe('Too many codes. Sign in again.');
    expect(cookieJar.has(MFA_PENDING_COOKIE)).toBe(false);
    expect(await code(goodCode('ops'))).toBe('REDIRECT:/login');
  });

  it('bad codes consume the login reservations, and re-entering the password never clears them', async () => {
    await enrol('ops');
    await pw('ops');
    for (let i = 0; i < 5; i++) await code('000000');
    expect(await pw('ops')).toBe(TO_MFA);
    for (let i = 0; i < 5; i++) await code('000000');
    // 10 wrong codes from this IP within the hour: the ui bucket is full.
    expect(await pw('ops')).toBe(THROTTLED);
  });

  it('the same holds for an enrolled seed admin (only ui applies to it)', async () => {
    await enrol(SEED);
    await pw(SEED);
    for (let i = 0; i < 5; i++) await code('000000');
    await pw(SEED);
    for (let i = 0; i < 4; i++) await code('000000');
    expect(await code('000000')).toBe('That code is not valid. Try again.'); // the 10th
    expect(await code(goodCode(SEED))).toBe(THROTTLED); // even a right code, before any compare
    expect(await pw(SEED)).toBe(THROTTLED);
    // A fresh IP (the owner's way out) still reaches the code step.
    currentIp = '203.0.113.9';
    expect(await pw(SEED)).toBe(TO_MFA);
    expect(await code(goodCode(SEED))).toBe(OK);
  });

  it('a code attempt while throttled is refused before any compare', async () => {
    await enrol('ops');
    await pw('ops');
    for (let i = 0; i < 5; i++) await code('000000'); // ui 5 (password attempts are refunded)
    expect(await pw('ops')).toBe(TO_MFA);
    for (let i = 0; i < 4; i++) await code('000000'); // ui 9
    expect(await pw('ops')).toBe(TO_MFA); // a fresh token
    expect(await code('000000')).toBe('That code is not valid. Try again.'); // ui 10
    expect(await code(goodCode('ops'))).toBe(THROTTLED); // ui 11: refused before the compare
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  it('suspended between the password and the code → no session', async () => {
    await enrol('ops');
    await pw('ops');
    const s = (await getAuthStore().getStaff('ops'))!;
    await getAuthStore().saveStaff({ ...s, status: 'suspended' });
    expect(await code(goodCode('ops'))).toBe('Account unavailable. Contact SmartRemit support.');
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
    expect(cookieJar.has(MFA_PENDING_COOKIE)).toBe(false);
  });

  it('no pending cookie, or an unknown token → back to /login, nothing minted', async () => {
    expect(await code('123456')).toBe('REDIRECT:/login');
    cookieJar.set(MFA_PENDING_COOKIE, 'f'.repeat(64));
    expect(await code('123456')).toBe('REDIRECT:/login');
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  it('the username comes only from the pending token, never from the form', async () => {
    await enrol('ops');
    await enrol(SEED);
    await pw('ops');
    const fd = new FormData();
    fd.set('code', goodCode(SEED));
    fd.set('username', SEED);
    expect(await run(verifyMfa(null, fd))).toBe('That code is not valid. Try again.');
    expect(cookieJar.has(SESSION_COOKIE)).toBe(false);
  });

  it('STAFF_MFA_EXEMPT never skips the code step for someone who enrolled (r2)', async () => {
    process.env.STAFF_MFA_EXEMPT = 'ops';
    process.env.STAFF_MFA_REQUIRED = 'true';
    await enrol('ops');
    expect(await pw('ops')).toBe(TO_MFA);
  });

  it('seed admin: unenrolled, with STAFF_MFA_REQUIRED on, signs in with the password alone', async () => {
    process.env.STAFF_MFA_REQUIRED = 'true';
    expect(await pw(SEED)).toBe(OK);
  });

  it('a sign-in through the code step replaces the prior session (same path as login)', async () => {
    expect(await pw('ops')).toBe(OK);
    const prior = cookieJar.get(SESSION_COOKIE)!;
    await enrol('ops');
    expect(await pw('ops')).toBe(TO_MFA);
    expect(await code(goodCode('ops'))).toBe(OK);
    expect(await getAuthStore().getSessionUser(prior)).toBeNull();
    expect(cookieJar.get(SESSION_COOKIE)).not.toBe(prior);
  });
  it('break-glass: an enrolled seed admin who lost the device signs in with the password alone after --clear-mfa --apply', async () => {
    await enrol(SEED);
    expect(await pw(SEED)).toBe(TO_MFA);
    cookieJar.clear();
    await runStaffBreakGlass(
      redis as unknown as BreakGlassRedis,
      {
        username: SEED,
        clearMfa: true,
        apply: true,
        now: () => clock,
        seedUsername: SEED,
        seedPassword: '',
        hash: hashPassword,
      },
      () => {},
    );
    expect(await pw(SEED)).toBe(OK);
    expect(cookieJar.has(SESSION_COOKIE)).toBe(true);
  });
});
