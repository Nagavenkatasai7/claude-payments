import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
const { resolveSiteSlug } = vi.hoisted(() => ({ resolveSiteSlug: vi.fn() }));
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug }));
import { proxy } from '@/proxy';
import { REFERRAL_COOKIE, REFERRAL_COOKIE_MAX_AGE_S, referralCodeToStore, referralCookieOptions } from '@/lib/referral-code';

// Batch B4: /portal/login?ref=REF-XXXXXX keeps a format-checked code in a 30-day cookie
// (HttpOnly, SameSite=Lax, Secure in production, host-only). Pages cannot set cookies,
// so the proxy sets it on the GET of the sign-in page.

const site = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
  new NextRequest(`https://send.smartremit.ai${path}`, {
    method,
    headers: { host: 'send.smartremit.ai', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '[]' }),
  });
const refCookies = (r: Response) => r.headers.getSetCookie().filter((c) => c.startsWith(`${REFERRAL_COOKIE}=`));

beforeEach(() => {
  resolveSiteSlug.mockReset();
  resolveSiteSlug.mockResolvedValue('default');
  vi.stubEnv('CUSTOMER_PORTAL_ENABLED', '1');
});
afterEach(() => vi.unstubAllEnvs());

describe('referralCodeToStore (pure)', () => {
  const base = { method: 'GET', pathname: '/portal/login', ref: 'REF-TANA01', existing: undefined };
  it('a GET of the sign-in page with a valid ref stores the upper-cased code', () => {
    expect(referralCodeToStore(base)).toBe('REF-TANA01');
    expect(referralCodeToStore({ ...base, ref: ' ref-tana01 ' })).toBe('REF-TANA01');
    expect(referralCodeToStore({ ...base, method: 'HEAD' })).toBe('REF-TANA01');
  });
  it('nothing for a bad ref, another path, a POST, or when a valid code is already stored', () => {
    expect(referralCodeToStore({ ...base, ref: 'REF-<script>' })).toBeNull();
    expect(referralCodeToStore({ ...base, ref: null })).toBeNull();
    expect(referralCodeToStore({ ...base, pathname: '/portal' })).toBeNull();
    expect(referralCodeToStore({ ...base, method: 'POST' })).toBeNull();
    expect(referralCodeToStore({ ...base, existing: 'REF-OTHER1' })).toBeNull();
    expect(referralCodeToStore({ ...base, existing: 'garbage' })).toBe('REF-TANA01');
  });
  it('options: httpOnly, Lax, path /, 30 days; Secure only in production; never a domain', () => {
    expect(referralCookieOptions(true)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: REFERRAL_COOKIE_MAX_AGE_S });
    expect(referralCookieOptions(false).secure).toBe(false);
    expect(REFERRAL_COOKIE_MAX_AGE_S).toBe(30 * 86_400);
  });
});

describe('proxy: the portal sign-in page keeps the referral code', () => {
  it('GET /portal/login?ref=REF-TANA01 sets the cookie (HttpOnly, Lax, 30 days, no Domain)', async () => {
    const c = refCookies(await proxy(site('/portal/login?ref=REF-TANA01')));
    expect(c).toHaveLength(1);
    const v = c[0].toLowerCase();
    expect(c[0]).toContain(`${REFERRAL_COOKIE}=REF-TANA01`);
    expect(v).toContain('httponly');
    expect(v).toContain('samesite=lax');
    expect(v).toContain(`max-age=${REFERRAL_COOKIE_MAX_AGE_S}`);
    expect(v).toContain('path=/');
    expect(v).not.toContain('domain=');
  });

  it('a malformed ref, another page, a POST or an existing code sets nothing', async () => {
    expect(refCookies(await proxy(site('/portal/login?ref=%3Cscript%3E')))).toEqual([]);
    expect(refCookies(await proxy(site('/portal/transfers?ref=REF-TANA01')))).toEqual([]);
    expect(refCookies(await proxy(site('/portal/login?ref=REF-TANA01', 'POST', { 'next-action': 'a', 'content-type': 'text/plain' })))).toEqual([]);
    expect(refCookies(await proxy(site('/portal/login?ref=REF-TANA01', 'GET', { cookie: `${REFERRAL_COOKIE}=REF-OTHER1` })))).toEqual([]);
  });

  it('the apex never sets it', async () => {
    const apex = new NextRequest('https://smartremit.ai/portal/login?ref=REF-TANA01', { headers: { host: 'smartremit.ai' } });
    expect(refCookies(await proxy(apex))).toEqual([]);
  });
});
