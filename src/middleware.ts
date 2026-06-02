import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session-cookie';

export function middleware(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin-dashboard', '/admin-dashboard/:path*'],
};
