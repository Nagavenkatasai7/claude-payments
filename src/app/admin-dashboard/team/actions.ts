'use server';

import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { getAuditLogStore, type StaffAuditAction } from '@/lib/audit-log-store';
import { requirePlatformAdmin, requireStaff } from '@/lib/auth';
import { hashPassword, verifyPassword } from '@/lib/password';
import { SUPPORT_DEFAULT_PERMISSIONS, type Staff, type StaffPermissions, type StaffRole } from '@/lib/types';
import { clientIpFrom } from '@/lib/ip-rate-limit';
import { setStaffSessionCookie } from '@/lib/session-cookie';
import { getStaffLoginGuard, isSeedAdminRecord, seedAdminUsername } from '@/lib/staff-login-guard';
import { getStaffAuthAudit } from '@/lib/staff-auth-audit';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { assertNewStaffUsername } from '@/lib/staff-username';
import {
  assertStaffPasswordPolicy,
  PASSWORD_CHANGED_CONCURRENTLY,
  StaffPasswordPolicyError,
  type StaffPasswordFormState,
} from '@/lib/staff-password';

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

function readPermissions(formData: FormData): StaffPermissions {
  return {
    canCancel: formData.get('canCancel') === 'on',
    canResend: formData.get('canResend') === 'on',
    canAssign: formData.get('canAssign') === 'on',
    canRevealPii: formData.get('canRevealPii') === 'on', // Program-Fix 45 P1
  };
}

const PERMISSION_KEYS = ['canCancel', 'canResend', 'canAssign', 'canRevealPii'] as const satisfies readonly (keyof StaffPermissions)[];

/**
 * Program-Fix 45 P1: did an edit change what the member may do? A missing flag
 * (a record saved before it existed) counts as false, so a no-op save of an old
 * record is not a change.
 */
function accessChanged(before: Staff, after: Staff): boolean {
  if (before.role !== after.role || before.partnerId !== after.partnerId) return true;
  return PERMISSION_KEYS.some((k) => (before.permissions[k] === true) !== (after.permissions[k] === true));
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
  partnerId?: string,
): Promise<void> {
  await getAuditLogStore().record({
    at: new Date().toISOString(),
    actor,
    action,
    target,
    detail,
    // partner-demo R5: the target's tenant (audit_events.partner_id), so a
    // partner's own staff feed shows platform changes to its members too
    // (as "SmartRemit": the actor here is always a platform admin).
    partnerId,
    actorScope: 'platform',
  });
}

/**
 * Program-Fix 17a: only the seed admin may act on the seed admin's username
 * (create, edit, suspend, remove, reset). Otherwise another admin could
 * demote the owner account out of its lockout exemption, or remove and
 * re-create it to take the exemption over.
 */
function mayTargetSeed(actor: Staff, targetUsername: string): boolean {
  const seed = seedAdminUsername();
  return seed === '' || targetUsername !== seed || actor.username === seed;
}

function assertMayTargetSeed(actor: Staff, targetUsername: string): void {
  if (!mayTargetSeed(actor, targetUsername)) {
    throw new Error('Only the main admin can change the main admin account.');
  }
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
  assertMayTargetSeed(actor, username);
  assertNewStaffUsername(username); // partner-demo R5 fix round 1: create-only format rule
  if (role !== 'admin' && role !== 'agent' && role !== 'support') throw new Error('Invalid role.');
  // Program-Fix 17a: 12..128 characters + breach check, FAIL-CLOSED on an HIBP
  // outage (a create never lands a possibly-breached password). New passwords
  // only: existing staff passwords are never re-checked at login.
  await assertStaffPasswordPolicy(password, { failClosed: true });

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
  // partner-demo R5 fix round 1: create-if-absent (SET NX), so a concurrent
  // create of the same name loses instead of clobbering the winner.
  if (!(await store.createStaff(staff))) throw new Error('That username already exists.');
  await audit(actor.username, 'created', username, `${role}, ${scopeLabel(partnerId)}`, partnerId);
  // Program-Fix 17b: a re-used username never inherits a stale MFA enrolment
  // (e.g. one left behind by a removal on the previous build). Only AFTER our
  // claim won (a create that lost the race must never reset the winner's MFA)
  // and after the audit row (a failed reset leaves an audited account whose
  // stale enrolment fails closed).
  await getStaffMfaStore().reset(username);
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
  assertMayTargetSeed(actor, target.username);

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
  // Program-Fix 45 P1: a change to role, permissions or partner scope signs the
  // member out everywhere (after the save), so no session keeps acting on the
  // old access. A save that changes nothing leaves their sessions alone.
  if (accessChanged(target, updated)) await store.deleteAllSessionsFor(username);
  await audit(actor.username, 'updated', username, `role ${role}, ${scopeLabel(partnerId)}`, partnerId ?? target.partnerId);
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
  assertMayTargetSeed(actor, target.username);

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
  await audit(actor.username, status === 'suspended' ? 'suspended' : 'reactivated', username, undefined, target.partnerId);
  revalidatePath('/admin-dashboard/team');
}

