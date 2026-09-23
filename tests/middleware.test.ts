import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { RequestCookies, ResponseCookies } from 'next/dist/compiled/@edge-runtime/cookies';
import { middleware } from '@/middleware';
import {
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  STAFF_SESSION_MAX_AGE_SECONDS,
  staffSessionTokens,
  setStaffSessionCookie,
  clearStaffSessionCookies,
} from '@/lib/session-cookie';
import { fakeRedis } from './helpers';

// ── logout harness: a REAL cookie jar (request cookies in, Set-Cookie out) ──
const redis = fakeRedis();
let requestHeaders = new Headers();
let responseHeaders = new Headers();
vi.mock('next/headers', () => ({
  cookies: async () => {
    const req = new RequestCookies(requestHeaders);
    const res = new ResponseCookies(responseHeaders);
    return {
      get: (n: string) => req.get(n),
      set: (...args: Parameters<ResponseCookies['set']>) => res.set(...args),
      delete: (...args: Parameters<ResponseCookies['delete']>) => res.delete(...args),
    };
  },
  headers: async () => new Headers(),
}));
vi.mock('next/navigation', () => ({
  redirect: (p: string) => {
    throw new Error(`REDIRECT:${p}`);
  },
}));
vi.mock('@/lib/auth-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-store')>('@/lib/auth-store');
  return { ...actual, getAuthStore: () => actual.createAuthStore(redis) };
});
vi.mock('@/lib/staff-auth-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/staff-auth-audit')>('@/lib/staff-auth-audit');
  return {
    ...actual,
    getStaffAuthAudit: () => actual.createStaffAuthAudit({ record: async () => {}, ipKey: () => Buffer.alloc(32, 1) }),
  };
});

import { logout } from '@/app/login/actions';
import { createAuthStore } from '@/lib/auth-store';

/** The Set-Cookie line for `name`, split into lower-cased attribute tokens. */
function setCookieFor(h: Headers, name: string): { value: string; attrs: string[] } | null {
  const line = h.getSetCookie().find((l) => l.startsWith(`${name}=`));
  if (!line) return null;
  const [first, ...rest] = line.split(';').map((p) => p.trim());
  return { value: first.slice(name.length + 1), attrs: rest.map((a) => a.toLowerCase()) };
}

const EPOCH = 'expires=thu, 01 jan 1970 00:00:00 gmt';

beforeEach(() => {
  redis.dump.clear();
  redis.sets.clear();
  requestHeaders = new Headers();
  responseHeaders = new Headers();
});

describe('middleware', () => {
  it('redirects to /login when no session cookie is present', () => {
    const req = new NextRequest('https://app.test/admin-dashboard');
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('allows the request through when a session cookie exists', () => {
    const req = new NextRequest('https://app.test/admin-dashboard');
    req.cookies.set(SESSION_COOKIE, 'some-token');
    const res = middleware(req);
    // NextResponse.next() has no redirect location
    expect(res.headers.get('location')).toBeNull();
  });

  // Program-Fix 45 P1: sessions minted before the rename still carry the old
  // cookie; they keep passing the edge gate until they expire.
  it('also passes a request carrying only the legacy cookie', () => {
    const req = new NextRequest('https://app.test/admin-dashboard');
    req.cookies.set(LEGACY_SESSION_COOKIE, 'some-token');
    expect(middleware(req).headers.get('location')).toBeNull();
  });
});

describe('staff session cookie (Program-Fix 45 P1)', () => {
  it('the cookie name carries the __Host- prefix; the legacy name is the old one', () => {
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(LEGACY_SESSION_COOKIE).toBe('sendhome_session');
    expect(STAFF_SESSION_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
  });

  it('setStaffSessionCookie writes a valid __Host- cookie and expires the legacy one', () => {
    const h = new Headers();
    setStaffSessionCookie(new ResponseCookies(h), 'tok123');
    const c = setCookieFor(h, SESSION_COOKIE);
    expect(c?.value).toBe('tok123');
    // A browser drops a __Host- cookie without Secure or Path=/, or with a Domain.
    expect(c?.attrs).toEqual(
      expect.arrayContaining(['path=/', 'secure', 'httponly', 'samesite=lax', `max-age=${12 * 60 * 60}`]),
    );
    expect(c?.attrs.some((a) => a.startsWith('domain='))).toBe(false);
    const legacy = setCookieFor(h, LEGACY_SESSION_COOKIE);
    expect(legacy?.value).toBe('');
    expect(legacy?.attrs).toEqual(expect.arrayContaining(['path=/', 'secure', EPOCH]));
  });

  it('clearStaffSessionCookies expires both cookies with Path=/ and Secure', () => {
    const h = new Headers();
    clearStaffSessionCookies(new ResponseCookies(h));
    for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
      const c = setCookieFor(h, name);
      expect(c?.value).toBe('');
      expect(c?.attrs).toEqual(expect.arrayContaining(['path=/', 'secure', EPOCH]));
      expect(c?.attrs.some((a) => a.startsWith('domain='))).toBe(false);
    }
  });

  it('staffSessionTokens lists the new cookie first, then the legacy one', () => {
    const h = new Headers({ cookie: `${LEGACY_SESSION_COOKIE}=old; ${SESSION_COOKIE}=new` });
    expect(staffSessionTokens(new RequestCookies(h))).toEqual([
      { token: 'new', legacy: false },
      { token: 'old', legacy: true },
    ]);
    expect(staffSessionTokens(new RequestCookies(new Headers()))).toEqual([]);
    expect(staffSessionTokens(new RequestCookies(new Headers({ cookie: `${SESSION_COOKIE}=` })))).toEqual([]);
  });
});

describe('logout (Program-Fix 45 P1)', () => {
  it('revokes the session and expires both cookies with the attributes a browser honours', async () => {
    const store = createAuthStore(redis);
    const token = await store.createSession('ops');
    requestHeaders = new Headers({ cookie: `${SESSION_COOKIE}=${token}` });
    await expect(logout()).rejects.toThrow('REDIRECT:/login');
    expect(await store.getSessionUser(token)).toBeNull();
    for (const name of [SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
      const c = setCookieFor(responseHeaders, name);
      expect(c?.value).toBe('');
      expect(c?.attrs).toEqual(expect.arrayContaining(['path=/', 'secure', EPOCH]));
    }
  });

  it('a legacy-cookie session is revoked too', async () => {
    const store = createAuthStore(redis);
    const token = await store.createSession('ops');
    requestHeaders = new Headers({ cookie: `${LEGACY_SESSION_COOKIE}=${token}` });
    await expect(logout()).rejects.toThrow('REDIRECT:/login');
    expect(await store.getSessionUser(token)).toBeNull();
  });
});
