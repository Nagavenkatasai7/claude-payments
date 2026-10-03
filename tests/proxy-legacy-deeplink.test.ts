import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { CUSTOMER_SESSION_COOKIE } from '@/lib/customer-session-cookie';
import { SESSION_COOKIE } from '@/lib/session-cookie';

const { resolver } = vi.hoisted(() => ({ resolver: vi.fn() }));
vi.mock('@/lib/site-tenant-resolver', () => ({ resolveSiteSlug: resolver }));
import { proxy } from '@/proxy';

// Lost-features p4 C2: on the apex, a SIGNED-OUT GET for an old /account receipt or ticket link goes
// to the public /account/continue/<kind>/<id> route (which forwards to the right partner's portal
// sign-in) instead of the password page. Everything else in the legacy gate is unchanged, and the
// apex stays synchronous (tests/proxy-apex-noop.test.ts pins the rest against its frozen oracle).

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
function req(path: string, opts: { method?: string; cookies?: Record<string, string>; search?: string } = {}) {
  const r = new NextRequest(`https://smartremit.ai${path}${opts.search ?? ''}`, { method: opts.method ?? 'GET', headers: { host: 'smartremit.ai' } });
  for (const [k, v] of Object.entries(opts.cookies ?? {})) r.cookies.set(k, v);
  return r;
}
function location(path: string, opts: Parameters<typeof req>[1] = {}) {
  const res = proxy(req(path, opts));
  expect(res).not.toBeInstanceOf(Promise);
  return (res as Response).headers.get('location');
}

describe('signed-out legacy deep links (apex)', () => {
  it('a receipt link → /account/continue/receipt/<id>', () => {
    expect(location(`/account/receipt/${ID}`)).toBe(`https://smartremit.ai/account/continue/receipt/${ID}`);
  });
  it('a ticket link → /account/continue/support/<id>; the query string is dropped', () => {
    expect(location('/account/support/tk_Abc-_1', { search: '?x=1' })).toBe('https://smartremit.ai/account/continue/support/tk_Abc-_1');
  });
  it.each(['/account/support/new', '/account/support/abc', '/account/receipt/x/y', '/account/history', '/account'])(
    '%s → /account/login (unchanged)',
    (p) => expect(location(p)).toBe('https://smartremit.ai/account/login'),
  );
  it('HEAD is treated like GET', () => {
    expect(location(`/account/receipt/${ID}`, { method: 'HEAD' })).toBe(`https://smartremit.ai/account/continue/receipt/${ID}`);
  });
  it('a POST to a legacy link still goes to /account/login (the continue route is GET only)', () => {
    expect(location(`/account/receipt/${ID}`, { method: 'POST' })).toBe('https://smartremit.ai/account/login');
  });
  it('with a customer cookie the legacy page is served (pass-through)', () => {
    expect(location(`/account/receipt/${ID}`, { cookies: { [CUSTOMER_SESSION_COOKIE]: 't' } })).toBeNull();
  });
  it('/account/continue/... itself is public', () => {
    expect(location(`/account/continue/receipt/${ID}`)).toBeNull();
    expect(location('/account/continue/support/tk_A1')).toBeNull();
  });
  it('staff paths are unchanged', () => {
    expect(location('/admin-dashboard/tickets')).toBe('https://smartremit.ai/login');
    expect(location('/admin-dashboard/tickets', { cookies: { [SESSION_COOKIE]: 't' } })).toBeNull();
  });
});
