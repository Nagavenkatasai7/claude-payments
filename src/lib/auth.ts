import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from './auth-store';
import { SESSION_COOKIE } from './session-cookie';
import type { Staff } from './types';

export async function getCurrentStaff(): Promise<Staff | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const username = await getAuthStore().getSessionUser(token);
  if (!username) return null;
  return getAuthStore().getStaff(username);
}

export async function requireStaff(): Promise<Staff> {
  const staff = await getCurrentStaff();
  if (!staff) redirect('/login');
  return staff;
}

export async function requireAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin') redirect('/dashboard');
  return staff;
}