/** Remove a teammate entirely (guarded: not yourself, not the last platform admin). */
export async function removeStaffAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const store = getAuthStore();
  const target = await store.getStaff(username);
  if (!target) return;
  assertMayTargetSeed(actor, target.username);

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
  await getStaffMfaStore().reset(username); // Program-Fix 17b
  await audit(actor.username, 'removed', username, `was ${target.role}, ${scopeLabel(target.partnerId)}`, target.partnerId);
  revalidatePath('/admin-dashboard/team');
}

// ── Program-Fix 17a: password change (self) + password reset (platform admin) ──
// Both return a StaffPasswordFormState for their useActionState forms, so a
// refusal (policy, throttle, a lost compare-and-set) is shown, never swallowed.

function policyRefusal(err: unknown): StaffPasswordFormState {
  if (err instanceof StaffPasswordPolicyError) return { ok: false, message: err.message };
  throw err;
}

/**
 * Change your OWN password (any signed-in staff member, from
 * /admin-dashboard/account). Reserves an attempt on the SAME buckets as the
 * login (same seed-admin predicate), verifies the current password, applies
 * the policy (breach check fail-OPEN: an HIBP outage must never stop someone
 * rotating a leaked password), compare-and-sets the hash, revokes EVERY
 * session and mints a fresh one for this browser.
 */
