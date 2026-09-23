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

// Fix 21: requestResetAction sends the reset code AFTER the response via
// next/server's after(). Capture the callbacks so a test can assert what was
// (not) sent before and after the response, then drain them explicitly. When
// `afterThrows` is set the mock behaves like a call outside a request scope.
const afterQueue: Array<() => unknown> = [];
let afterThrows = false;
vi.mock('next/server', async (orig) => {
  const real = await orig<typeof import('next/server')>();
  return {
    ...real,
    after: (task: () => unknown) => {
      if (afterThrows) throw new Error('`after` was called outside a request scope.');
      afterQueue.push(task);
    },
  };
});
async function runAfter(): Promise<void> {
  const tasks = afterQueue.splice(0);
  for (const t of tasks) await t();
}

// pg-backed: the auth store needs a customer store over a fresh Postgres per
// test — module-scope `let` rebuilt in beforeEach (NEVER inside the hoisted
// vi.mock factory; the closure below dereferences it at call time).
let authStore: ReturnType<typeof createCustomerAuthStore>;
let customerStore: ReturnType<typeof createCustomerStore>;
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

const sentCodes: { phone: string; code: string; creds?: unknown; brand?: string }[] = [];
vi.mock('@/lib/whatsapp', () => ({
  sendOtpCode: vi.fn(async (phone: string, code: string, creds?: unknown, brand?: string) => {
    sentCodes.push({ phone, code, creds, brand });
  }),
}));
// Program-Fix 49A (whatsapp-11): the OTP leaves from the OWNING partner's number.
const waContext = vi.hoisted(() => vi.fn(async (_partnerId: string) => ({ brand: 'SmartRemit', waCreds: undefined as unknown })));
vi.mock('@/lib/whatsapp-creds', () => ({ partnerWaContext: waContext }));
vi.mock('@/lib/pwned', () => ({ isPwnedPassword: vi.fn(async () => false) }));
// Program-Fix 46A (F70): the per-IP register throttle reads getRedis(); route it
// to the shared fake (cleared in beforeEach). `limiterDown` simulates an outage.
let limiterDown = false;
vi.mock('@/lib/redis', () => ({
  getRedis: () => {
    if (limiterDown) throw new Error('redis unavailable');
    return redis;
  },
}));
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
  afterQueue.length = 0;
  afterThrows = false;
  limiterDown = false;
  const db = await freshDb();
  customerStore = createCustomerStore(db, createStore(fakeRedis(), db));
  authStore = createCustomerAuthStore(redis, customerStore);
});

