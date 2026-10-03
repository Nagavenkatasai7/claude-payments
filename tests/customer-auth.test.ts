import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeRedis } from './helpers';
import { freshDb } from './helpers-db';

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
// pg-backed stores must NOT be constructed inside the (hoisted) factory —
// the mock closes over a module-scope `let` rebuilt per test in beforeEach.
vi.mock('@/lib/customer-auth-store', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/customer-auth-store')>('@/lib/customer-auth-store');
  return { ...actual, getCustomerAuthStore: () => authStore };
});

// One customer portal (Oct 2): null (the default) is a partner without a live portal.
const portalOrigin = vi.hoisted(() => vi.fn(async (_partnerId: string): Promise<string | null> => null));
vi.mock('@/lib/customer-portal-url', async (orig) => ({
  ...(await orig<object>()),
  customerPortalOrigin: (partnerId: string) => portalOrigin(partnerId),
}));

import { getCurrentCustomer, requireCustomer } from '@/lib/customer-auth';
import {
  createCustomerAuthStore,
  getCustomerAuthStore,
  type CustomerAuthStore,
} from '@/lib/customer-auth-store';
import { createCustomerStore, type CustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import type { Customer } from '@/lib/types';

const NORM = '15550102030';

let cs: CustomerStore;
let authStore: CustomerAuthStore;

function seedCustomer() {
  const c: Customer = {
    senderPhone: NORM,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    kycStatus: 'not_started',
    senderCountry: 'US',
    partnerId: 'default',
    passwordHash: '$argon2id$fake',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return cs.saveCustomer(c);
}

beforeEach(async () => {
  redis.dump.clear();
  cookieJar.clear();
  redirectMock.mockClear();
  portalOrigin.mockReset();
  portalOrigin.mockImplementation(async () => null);
  const db = await freshDb();
  cs = createCustomerStore(db, createStore(fakeRedis(), db));
  authStore = createCustomerAuthStore(redis, cs);
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
    const token = await getCustomerAuthStore().createSession(NORM, 'default');
    cookieJar.set(CUSTOMER_SESSION_COOKIE, token);
    const c = await getCurrentCustomer();
    expect(c?.senderPhone).toBe(NORM);
  });

  it('returns null when the session resolves but the Customer record is gone', async () => {
    const token = await getCustomerAuthStore().createSession(NORM, 'default');
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
    const token = await getCustomerAuthStore().createSession(NORM, 'default');
    cookieJar.set(CUSTOMER_SESSION_COOKIE, token);
    const c = await requireCustomer();
    expect(c.senderPhone).toBe(NORM);
  });

  async function signedIn() {
    await seedCustomer();
    cookieJar.set(CUSTOMER_SESSION_COOKIE, await getCustomerAuthStore().createSession(NORM, 'default'));
  }

  it('with a portalPath: sends the customer to THEIR partner portal when it is live', async () => {
    await signedIn();
    portalOrigin.mockImplementation(async (p) => (p === 'default' ? 'https://send.smartremit.ai' : null));
    await expect(requireCustomer({ portalPath: '/portal/transfers/AbC%2F1' })).rejects.toThrow(
      'REDIRECT:https://send.smartremit.ai/portal/transfers/AbC%2F1',
    );
    expect(portalOrigin).toHaveBeenCalledWith('default');
  });

  it('with a portalPath but no live portal: returns the customer (legacy page stays)', async () => {
    await signedIn();
    const c = await requireCustomer({ portalPath: '/portal' });
    expect(c.senderPhone).toBe(NORM);
  });

  it('signed out: the sign-in redirect wins and the portal is never looked up', async () => {
    portalOrigin.mockImplementation(async () => 'https://send.smartremit.ai');
    await expect(requireCustomer({ portalPath: '/portal' })).rejects.toThrow('REDIRECT:/account/login');
    expect(portalOrigin).not.toHaveBeenCalled();
  });

  it('C2: signed out (e.g. an expired legacy cookie) with signedOutTo → the continue route, not the password page', async () => {
    cookieJar.set(CUSTOMER_SESSION_COOKIE, 'f'.repeat(64)); // a cookie whose session is gone
    await expect(
      requireCustomer({ portalPath: '/portal/help/tickets/tk_A1', signedOutTo: '/account/continue/support/tk_A1' }),
    ).rejects.toThrow('REDIRECT:/account/continue/support/tk_A1');
    expect(portalOrigin).not.toHaveBeenCalled();
  });

  it('C2: signed in, signedOutTo changes nothing', async () => {
    await signedIn();
    expect((await requireCustomer({ signedOutTo: '/account/continue/receipt/AbCdEf12' })).senderPhone).toBe(NORM);
  });

  it('without a portalPath the portal is never looked up', async () => {
    await signedIn();
    portalOrigin.mockImplementation(async () => 'https://send.smartremit.ai');
    expect((await requireCustomer()).senderPhone).toBe(NORM);
    expect(portalOrigin).not.toHaveBeenCalled();
  });
});

describe('CUSTOMER_SESSION_COOKIE', () => {
  it('is the __Host-prefixed name', () => {
    expect(CUSTOMER_SESSION_COOKIE).toBe('__Host-sr_session');
  });
});
