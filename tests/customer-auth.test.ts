import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';

const redis = fakeRedis();
const cookieJar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
    set: (n: string, v: string) => cookieJar.set(n, v),
    delete: (n: string) => cookieJar.delete(n),
  }),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    throw new Error('REDIRECT:' + p);
  }),
);
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('@/lib/customer-auth-store', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/customer-auth-store')>('@/lib/customer-auth-store');
  return { ...actual, getCustomerAuthStore: () => actual.createCustomerAuthStore(redis) };
});

import { getCurrentCustomer, requireCustomer } from '@/lib/customer-auth';
import { getCustomerAuthStore } from '@/lib/customer-auth-store';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import type { Customer } from '@/lib/types';

const NORM = '15550102030';

function seedCustomer() {
  const c: Customer = {
    senderPhone: NORM,
    firstSeenAt: 'x',
    kycStatus: 'not_started',
    senderCountry: 'US',
    partnerId: 'default',
    passwordHash: '$argon2id$fake',
    createdAt: 'x',
    updatedAt: 'x',
  };
  return redis.set(`customer:${NORM}`, JSON.stringify(c));
}

beforeEach(() => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('getCurrentCustomer', () => {
  it('returns null when no session cookie is present', async () => {
    expect(await getCurrentCustomer()).toBeNull();
  });

  it('returns null when the cookie token does not resolve to a session', async () => {
    cookieJar.set(CUSTOMER_SESSION_COOKIE, 'bogus-token');
    expect(await getCurrentCustomer()).toBeNull();
  });

  it('returns the Customer for a valid session', async () => {
    await seedCustomer();
    const token = await getCustomerAuthStore().createSession(NORM);
    cookieJar.set(CUSTOMER_SESSION_COOKIE, token);
    const c = await getCurrentCustomer();
    expect(c?.senderPhone).toBe(NORM);
  });

  it('returns null when the session resolves but the Customer record is gone', async () => {
    const token = await getCustomerAuthStore().createSession(NORM);
    cookieJar.set(CUSTOMER_SESSION_COOKIE, token);
    // no customer record seeded
    expect(await getCurrentCustomer()).toBeNull();
  });
});

describe('requireCustomer', () => {
  it('redirects to /account/login when there is no customer', async () => {
    await expect(requireCustomer()).rejects.toThrow('REDIRECT:/account/login');
  });

  it('returns the customer when authenticated', async () => {
    await seedCustomer();
    const token = await getCustomerAuthStore().createSession(NORM);
    cookieJar.set(CUSTOMER_SESSION_COOKIE, token);
    const c = await requireCustomer();
    expect(c.senderPhone).toBe(NORM);
  });
});

describe('CUSTOMER_SESSION_COOKIE', () => {
  it('is the __Host-prefixed name', () => {
    expect(CUSTOMER_SESSION_COOKIE).toBe('__Host-sr_session');
  });
});
