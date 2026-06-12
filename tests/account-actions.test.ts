import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerAuthStore, CustomerInputError } from '@/lib/customer-auth-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { createOtpStore } from '@/lib/otp-store';
import { createOnboardingTokenStore } from '@/lib/onboarding-token';
import { createPendingAuthStore } from '@/lib/pending-auth-store';
import { EnvKeyProvider } from '@/lib/field-crypto';

/**
 * Account server-action tests. SECURITY focus — proves the AAL2 binding:
 *  - register/login issue an OTP + a single-use PENDING-AUTH token, no session;
 *  - verifyOtp mints a session ONLY when it consumes a valid login/register
 *    pending token (a correct OTP alone — or a reset token — cannot);
 *  - login is enumeration-safe + brute-force locked;
 *  - logout clears the cookie.
 */

const redis = fakeRedis();
const crypto = new EnvKeyProvider('0'.repeat(64));

const cookieJar = new Map<string, string>();
const cookieSet = vi.fn((name: string, value: string) => cookieJar.set(name, value));
const cookieDelete = vi.fn((name: string) => cookieJar.delete(name));
const cookieGet = vi.fn((name: string) =>
  cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
);
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSet, delete: cookieDelete, get: cookieGet }),
  headers: async () => ({ get: (_n: string) => null }),
}));

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectMock(p) }));

// pg-backed: the auth store needs a customer store over a fresh Postgres per
// test — module-scope `let` rebuilt in beforeEach (NEVER inside the hoisted
// vi.mock factory; the closure below dereferences it at call time).
let authStore: ReturnType<typeof createCustomerAuthStore>;
const otpStore = createOtpStore(redis);
const onboardStore = createOnboardingTokenStore(redis);
const pendingStore = createPendingAuthStore(redis);
vi.mock('@/lib/customer-auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-auth-store')>('@/lib/customer-auth-store');
  return { ...actual, getCustomerAuthStore: () => authStore };
});
vi.mock('@/lib/otp-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/otp-store')>('@/lib/otp-store');
  return { ...actual, getOtpStore: () => otpStore };
});
vi.mock('@/lib/onboarding-token', async () => {
  const actual = await vi.importActual<typeof import('@/lib/onboarding-token')>('@/lib/onboarding-token');
  return { ...actual, getOnboardingTokenStore: () => onboardStore };
});
vi.mock('@/lib/pending-auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pending-auth-store')>('@/lib/pending-auth-store');
  return { ...actual, getPendingAuthStore: () => pendingStore };
});

const sentCodes: { phone: string; code: string }[] = [];
vi.mock('@/lib/whatsapp', () => ({
  sendOtpCode: vi.fn(async (phone: string, code: string) => {
    sentCodes.push({ phone, code });
  }),
}));
vi.mock('@/lib/pwned', () => ({ isPwnedPassword: vi.fn(async () => false) }));
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
  requestResetAction,
} from '@/app/account/actions';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

const PHONE = '+1 (202) 555-0123';
const NORM = '12025550123';
const PASSWORD = 'correct horse battery';

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}
async function register() {
  return registerAction(null, form({ phone: PHONE, email: 'a@example.com', password: PASSWORD }));
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  sentCodes.length = 0;
  cookieSet.mockClear();
  cookieDelete.mockClear();
  redirectMock.mockClear();
  const db = await freshDb();
  authStore = createCustomerAuthStore(redis, createCustomerStore(db, createStore(fakeRedis(), db)));
});