describe('OTP delivery uses the owning partner\'s WhatsApp identity (Program-Fix 49A)', () => {
  it('register: the code is sent with the account partner\'s creds and brand', async () => {
    waContext.mockResolvedValueOnce({ brand: 'Acme Remit', waCreds: { phoneNumberId: 'pn_byo', token: 'tok_byo' } });
    await register();
    expect(waContext).toHaveBeenCalledWith('default');
    expect(sentCodes).toHaveLength(1);
    expect(sentCodes[0]).toMatchObject({ creds: { phoneNumberId: 'pn_byo', token: 'tok_byo' }, brand: 'Acme Remit' });
  });
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
    await runAfter(); // fix 21: resend work is post-response too
    expect(sentCodes).toHaveLength(1); // 30s cooldown
  });

  it('does the same pre-response work for a registered and an unregistered reset token, and never sends to a non-account (fix 21)', async () => {
    await register();
    sentCodes.length = 0;
    otpNowMs += 31_000;
    const registered = await requestResetAction(null, form({ phone: PHONE }));
    const unregistered = await requestResetAction(null, form({ phone: '+1 (202) 555-0199' }));
    await runAfter();
    expect(sentCodes).toHaveLength(1); // the request itself: one code, registered phone
    sentCodes.length = 0;
    otpNowMs += 31_000; // past the cooldown so a registered resend really re-sends

    const a = await resendOtpAction(null, form({ pendingToken: unregistered.pendingToken! }));
    expect(afterQueue).toHaveLength(1); // queued, not sent, exactly like a real account
    const b = await resendOtpAction(null, form({ pendingToken: registered.pendingToken! }));
    expect(afterQueue).toHaveLength(2);
    expect(sentCodes).toHaveLength(0); // nothing goes out while either response is built
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.step).toBe('otp');
    expect(a.notice).toBe(b.notice);

    await runAfter();
    expect(sentCodes).toHaveLength(1);
    expect(sentCodes[0].phone).toBe(NORM); // the unregistered number never receives a code
    expect([...redis.dump.keys()].some((k) => k.startsWith('sr_otpip:'))).toBe(true); // one real send counted
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
    await runAfter(); // fix 21: the code goes out after the response
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

// Program-Fix 21 (F55): the reset request is not an account oracle. Every valid
// phone gets the same reply (a fresh pending token, same step + notice); the code
// is sent only for a real account and only AFTER the response; a reset attempted
// with an unregistered token dead-ends like a wrong code and never sets anything.
describe('requestResetAction / resetAction — no account enumeration (fix 21)', () => {
  const UNREG_PHONE = '+1 (202) 555-0199';
  const UNREG_NORM = '12025550199';
  const NEW_PASSWORD = 'staple battery horse';

  it('returns one reply shape for a registered and an unregistered valid phone', async () => {
    await register();
    otpNowMs += 31_000; // past the per-phone resend cooldown (register → reset)
    const registered = await requestResetAction(null, form({ phone: PHONE }));
    const unregistered = await requestResetAction(null, form({ phone: UNREG_PHONE }));

    expect(Object.keys(registered).sort()).toEqual(Object.keys(unregistered).sort());
    expect(registered.step).toBe('otp');
    expect(unregistered.step).toBe('otp');
    expect(registered.notice).toBe(unregistered.notice);
    expect(registered.error).toBeUndefined();
    expect(unregistered.error).toBeUndefined();
    expect(registered.phone).toBe(NORM);
    expect(unregistered.phone).toBe(UNREG_NORM);
    expect(registered.pendingToken).toMatch(/^[0-9a-f]{64}$/);
    expect(unregistered.pendingToken).toMatch(/^[0-9a-f]{64}$/);
    expect(registered.pendingToken).not.toBe(unregistered.pendingToken);
  });

  it('sends the code only for the registered phone, and only AFTER the response', async () => {
    await register();
    sentCodes.length = 0;
    otpNowMs += 31_000;
    await requestResetAction(null, form({ phone: PHONE }));
    await requestResetAction(null, form({ phone: UNREG_PHONE }));
    expect(sentCodes).toHaveLength(0); // nothing sent while the response is being built
    expect(afterQueue).toHaveLength(1); // exactly one post-response task was queued

    await runAfter();
    expect(sentCodes).toHaveLength(1);
    expect(sentCodes[0].phone).toBe(NORM);
    expect(afterQueue).toHaveLength(0);
  });

  it('a reset with an unregistered token is a dead end: wrong-code message, no row created or changed', async () => {
    const req = await requestResetAction(null, form({ phone: UNREG_PHONE }));
    await runAfter();
    expect(sentCodes).toHaveLength(0);

    const s = await resetAction(
      null,
      form({ pendingToken: req.pendingToken!, code: '123456', password: NEW_PASSWORD }),
    );
    expect(s.step).toBe('otp');
    expect(s.error).toBe('That code is incorrect or expired.');
    expect(s.phone).toBe(UNREG_NORM);

    // Nothing was created for the number, and nothing that fix 19 reserves was touched:
    // the verify hit `no_code` before any daily/per-code reservation.
    expect(await customerStore.findByPhone(UNREG_NORM)).toEqual([]);
    expect(await authStore.getCustomer(UNREG_NORM)).toBeNull();
    const keys = [...redis.dump.keys()];
    expect(keys.some((k) => k.startsWith('otp:'))).toBe(false);
    expect(keys.some((k) => k.startsWith('sr_loginfail:'))).toBe(false);
    expect(keys.some((k) => k.startsWith('sr_otpip:'))).toBe(false);
    // The token is NOT consumed by a failed verify (same as a real account's wrong code).
    expect(keys.filter((k) => k.startsWith('pending:'))).toHaveLength(1);
    // A second guess gets the identical message.
    const again = await resetAction(
      null,
      form({ pendingToken: req.pendingToken!, code: '654321', password: NEW_PASSWORD }),
    );
    expect(again.error).toBe('That code is incorrect or expired.');
    expect(await customerStore.findByPhone(UNREG_NORM)).toEqual([]);
  });

  it('a registered phone still resets end to end (the code from the after() task works)', async () => {
    await register();
    sentCodes.length = 0;
    otpNowMs += 31_000;
    const req = await requestResetAction(null, form({ phone: PHONE }));
    await runAfter();
    expect(sentCodes).toHaveLength(1);
    const done = await resetAction(
      null,
      form({ pendingToken: req.pendingToken!, code: sentCodes[0].code, password: NEW_PASSWORD }),
    );
    expect(done.step).toBe('login');
    expect(done.notice).toMatch(/password reset/i);
    expect(await authStore.verifyCustomerPassword(NORM, NEW_PASSWORD)).not.toBeNull();
    expect(await authStore.verifyCustomerPassword(NORM, PASSWORD)).toBeNull();
  });

  it('falls back to an inline send when after() is unavailable (availability over timing)', async () => {
    await register();
    sentCodes.length = 0;
    otpNowMs += 31_000;
    afterThrows = true;
    const req = await requestResetAction(null, form({ phone: PHONE }));
    expect(req.step).toBe('otp');
    expect(req.pendingToken).toMatch(/^[0-9a-f]{64}$/);
    expect(afterQueue).toHaveLength(0);
    expect(sentCodes).toHaveLength(1); // sent inline
    expect(sentCodes[0].phone).toBe(NORM);
  });

  it('an invalid phone keeps the neutral no-token reply', async () => {
    const s = await requestResetAction(null, form({ phone: 'abc' }));
    expect(s.step).toBe('otp');
    expect(s.phone).toBeUndefined();
    expect(s.pendingToken).toBeUndefined();
    expect(afterQueue).toHaveLength(0);
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


// Program-Fix 46A (F70): bounded email + a per-IP registration cap.
describe('registerAction — email bound and per-IP cap (fix 46A)', () => {
  it('300-char email refused, nothing saved', async () => {
    const longEmail = `${'a'.repeat(288)}@example.com`;
    expect(longEmail).toHaveLength(300);
    const spy = vi.spyOn(authStore, 'registerCustomer');
    const state = await registerAction(null, form({ phone: PHONE, email: longEmail, password: PASSWORD }));
    expect(spy).not.toHaveBeenCalled(); // refused by the action itself, before the store
    spy.mockRestore();
    expect(state.step).toBe('register');
    expect(state.error).toBeTruthy();
    expect(await authStore.getCustomer(NORM)).toBeNull();
    expect(sentCodes).toHaveLength(0);
  });

  it('11th register from one IP refused (before any write)', async () => {
    clientIpHeader = '203.0.113.7';
    for (let i = 0; i < 10; i++) {
      const phone = `+1 202 555 ${String(1000 + i)}`;
      const st = await registerAction(null, form({ phone, email: `u${i}@example.com`, password: PASSWORD }));
      expect(st.step).toBe('otp');
    }
    const eleventh = await registerAction(
      null,
      form({ phone: '+1 202 555 2000', email: 'u11@example.com', password: PASSWORD }),
    );
    expect(eleventh.step).toBe('register');
    expect(eleventh.error).toBeTruthy();
    expect(await authStore.getCustomer('12025552000')).toBeNull();
    // Another IP is unaffected.
    clientIpHeader = '198.51.100.20';
    const other = await registerAction(null, form({ phone: '+1 202 555 2001', email: 'o@example.com', password: PASSWORD }));
    expect(other.step).toBe('otp');
  });

  it('only attempts that reach registerCustomer count (phone/email/password-length refusals do not)', async () => {
    clientIpHeader = '203.0.113.8';
    for (let i = 0; i < 12; i++) {
      await registerAction(null, form({ phone: '12', email: 'x@example.com', password: PASSWORD }));
      await registerAction(null, form({ phone: PHONE, email: 'no-at-sign', password: PASSWORD }));
      await registerAction(null, form({ phone: PHONE, email: 'x@example.com', password: 'short' }));
    }
    const st = await register();
    expect(st.step).toBe('otp');
  });

  it('an unknown client IP is never throttled (no shared bucket)', async () => {
    clientIpHeader = null;
    for (let i = 0; i < 11; i++) {
      const st = await registerAction(
        null,
        form({ phone: `+1 202 555 ${String(3000 + i)}`, email: `k${i}@example.com`, password: PASSWORD }),
      );
      expect(st.step).toBe('otp');
    }
  });

  it('fails open when the limiter is unavailable', async () => {
    clientIpHeader = '203.0.113.9';
    limiterDown = true;
    const st = await register();
    expect(st.step).toBe('otp');
  });
});
