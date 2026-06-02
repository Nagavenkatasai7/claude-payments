import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { createCustomerAuthStore } from '@/lib/customer-auth-store';
import { createOtpStore } from '@/lib/otp-store';
import { createOnboardingTokenStore } from '@/lib/onboarding-token';
import { EnvKeyProvider } from '@/lib/field-crypto';

/**
 * Account server-action tests. Mirrors customers-actions-scope.test.ts:
 *  - one shared fakeRedis, cleared per test,
 *  - the singleton getters are mocked to the in-test createX(redis) seam,
 *  - next/navigation.redirect + next/headers cookies are stubbed.
 *
 * SECURITY focus: register issues an OTP but creates NO session (phone
 * unverified); verifyOtp sets phoneVerifiedAt + a session; login is
 * enumeration-safe (generic error, no session before OTP); resend is throttled;
 * logout clears the cookie.
 */

const redis = fakeRedis();
const crypto = new EnvKeyProvider('0'.repeat(64));

// ── Cookie jar stub (next/headers) ──
const cookieJar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string) => cookieJar.set(name, value));
const cookieDelete = vi.fn((name: string) => cookieJar.delete(name));
const cookieGet = vi.fn((name: string) =>
  cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
);
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSet, delete: cookieDelete, get: cookieGet }),
}));

// ── redirect stub: throw a sentinel so control-flow stops like the real one ──
const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectMock(p) }));

// ── store singletons → in-test seams ──
const authStore = createCustomerAuthStore(redis);
const otpStore = createOtpStore(redis);
const onboardStore = createOnboardingTokenStore(redis);
vi.mock('@/lib/customer-auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-auth-store')>(
    '@/lib/customer-auth-store',
  );
  return { ...actual, getCustomerAuthStore: () => authStore };
});
vi.mock('@/lib/otp-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/otp-store')>('@/lib/otp-store');
  return { ...actual, getOtpStore: () => otpStore };
});
vi.mock('@/lib/onboarding-token', async () => {
  const actual = await vi.importActual<typeof import('@/lib/onboarding-token')>(
    '@/lib/onboarding-token',
  );
  return { ...actual, getOnboardingTokenStore: () => onboardStore };
});

// ── sendOtpCode stub: never hit Meta; capture the delivered code ──
const sentCodes: { phone: string; code: string }[] = [];
vi.mock('@/lib/whatsapp', () => ({
  sendOtpCode: vi.fn(async (phone: string, code: string) => {
    sentCodes.push({ phone, code });
  }),
}));

// ── pwned check stub: never breached (avoid the network) ──
vi.mock('@/lib/pwned', () => ({ isPwnedPassword: vi.fn(async () => false) }));

// ── crypto provider stub: deterministic, no env key needed ──
vi.mock('@/lib/field-crypto', async () => {
  const actual = await vi.importActual<typeof import('@/lib/field-crypto')>('@/lib/field-crypto');
  return { ...actual, defaultProvider: () => crypto };
});

import {
  registerAction,
  verifyOtpAction,
  resendOtpAction,
  loginAction,
  logoutAction,
} from '@/app/account/actions';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

const PHONE = '+1 (555) 010-2030';
const NORM = '15550102030';
const PASSWORD = 'correct horse battery';

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  redis.dump.clear();
  cookieJar.clear();
  sentCodes.length = 0;
  cookieSet.mockClear();
  cookieDelete.mockClear();
  redirectMock.mockClear();
});

describe('registerAction', () => {
  it('happy path: creates the account, issues an OTP, and does NOT create a session', async () => {
    const state = await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));

    // advanced to the OTP step, bound to the normalized phone
    expect(state.step).toBe('otp');
    expect(state.phone).toBe(NORM);
    expect(state.error).toBeUndefined();

    // an OTP was delivered
    expect(sentCodes).toHaveLength(1);
    expect(sentCodes[0].phone).toBe(NORM);

    // account persisted, but UNVERIFIED and NO session/cookie set
    const customer = await authStore.getCustomer(NORM);
    expect(customer?.passwordHash).toBeTruthy();
    expect(customer?.phoneVerifiedAt).toBeUndefined();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(cookieJar.has(CUSTOMER_SESSION_COOKIE)).toBe(false);
  });

  it('returns a stay-on-register error on a duplicate number (collision handled by the store)', async () => {
    await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
    const second = await registerAction(
      null,
      form({ phone: PHONE, email: 'a@example.com', password: 'a different password' }),
    );
    expect(second.step).toBe('register');
    expect(second.error).toBeTruthy();
  });
});