describe('registerAction', () => {
  it('creates the account + issues an OTP + a pending token, but NO session', async () => {
    const state = await register();
    expect(state.step).toBe('otp');
    expect(state.phone).toBe(NORM);
    expect(state.pendingToken).toBeTruthy();
    expect(sentCodes).toHaveLength(1);
    const customer = await authStore.getCustomer(NORM);
    expect(customer?.passwordHash).toBeTruthy();
    expect(customer?.phoneVerifiedAt).toBeUndefined();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('stay-on-register error on a duplicate number', async () => {
    await register();
    const second = await register();
    expect(second.step).toBe('register');
    expect(second.error).toBeTruthy();
  });

  it('does NOT leak an internal/config error to the customer (generic fallback)', async () => {
    // Simulate an unset FIELD_ENCRYPTION_KEY (or any internal failure): the raw
    // message names an env var and must never reach the form.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi
      .spyOn(authStore, 'registerCustomer')
      .mockRejectedValueOnce(new Error('FIELD_ENCRYPTION_KEY missing or not 32 bytes'));
    const state = await register();
    expect(state.step).toBe('register');
    expect(state.error).toBe('Could not create your account. Please try again.');
    expect(state.error).not.toMatch(/FIELD_ENCRYPTION_KEY/);
    expect(state.error).not.toMatch(/32 bytes/);
    spy.mockRestore();
    errSpy.mockRestore();
  });

  it('still surfaces an intentional CustomerInputError message verbatim', async () => {
    const spy = vi
      .spyOn(authStore, 'registerCustomer')
      .mockRejectedValueOnce(new CustomerInputError('An account already exists for this number.'));
    const state = await register();
    expect(state.step).toBe('register');
    expect(state.error).toMatch(/already exists/i);
    spy.mockRestore();
  });
});

describe('verifyOtpAction — AAL2 binding', () => {
  it('correct OTP + valid pending token → session + redirect', async () => {
    const reg = await register();
    const code = sentCodes[0].code;
    await expect(
      verifyOtpAction(null, form({ pendingToken: reg.pendingToken!, code })),
    ).rejects.toThrow('REDIRECT:/account');
    expect((await authStore.getCustomer(NORM))?.phoneVerifiedAt).toBeTruthy();
    const token = cookieSet.mock.calls[0][1];
    expect(await authStore.getSession(token)).toBe(NORM);
  });

  it('REJECTS a correct OTP with NO/forged pending token (no password-skip bypass)', async () => {
    const reg = await register();
    const code = sentCodes[0].code;
    void reg;
    const s = await verifyOtpAction(null, form({ pendingToken: 'forged-token', code }));
    expect(s.step).toBe('login');
    expect(s.error).toBeTruthy();
    expect(cookieSet).not.toHaveBeenCalled(); // no session minted
  });

  it('REJECTS a reset pending token at the login endpoint (purpose mismatch)', async () => {
    await register(); // account exists
    const reset = await requestResetAction(null, form({ phone: PHONE }));
    expect(reset.pendingToken).toBeTruthy();
    // The purpose check rejects the reset-token BEFORE any OTP check, so the code
    // value is irrelevant — a 'reset' token can never mint a login session here.
    const s = await verifyOtpAction(null, form({ pendingToken: reset.pendingToken!, code: '000000' }));
    expect(s.step).toBe('login');
    expect(s.error).toBeTruthy();
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('wrong OTP → back to OTP step, no session', async () => {
    const reg = await register();
    const s = await verifyOtpAction(null, form({ pendingToken: reg.pendingToken!, code: '000000' }));
    expect(s.step).toBe('otp');
    expect(s.error).toBeTruthy();
    expect(cookieSet).not.toHaveBeenCalled();
  });
});

describe('resendOtpAction', () => {
  it('throttled: an immediate resend (same pending token) delivers no new code', async () => {
    const reg = await register();
    expect(sentCodes).toHaveLength(1);
    await resendOtpAction(null, form({ pendingToken: reg.pendingToken! }));
    expect(sentCodes).toHaveLength(1); // 30s cooldown
  });
});

describe('loginAction', () => {
  it('enumeration-safe: generic error + no session/OTP on bad credentials', async () => {
    const noAccount = await loginAction(null, form({ phone: PHONE, password: PASSWORD }));
    expect(noAccount.step).toBe('login');
    expect(noAccount.error).toBeTruthy();
    expect(sentCodes).toHaveLength(0);

    await register();
    sentCodes.length = 0;
    const wrong = await loginAction(null, form({ phone: PHONE, password: 'not the password' }));
    expect(wrong.step).toBe('login');
    expect(wrong.error).toBeTruthy();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(sentCodes).toHaveLength(0);
  });

  it('VERIFIED account + valid credentials → session minted directly, NO OTP', async () => {
    const reg = await register();
    // Complete the registration binding (the one-time phone-ownership OTP).
    await expect(
      verifyOtpAction(null, form({ pendingToken: reg.pendingToken!, code: sentCodes[0].code })),
    ).rejects.toThrow('REDIRECT:/account');
    cookieJar.clear();
    sentCodes.length = 0;
    cookieSet.mockClear();
    await expect(
      loginAction(null, form({ phone: PHONE, password: PASSWORD })),
    ).rejects.toThrow('REDIRECT:/account');
    expect(cookieSet).toHaveBeenCalled(); // session cookie set immediately
    expect(sentCodes).toHaveLength(0);    // no code is ever sent for login
  });

  it('NEVER-VERIFIED account (planted registration) cannot password-login — gets the register OTP step', async () => {
    // Attack: register a bot-only victim's phone with the attacker's password,
    // abandon the OTP, then try to password-login. The binding gate must
    // refuse to mint a session and demand the (victim-delivered) code.
    await register();
    sentCodes.length = 0;
    cookieSet.mockClear();
    const s = await loginAction(null, form({ phone: PHONE, password: PASSWORD }));
    expect(s.step).toBe('otp');           // binding required, no session
    expect(cookieSet).not.toHaveBeenCalled();
    // No sent-code assertion: register just issued one, so the per-phone
    // resend throttle may (correctly) swallow this immediate re-issue. What
    // matters is that any code that IS sent goes to the phone's WhatsApp and
    // no session exists without it.
  });

  it('a stale login-purpose pending token can NEVER mint a session via verifyOtp', async () => {
    // Login no longer creates pending tokens; if one existed (old deploy,
    // crafted), verifyOtpAction must refuse — only 'register' tokens mint here.
    await register();
    const { getPendingAuthStore } = await import('@/lib/pending-auth-store');
    const stale = await getPendingAuthStore().create(PHONE, 'login');
    cookieSet.mockClear();
    const s = await verifyOtpAction(null, form({ pendingToken: stale, code: '123456' }));
    expect(s.step).toBe('login');
    expect(cookieSet).not.toHaveBeenCalled();
  });

  it('locks the account after 10 failed attempts (brute-force)', async () => {
    await register();
    for (let i = 0; i < 10; i++) await loginAction(null, form({ phone: PHONE, password: 'wrong' }));
    sentCodes.length = 0;
    // even the CORRECT password is now refused (generic), no OTP issued
    const s = await loginAction(null, form({ phone: PHONE, password: PASSWORD }));
    expect(s.step).toBe('login');
    expect(s.error).toBeTruthy();
    expect(sentCodes).toHaveLength(0);
  });
});

describe('logoutAction', () => {
  it('deletes the session and clears the cookie', async () => {
    const reg = await register();
    const code = sentCodes[0].code;
    await verifyOtpAction(null, form({ pendingToken: reg.pendingToken!, code })).catch(() => {});
    const token = cookieSet.mock.calls[0][1];
    cookieJar.set(CUSTOMER_SESSION_COOKIE, token);
    await expect(logoutAction()).rejects.toThrow('REDIRECT:/account/login');
    expect(cookieDelete).toHaveBeenCalledWith(CUSTOMER_SESSION_COOKIE);
    expect(await authStore.getSession(token)).toBeNull();
  });
});
