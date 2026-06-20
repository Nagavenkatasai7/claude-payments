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
// SUPPORT ENFORCEMENT: every ops/money/people/platform page resolves its data
// through requireScope, so this single bounce IS the role guard for the
// 'support' role (nav hiding alone is never a guard). Ticket pages use
// requireSupportOrAdmin below instead.
export async function requireScope(): Promise<{ staff: Staff; scope: Scope }> {
  const staff = await requireStaff();
  if (staff.role === 'support') redirect('/admin-dashboard/tickets');
  return { staff, scope: scopeOf(staff) };
}

// For the few pages that take raw requireStaff but must exclude support
// (e.g. the partners list). Admin/agent pass through unchanged.
export async function requireOpsStaff(): Promise<Staff> {
  const staff = await requireStaff();
  if (staff.role === 'support') redirect('/admin-dashboard/tickets');
  return staff;
}

// Ticket QUEUE + reassignment surfaces: support staff + admins browse the whole
// queue and (re)assign. Agents are bounced — they never see the global queue.
export async function requireSupportOrAdmin(): Promise<{ staff: Staff; scope: Scope }> {
  const staff = await requireStaff();
  if (staff.role !== 'support' && staff.role !== 'admin') redirect('/admin-dashboard');
  return { staff, scope: scopeOf(staff) };
}

// Ticket WORK surfaces (the ticket detail + my-queue + the per-ticket actions):
// support + admin (full) PLUS agents, who are load-balanced tickets and may work
// ONLY the ones assigned to them. The assignee gate is enforced per-ticket by
// the caller (assertCanWork / a notFound on the detail page) — this guard just
// admits the three ticket-capable roles. Any other role bounces to money ops.
export async function requireTicketWorker(): Promise<{ staff: Staff; scope: Scope }> {
  const staff = await requireStaff();
  if (staff.role !== 'support' && staff.role !== 'admin' && staff.role !== 'agent') {
    redirect('/admin-dashboard');
  }
  return { staff, scope: scopeOf(staff) };
}
