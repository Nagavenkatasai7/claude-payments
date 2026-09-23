'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { ensureSeedAdmin } from '@/lib/seed';
import { hashPassword, needsRehash, verifyPasswordOrDummy } from '@/lib/password';
import { SESSION_COOKIE } from '@/lib/session-cookie';

export async function login(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  await ensureSeedAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const staff = await getAuthStore().getStaff(username);
  // Fix 21 (F62): ONE Argon2id verify on every attempt — an unknown username
  // pays the same work against a per-instance dummy hash, so response time
  // does not say whether the username exists. One generic message either way.
  const ok = await verifyPasswordOrDummy(password, staff?.passwordHash);
  if (!staff || !ok) {
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
  // Fix 21: lazy upgrade of a legacy scrypt hash to Argon2id. Only after every
  // refusal gate above, and through a fresh re-read (auth-store.updatePasswordHash)
  // so a concurrent suspend is never undone. After this the account verifies
  // with the same cost as every other one.
  if (needsRehash(staff.passwordHash)) {
    await getAuthStore().updatePasswordHash(username, await hashPassword(password));
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
