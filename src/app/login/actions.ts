'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { ensureSeedAdmin } from '@/lib/seed';
import { verifyPassword } from '@/lib/password';
import { SESSION_COOKIE } from '@/lib/session-cookie';

export async function login(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  await ensureSeedAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const staff = await getAuthStore().getStaff(username);
  if (!staff || !verifyPassword(password, staff.passwordHash)) {
    return 'Invalid username or password.';
  }
  const token = await getAuthStore().createSession(username);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  redirect('/dashboard');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getAuthStore().deleteSession(token);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