export async function changeOwnPasswordAction(
  _prev: StaffPasswordFormState,
  formData: FormData,
): Promise<StaffPasswordFormState> {
  const me = await requireStaff();
  const current = String(formData.get('currentPassword') ?? '');
  const next = String(formData.get('newPassword') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');
  if (!current || !next) return { ok: false, message: 'Enter your current password and a new one.' };
  if (next !== confirm) return { ok: false, message: 'The new passwords do not match.' };

  const store = getAuthStore();
  const fresh = await store.getStaff(me.username);
  if (!fresh) redirect('/login');
  const ip = clientIpFrom(await headers());
  const audit = getStaffAuthAudit();
  const guard = getStaffLoginGuard();
  const reservation = await guard.reserve(me.username, ip, { seedExempt: isSeedAdminRecord(fresh) });
  if (!reservation.allowed) {
    if (reservation.justTripped) {
      await audit.record({
        action: 'auth.login.throttled',
        actorType: 'staff',
        actor: me.username,
        subjectId: me.username,
        partnerId: fresh.partnerId,
        ip,
        meta: { bucket: reservation.justTripped, context: 'password.change' },
      });
    }
    return { ok: false, message: 'Too many attempts. Try again later.' };
  }
  if (!(await verifyPassword(current, fresh.passwordHash))) {
    await audit.record({
      action: 'auth.login.failed',
      actorType: 'staff',
      actor: me.username,
      subjectId: me.username,
      partnerId: fresh.partnerId,
      ip,
      meta: { reason: 'invalid', context: 'password.change' },
    });
    return { ok: false, message: 'Your current password is incorrect.' };
  }
  // The current password is proven: this attempt never counts against the budget.
  await guard.refund(reservation.keys);
  await guard.clear(me.username, ip);
  if (next === current) return { ok: false, message: 'Choose a new password that differs from the current one.' };
  try {
    await assertStaffPasswordPolicy(next, { failClosed: false });
  } catch (err) {
    return policyRefusal(err);
  }

  const newHash = await hashPassword(next);
  let wrote = await store.setPasswordHash(me.username, fresh.passwordHash, newHash);
  if (!wrote) {
    // Retry ONCE, only when the fresh hash still proves the current password
    // (a concurrent lazy rehash of the same password). A reset by an admin no
    // longer verifies, so it is reported, never overwritten.
    const again = await store.getStaff(me.username);
    if (again && (await verifyPassword(current, again.passwordHash))) {
      wrote = await store.setPasswordHash(me.username, again.passwordHash, newHash);
    }
  }
  // Re-read after the write: the compare-and-set is not atomic (auth-store).
  if (!wrote || (await store.getStaff(me.username))?.passwordHash !== newHash) {
    return { ok: false, message: PASSWORD_CHANGED_CONCURRENTLY };
  }
  await store.deleteAllSessionsFor(me.username);
  const token = await store.createSession(me.username);
  setStaffSessionCookie(await cookies(), token); // Program-Fix 45 P1: the __Host- cookie
  await audit.record({
    action: 'auth.password.change',
    actorType: 'staff',
    actor: me.username,
    subjectId: me.username,
    partnerId: fresh.partnerId,
    ip,
  });
  return { ok: true, message: 'Password changed. Every other session was signed out.' };
}

/**
 * Reset a teammate's password (platform admin, from the Team page). The target
 * must exist; your own password goes through the Account page (it needs the
 * current one); only the seed admin may reset the seed admin. Works on a
 * SUSPENDED member without reactivating it (auth-store.setPasswordHash).
 * Breach check FAIL-CLOSED. Revokes every session of the target.
 */
export async function resetStaffPasswordAction(
  _prev: StaffPasswordFormState,
  formData: FormData,
): Promise<StaffPasswordFormState> {
  const actor = await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const next = String(formData.get('newPassword') ?? '');
  const store = getAuthStore();
  const target = username ? await store.getStaff(username) : null;
  if (!target) return { ok: false, message: 'Staff member not found.' };
  if (target.username === actor.username) {
    return { ok: false, message: 'Change your own password from your Account page.' };
  }
  if (!mayTargetSeed(actor, target.username)) {
    return { ok: false, message: 'Only the main admin can reset the main admin password.' };
  }
  try {
    await assertStaffPasswordPolicy(next, { failClosed: true });
  } catch (err) {
    return policyRefusal(err);
  }
  const newHash = await hashPassword(next);
  const wrote = await store.setPasswordHash(target.username, target.passwordHash, newHash);
  // Re-read after the write: the compare-and-set is not atomic (auth-store).
  if (!wrote || (await store.getStaff(target.username))?.passwordHash !== newHash) {
    return { ok: false, message: PASSWORD_CHANGED_CONCURRENTLY };
  }
  await store.deleteAllSessionsFor(target.username);
  await getStaffLoginGuard().clearUsernameDay(target.username);
  await getStaffAuthAudit().record({
    action: 'auth.password.reset',
    actorType: 'staff',
    actor: actor.username,
    subjectId: target.username,
    partnerId: target.partnerId,
    ip: clientIpFrom(await headers()),
  });
  revalidatePath('/admin-dashboard/team');
  return { ok: true, message: `Password reset for ${target.username}. Their sessions were signed out.` };
}

/**
 * Program-Fix 17b: turn a member's TOTP MFA off (lost device). Platform admin
 * only; the target must exist; only the seed admin may reset the seed admin
 * (the same guard as every other seed-targeting action). Also revokes the
 * target's sessions, so a session opened with the old factor does not
 * outlive the reset. Audited as auth.mfa.reset. The owner's break-glass for a
 * seed admin who cannot sign in at all is `scripts/staff-break-glass.ts
 * <username> --clear-mfa --apply`.
 */
export async function resetStaffMfaAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const store = getAuthStore();
  const target = username ? await store.getStaff(username) : null;
  if (!target) return;
  assertMayTargetSeed(actor, target.username);
  await getStaffMfaStore().reset(target.username);
  await store.deleteAllSessionsFor(target.username);
  await getStaffAuthAudit().record({
    action: 'auth.mfa.reset',
    actorType: 'staff',
    actor: actor.username,
    subjectId: target.username,
    partnerId: target.partnerId,
    ip: clientIpFrom(await headers()),
  });
  revalidatePath('/admin-dashboard/team');
}
