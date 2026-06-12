'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuditLogStore, type StaffAuditAction } from '@/lib/audit-log-store';
import { requirePlatformAdmin } from '@/lib/auth';
import { hashPassword } from '@/lib/password';
import { SUPPORT_DEFAULT_PERMISSIONS, type Staff, type StaffRole } from '@/lib/types';

/**
 * Team management — platform-admin only. Every action is a public POST endpoint,
 * so each re-checks its gate, validates input, and enforces the guardrails from
 * the team-management research:
 *   - username collision guard on create (saveStaff is an unconditional SET);
 *   - partner-exists check when a partner scope is assigned;
 *   - never lock out the platform: the LAST active platform admin can't be
 *     removed, suspended, or demoted out of platform-admin;
 *   - never act destructively on yourself;
 *   - suspend/remove revoke the target's sessions immediately;
 *   - every mutation is written to the audit log.
 *
 * Partner-admins managing their OWN team is intentionally deferred (a separate,
 * scoped write surface) — see the design spec's flagged decisions.
 */

function readPermissions(formData: FormData) {
  return {
    canCancel: formData.get('canCancel') === 'on',
    canResend: formData.get('canResend') === 'on',
    canAssign: formData.get('canAssign') === 'on',
  };
}

function isActivePlatformAdmin(s: Staff): boolean {
  return s.role === 'admin' && !s.partnerId && s.status !== 'suspended';
}

function countActivePlatformAdmins(all: Staff[]): number {
  return all.filter(isActivePlatformAdmin).length;
}

async function audit(
  actor: string,
  action: StaffAuditAction,
  target: string,
  detail?: string,
): Promise<void> {
  await getAuditLogStore().record({
    at: new Date().toISOString(),
    actor,
    action,
    target,
    detail,
  });
}

function scopeLabel(partnerId?: string): string {
  return partnerId ? `partner ${partnerId}` : 'platform';
}

/** Create a teammate with credentials (no email/pending state). */
export async function createStaffAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? 'agent') as StaffRole;
  const partnerField = String(formData.get('partnerId') ?? '').trim();

  if (!username || !name || !password) {
    throw new Error('Name, username, and password are all required.');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (role !== 'admin' && role !== 'agent' && role !== 'support') throw new Error('Invalid role.');

  // Partner scope: empty ⇒ platform; otherwise the partner must exist.
  let partnerId: string | undefined;
  if (partnerField) {
    const partner = await getPartnerStore().getPartner(partnerField);
    if (!partner) throw new Error('Selected partner not found.');
    partnerId = partnerField;
  }

  const store = getAuthStore();
  if (await store.getStaff(username)) {
    throw new Error('That username already exists.');
  }

  const staff: Staff = {
    username,
    name,
    role,
    // Support staff never get money permissions, whatever the form sent.
    permissions: role === 'support' ? { ...SUPPORT_DEFAULT_PERMISSIONS } : readPermissions(formData),
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
    status: 'active',
    ...(partnerId ? { partnerId } : {}),
  };
  await store.saveStaff(staff);
  await audit(actor.username, 'created', username, `${role}, ${scopeLabel(partnerId)}`);
  revalidatePath('/admin-dashboard/team');
  redirect('/admin-dashboard/team');
}

/** Update a teammate's role, permissions, and partner scope. */
export async function updateStaffAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const role = String(formData.get('role') ?? 'agent') as StaffRole;
  const partnerField = String(formData.get('partnerId') ?? '').trim();
  if (role !== 'admin' && role !== 'agent' && role !== 'support') throw new Error('Invalid role.');

  const store = getAuthStore();
  const target = await store.getStaff(username);
  if (!target) throw new Error('Staff member not found.');

  let partnerId: string | undefined;
  if (partnerField) {
    const partner = await getPartnerStore().getPartner(partnerField);
    if (!partner) throw new Error('Selected partner not found.');
    partnerId = partnerField;
  }

  // Guard: don't demote the last active platform admin out of platform-admin.
  const wouldRemainPlatformAdmin = role === 'admin' && !partnerId && target.status !== 'suspended';
  if (isActivePlatformAdmin(target) && !wouldRemainPlatformAdmin) {
    const all = await store.listStaff();
    if (countActivePlatformAdmins(all) <= 1) {
      throw new Error('Cannot change the only platform admin — add another platform admin first.');
    }
  }

  const updated: Staff = {
    ...target,
    role,
    // Support staff never get money permissions, whatever the form sent.
    permissions: role === 'support' ? { ...SUPPORT_DEFAULT_PERMISSIONS } : readPermissions(formData),
    partnerId, // undefined ⇒ platform
  };
  await store.saveStaff(updated);
  await audit(actor.username, 'updated', username, `role ${role}, ${scopeLabel(partnerId)}`);
  revalidatePath('/admin-dashboard/team');
}

/** Suspend or reactivate a teammate (reversible; suspend revokes sessions). */
export async function setStaffStatusAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const status = String(formData.get('status') ?? '');
  if (status !== 'active' && status !== 'suspended') {
    throw new Error('Status must be active or suspended.');
  }

  const store = getAuthStore();
  const target = await store.getStaff(username);
  if (!target) throw new Error('Staff member not found.');

  if (status === 'suspended') {
    if (target.username === actor.username) {
      throw new Error('You cannot suspend your own account.');
    }
    if (isActivePlatformAdmin(target)) {
      const all = await store.listStaff();
      if (countActivePlatformAdmins(all) <= 1) {
        throw new Error('Cannot suspend the only platform admin.');
      }
    }
  }

  await store.saveStaff({ ...target, status });
  if (status === 'suspended') {
    await store.deleteAllSessionsFor(username); // immediate lockout
  }
  await audit(actor.username, status === 'suspended' ? 'suspended' : 'reactivated', username);
  revalidatePath('/admin-dashboard/team');
}

/** Remove a teammate entirely (guarded: not yourself, not the last platform admin). */
export async function removeStaffAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const store = getAuthStore();
  const target = await store.getStaff(username);
  if (!target) return;

  if (target.username === actor.username) {
    throw new Error('You cannot remove your own account.');
  }
  if (isActivePlatformAdmin(target)) {
    const all = await store.listStaff();
    if (countActivePlatformAdmins(all) <= 1) {
      throw new Error('Cannot remove the only platform admin.');
    }
  }

  await store.deleteStaff(username);
  await store.deleteAllSessionsFor(username);
  await audit(actor.username, 'removed', username, `was ${target.role}, ${scopeLabel(target.partnerId)}`);
  revalidatePath('/admin-dashboard/team');
}
