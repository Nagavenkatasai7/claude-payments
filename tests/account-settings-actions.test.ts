import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';
import { createCustomerAuthStore } from '@/lib/customer-auth-store';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { EnvKeyProvider, decryptField } from '@/lib/field-crypto';

/**
 * Settings server-action tests (customer dashboard B1). Focus:
 *  - both actions SELF-GATE (no session ⇒ /account/login) and act only on the
 *    SESSION's account (no phone from the form);
 *  - email is re-encrypted at rest and never clobbers the credential fields;
 *  - password change verifies the CURRENT password under the login brute-force
 *    lock, applies the store's policy, revokes other sessions, and re-mints
 *    THIS device's session;
 *  - every outcome is a FIXED query code (nothing dynamic ever reflected).
 */

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

// pg-backed stores rebuilt per test — module-scope `let` (NEVER inside the
// hoisted vi.mock factory; the closures dereference at call time).
let store: ReturnType<typeof createStore>;
let customerStore: CustomerStore;
let authStore: ReturnType<typeof createCustomerAuthStore>;

vi.mock('@/lib/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/store')>('@/lib/store');
  return { ...actual, getStore: () => store };
});
vi.mock('@/lib/customer-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-store')>('@/lib/customer-store');
  return { ...actual, getCustomerStore: () => customerStore };
});
vi.mock('@/lib/customer-auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/customer-auth-store')>('@/lib/customer-auth-store');
  return { ...actual, getCustomerAuthStore: () => authStore };
});
vi.mock('@/lib/whatsapp', () => ({ sendOtpCode: vi.fn(async () => {}) }));
vi.mock('@/lib/pwned', () => ({ isPwnedPassword: vi.fn(async () => false) }));
vi.mock('@/lib/field-crypto', async () => {
  const actual = await vi.importActual<typeof import('@/lib/field-crypto')>('@/lib/field-crypto');
  return { ...actual, defaultProvider: () => crypto };
});

import { updateEmailAction, changePasswordAction } from '@/app/account/actions';
import { isPwnedPassword } from '@/lib/pwned';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';

const PHONE = '+1 (202) 555-0123';
const NORM = '12025550123';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple battery horse';

function form(values: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

let sessionToken: string;

beforeEach(async () => {
  cookieJar.clear();
  cookieSet.mockClear();
  cookieDelete.mockClear();
  redirectMock.mockClear();
  vi.mocked(isPwnedPassword).mockResolvedValue(false);

  const db = await freshDb();
  store = createStore(fakeRedis(), db);
  customerStore = createCustomerStore(db, store);
  authStore = createCustomerAuthStore(fakeRedis(), customerStore);

  await authStore.registerCustomer({ phone: PHONE, email: 'a@example.com', password: PASSWORD });
  sessionToken = await authStore.createSession(NORM);
  cookieJar.set(CUSTOMER_SESSION_COOKIE, sessionToken);
});

describe('updateEmailAction', () => {
  it('redirects to login when there is no session (self-gating)', async () => {
    cookieJar.clear();
    await expect(updateEmailAction(form({ email: 'x@example.com' }))).rejects.toThrow(
      'REDIRECT:/account/login',
    );
  });

  it('rejects an invalid email with a fixed code and changes nothing', async () => {
    await expect(updateEmailAction(form({ email: 'not-an-email' }))).rejects.toThrow(
      'REDIRECT:/account/settings?err=email',
    );
    const customer = await customerStore.getCustomer(NORM);
    expect(decryptField(customer!.email!, crypto)).toBe('a@example.com');
  });

  it('encrypts + saves a valid email without touching credentials', async () => {
    await expect(updateEmailAction(form({ email: '  new@example.com  ' }))).rejects.toThrow(
      'REDIRECT:/account/settings?ok=email',
    );
    const customer = await customerStore.getCustomer(NORM);
    // Stored as a field-crypto blob, never plaintext.
    expect(customer!.email).not.toContain('new@example.com');
    expect(decryptField(customer!.email!, crypto)).toBe('new@example.com');
    // The password is untouched.
    expect(await authStore.verifyCustomerPassword(NORM, PASSWORD)).toBeTruthy();
  });
});

describe('changePasswordAction', () => {
  it('redirects to login when there is no session (self-gating)', async () => {
    cookieJar.clear();
    await expect(
      changePasswordAction(form({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })),
    ).rejects.toThrow('REDIRECT:/account/login');
  });

  it('refuses a wrong current password with a fixed code; password unchanged', async () => {
    await expect(
      changePasswordAction(form({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD })),
    ).rejects.toThrow('REDIRECT:/account/settings?err=pw_current');
    expect(await authStore.verifyCustomerPassword(NORM, PASSWORD)).toBeTruthy();
    expect(await authStore.verifyCustomerPassword(NORM, NEW_PASSWORD)).toBeNull();
  });

  it('refuses a policy-violating new password (too short) with the fixed policy code', async () => {
    await expect(
      changePasswordAction(form({ currentPassword: PASSWORD, newPassword: 'short' })),
    ).rejects.toThrow('REDIRECT:/account/settings?err=pw_policy');
    expect(await authStore.verifyCustomerPassword(NORM, PASSWORD)).toBeTruthy();
  });

  it('refuses a breached new password with the same fixed policy code', async () => {
    vi.mocked(isPwnedPassword).mockResolvedValue(true);
    await expect(
      changePasswordAction(form({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })),
    ).rejects.toThrow('REDIRECT:/account/settings?err=pw_policy');
  });

  it('changes the password, revokes other sessions, and re-mints THIS session', async () => {
    const otherDevice = await authStore.createSession(NORM);

    await expect(
      changePasswordAction(form({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })),
    ).rejects.toThrow('REDIRECT:/account/settings?ok=password');

    // New credential in force; the old one is dead.
    expect(await authStore.verifyCustomerPassword(NORM, NEW_PASSWORD)).toBeTruthy();
    expect(await authStore.verifyCustomerPassword(NORM, PASSWORD)).toBeNull();

    // Every pre-change session is revoked …
    expect(await authStore.getSession(otherDevice)).toBeNull();
    expect(await authStore.getSession(sessionToken)).toBeNull();

    // … and this device got a fresh session cookie that resolves to the account.
    expect(cookieSet).toHaveBeenCalledWith(
      CUSTOMER_SESSION_COOKIE,
      expect.any(String),
      expect.objectContaining({ httpOnly: true, secure: true }),
    );
    const minted = cookieJar.get(CUSTOMER_SESSION_COOKIE)!;
    expect(minted).not.toBe(sessionToken);
    expect(await authStore.getSession(minted)).toBe(NORM);
  });

  it('locks current-password guessing behind the login brute-force cap', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(
        changePasswordAction(form({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD })),
      ).rejects.toThrow('REDIRECT:/account/settings?err=pw_current');
    }
    // 11th attempt: locked out BEFORE the verify — even with the RIGHT password.
    await expect(
      changePasswordAction(form({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })),
    ).rejects.toThrow('REDIRECT:/account/settings?err=pw_throttle');
  });
});
