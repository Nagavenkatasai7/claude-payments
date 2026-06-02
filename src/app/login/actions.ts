'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
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
  if (!staff || !(await verifyPassword(password, staff.passwordHash))) {
    return 'Invalid username or password.';
  }
  // Team: a suspended staff member cannot log in. Generic message (no leak).
  if (staff.status === 'suspended') {
    return 'Account unavailable. Contact SmartRemit support.';
  }
  // P3: block login if the staff's partner is suspended or missing.
  // Generic error so credential validity isn't leaked.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') {
      return 'Account unavailable. Contact SmartRemit support.';
    }
  }
  // Record an "active" signal for the Team page (re-reads fresh; won't clobber a
  // concurrent suspend/edit — see auth-store.recordLogin).
  await getAuthStore().recordLogin(username);
  const token = await getAuthStore().createSession(username);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  redirect('/admin-dashboard');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getAuthStore().deleteSession(token);
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}