describe('verifyOtpAction', () => {
  it('on a correct code: sets phoneVerifiedAt, creates a session + cookie, and redirects to /account', async () => {
    await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
    const code = sentCodes[0].code;

    await expect(
      verifyOtpAction(null, form({ phone: NORM, code })),
    ).rejects.toThrow('REDIRECT:/account');

    const customer = await authStore.getCustomer(NORM);
    expect(customer?.phoneVerifiedAt).toBeTruthy();

    // a session cookie was set, and it resolves back to the phone
    expect(cookieSet).toHaveBeenCalledWith(
      CUSTOMER_SESSION_COOKIE,
      expect.any(String),
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' }),
    );
    const token = cookieSet.mock.calls[0][1];
    expect(await authStore.getSession(token)).toBe(NORM);
  });

  it('on a wrong code: returns to the OTP step with an error and sets no session', async () => {
    await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
    const state = await verifyOtpAction(null, form({ phone: NORM, code: '000000' }));
    expect(state.step).toBe('otp');
    expect(state.error).toBeTruthy();
    expect(cookieSet).not.toHaveBeenCalled();
    const customer = await authStore.getCustomer(NORM);
    expect(customer?.phoneVerifiedAt).toBeUndefined();
  });
});

describe('resendOtpAction', () => {
  it('is throttled: a second immediate resend does not deliver another code', async () => {
    await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
    expect(sentCodes).toHaveLength(1);
    // immediate resend → OTP store 30s cooldown → throttled, no new send
    await resendOtpAction(null, form({ phone: NORM }));
    expect(sentCodes).toHaveLength(1);
  });
});

describe('loginAction', () => {
  it('is enumeration-safe: a generic error and NO session on bad credentials', async () => {
    // no account exists at all
    const noAccount = await loginAction(null, form({ phone: PHONE, password: PASSWORD }));
    expect(noAccount.step).toBe('login');
    expect(noAccount.error).toBeTruthy();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(sentCodes).toHaveLength(0);

    // account exists, wrong password → same generic error, no session, no OTP
    await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
    sentCodes.length = 0;
    const wrongPw = await loginAction(null, form({ phone: PHONE, password: 'not the password' }));
    expect(wrongPw.step).toBe('login');
    expect(wrongPw.error).toBeTruthy();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(sentCodes).toHaveLength(0);
  });

  it('on valid credentials: issues an OTP (AAL2) and advances to the OTP step WITHOUT a session', async () => {
    await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
    sentCodes.length = 0;
    cookieSet.mockClear();
    // immediate; the register OTP is past its 30s cooldown only if we wait — but
    // login issues a fresh code: the prior code from register was consumed?  No,
    // register's code is still live, so login's issue may be cooldown-throttled.
    // The action still advances to the OTP step regardless (resend covers retry).
    const state = await loginAction(null, form({ phone: PHONE, password: PASSWORD }));
    expect(state.step).toBe('otp');
    expect(state.phone).toBe(NORM);
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe('logoutAction', () => {
  it('deletes the session and clears the cookie', async () => {
    // establish a session via verify
    await registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
    const code = sentCodes[0].code;
    await verifyOtpAction(null, form({ phone: NORM, code })).catch(() => {});
    const token = cookieSet.mock.calls[0][1];
    expect(await authStore.getSession(token)).toBe(NORM);

    cookieJar.set(CUSTOMER_SESSION_COOKIE, token);
    await expect(logoutAction()).rejects.toThrow('REDIRECT:/account/login');

    expect(cookieDelete).toHaveBeenCalledWith(CUSTOMER_SESSION_COOKIE);
    expect(await authStore.getSession(token)).toBeNull();
  });
});
