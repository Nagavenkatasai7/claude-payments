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
// The client IP seen by the actions (fix 19 keys the login throttle on it);
// null ⇒ the actions fall back to 'unknown', which every pre-fix test relies on.
let clientIpHeader: string | null = null;
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: cookieSet, delete: cookieDelete, get: cookieGet }),
  headers: async () => ({ get: (n: string) => (n === 'x-forwarded-for' ? clientIpHeader : null) }),
}));

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirectMock(p) }));

// pg-backed: the auth store needs a customer store over a fresh Postgres per
// test — module-scope `let` rebuilt in beforeEach (NEVER inside the hoisted
// vi.mock factory; the closure below dereferences it at call time).
let authStore: ReturnType<typeof createCustomerAuthStore>;
// Relative clock seam for the OTP store so a test can step past the 30-s
// per-phone resend cooldown (it spans purposes: register → reset).
let otpNowMs = Date.now();
const otpStore = createOtpStore(redis, { now: () => otpNowMs });
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
  resetAction,
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
  clientIpHeader = null;
  otpNowMs = Date.now();
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
      .mockRejectedValueOnce(new CustomerInputError("We can't set up an account for this number. If you already have one, sign in or reset your password; otherwise contact support."));
    const state = await register();
    expect(state.step).toBe('register');
    expect(state.error).toMatch(/can't set up an account for this number/i);
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

  it('login mints the session under the account row tenant (fix 1, D6)', async () => {
    const reg = await register();
    await expect(
      verifyOtpAction(null, form({ pendingToken: reg.pendingToken!, code: sentCodes[0].code })),
    ).rejects.toThrow('REDIRECT:/account');
    cookieJar.clear();
    cookieSet.mockClear();
    await expect(loginAction(null, form({ phone: PHONE, password: PASSWORD }))).rejects.toThrow('REDIRECT:/account');
    const token = cookieSet.mock.calls[0][1];
    expect((await authStore.resolveSession(token))?.partnerId).toBe('default');
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

// Program-Fix 19 (F71/F67): the attempt is RESERVED before the Argon2 run under
// 10/hour per (phone, IP), 30/day per phone, 50/hour per IP; a stranger from one
// IP cannot lock the owner out, and a successful reset unlocks a distributed lock.
describe('loginAction — attempt caps without third-party lockout (fix 19)', () => {
  const NEW_PASSWORD = 'staple battery horse';
  const IP_A = '198.51.100.1';
  const IP_B = '198.51.100.2';

  /** Register and complete the phone binding so a password login mints a session directly. */
  async function registerVerified() {
    const reg = await register();
    await expect(
      verifyOtpAction(null, form({ pendingToken: reg.pendingToken!, code: sentCodes[0].code })),
    ).rejects.toThrow('REDIRECT:/account');
    cookieJar.clear();
    cookieSet.mockClear();
    sentCodes.length = 0;
  }

  it('10 failures from ip-A lock only (phone, ip-A); the right password from ip-B still logs in', async () => {
    await registerVerified();
    clientIpHeader = IP_A;
    for (let i = 0; i < 10; i++) {
      const s = await loginAction(null, form({ phone: PHONE, password: 'wrong' }));
      expect(s.step).toBe('login');
    }
    // ip-A is locked: the RIGHT password is refused with the same generic error.
    const lockedA = await loginAction(null, form({ phone: PHONE, password: PASSWORD }));
    expect(lockedA.step).toBe('login');
    expect(lockedA.error).toBe('Invalid phone or password.');
    expect(cookieSet).not.toHaveBeenCalled();
    // The owner on another IP is unaffected.
    clientIpHeader = IP_B;
    await expect(loginAction(null, form({ phone: PHONE, password: PASSWORD }))).rejects.toThrow(
      'REDIRECT:/account',
    );
    expect(cookieSet).toHaveBeenCalled();
  });

  it('30 failures over 3 IPs lock the phone for every IP; a reset from the owner IP unlocks that IP the same hour', async () => {
    await registerVerified();
    // The owner's own IP fails 10 times (its hourly bucket is full) …
    clientIpHeader = IP_A;
    for (let i = 0; i < 10; i++) {
      expect((await loginAction(null, form({ phone: PHONE, password: 'wrong' }))).step).toBe('login');
    }
    // … and two strangers fill the rest of the phone/day ceiling.
    for (let i = 0; i < 20; i++) {
      expect(await authStore.reserveLoginAttempt(NORM, i % 2 ? '198.51.100.12' : '198.51.100.13')).toBe(true);
    }
    for (const ip of [IP_A, '198.51.100.99' /* never failed */]) {
      clientIpHeader = ip;
      const locked = await loginAction(null, form({ phone: PHONE, password: PASSWORD }));
      expect(locked.step).toBe('login');
      expect(locked.error).toBe('Invalid phone or password.');
    }
    expect(cookieSet).not.toHaveBeenCalled();

    // The owner proves the phone over WhatsApp and resets the password FROM HOME (ip-A).
    clientIpHeader = IP_A;
    otpNowMs += 31_000; // past the per-phone resend cooldown
    const req = await requestResetAction(null, form({ phone: PHONE }));
    expect(req.pendingToken).toBeTruthy();
    expect(sentCodes).toHaveLength(1);
    const reset = await resetAction(
      null,
      form({ pendingToken: req.pendingToken!, code: sentCodes[0].code, password: NEW_PASSWORD }),
    );
    expect(reset.step).toBe('login');
    expect(reset.notice).toMatch(/password reset/i);

    // Unlocked at home: the new password logs in from ip-A, same hour, same day —
    // the reset cleared the phone/day ceiling AND the resetter's own (phone, IP) bucket.
    await expect(loginAction(null, form({ phone: PHONE, password: NEW_PASSWORD }))).rejects.toThrow(
      'REDIRECT:/account',
    );
  });

  it('a successful login clears the (phone, IP) and phone/day counters', async () => {
    await registerVerified();
    clientIpHeader = IP_A;
    for (let i = 0; i < 9; i++) await loginAction(null, form({ phone: PHONE, password: 'wrong' }));
    expect([...redis.dump.keys()].some((k) => k.startsWith(`sr_loginfail:p:${NORM}:`))).toBe(true);
    await expect(loginAction(null, form({ phone: PHONE, password: PASSWORD }))).rejects.toThrow(
      'REDIRECT:/account',
    );
    const keys = [...redis.dump.keys()];
    expect(keys.some((k) => k.startsWith(`sr_loginfail:pi:${NORM}:`))).toBe(false);
    expect(keys.some((k) => k.startsWith(`sr_loginfail:p:${NORM}:`))).toBe(false);
  });

  it('a malformed login (empty password) burns no reservation', async () => {
    await registerVerified();
    clientIpHeader = IP_A;
    for (let i = 0; i < 20; i++) await loginAction(null, form({ phone: PHONE, password: '' }));
    expect([...redis.dump.keys()].some((k) => k.startsWith('sr_loginfail:'))).toBe(false);
    await expect(loginAction(null, form({ phone: PHONE, password: PASSWORD }))).rejects.toThrow(
      'REDIRECT:/account',
    );
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
