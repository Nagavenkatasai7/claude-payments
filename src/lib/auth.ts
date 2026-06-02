import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from './auth-store';
import { getPartnerStore } from './partner-store';
import { SESSION_COOKIE } from './session-cookie';
import { scopeOf, type Scope } from './staff-scope';
import type { Staff } from './types';

export async function getCurrentStaff(): Promise<Staff | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const username = await getAuthStore().getSessionUser(token);
  if (!username) return null;
  const staff = await getAuthStore().getStaff(username);
  if (!staff) return null;

  // Team: a suspended staff member is locked out immediately, mid-session, on the
  // very next request — mirrors the suspended-partner bounce below. Suspend also
  // revokes sessions proactively, but this is the defense-in-depth re-check.
  if (staff.status === 'suspended') return null;

  // P3: partner-scoped staff bounce when their partner is suspended/missing.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') return null;
  }
  return staff;
}

export async function requireStaff(): Promise<Staff> {
  const staff = await getCurrentStaff();
  if (!staff) redirect('/login');
  return staff;
}

export async function requireAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin') redirect('/admin-dashboard');
  return staff;
}

// P3: a platform admin = role:'admin' AND no partnerId. Used by /admin-dashboard/team
// and partner-staff CRUD actions.
export async function requirePlatformAdmin(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role !== 'admin' || staff.partnerId !== undefined) {
    redirect('/admin-dashboard');
  }
  return staff;
}

// P3: convenience for pages — returns staff and pre-computed scope.
export async function requireScope(): Promise<{ staff: Staff; scope: Scope }> {
  const staff = await requireStaff();
  return { staff, scope: scopeOf(staff) };
}
