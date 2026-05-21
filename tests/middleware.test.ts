import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { SESSION_COOKIE } from '@/lib/session-cookie';

describe('middleware', () => {
  it('redirects to /login when no session cookie is present', () => {
    const req = new NextRequest('https://app.test/dashboard');
    const res = middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('allows the request through when a session cookie exists', () => {
    const req = new NextRequest('https://app.test/dashboard');
    req.cookies.set(SESSION_COOKIE, 'some-token');
    const res = middleware(req);
    // NextResponse.next() has no redirect location
    expect(res.headers.get('location')).toBeNull();
  });
});
