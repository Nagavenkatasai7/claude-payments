'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireStaff } from '@/lib/auth';
import { getAuthStore } from '@/lib/auth-store';
import { verifyPassword } from '@/lib/password';
import { getStaffLoginGuard, isSeedAdminRecord } from '@/lib/staff-login-guard';
import { clientIpFrom } from '@/lib/ip-rate-limit';
import { getStaffAuthAudit } from '@/lib/staff-auth-audit';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { logWarn } from '@/lib/log';

/**
 * Program-Fix 17b: TOTP enrolment for the signed-in staff member (any role,
 * from /admin-dashboard/account). Public POST endpoints: each self-gates with
 * requireStaff and acts ONLY on the session's own username (never a form
 * field). The secret is generated server-side, returned once in the action
 * state for the authenticator app (manual key + otpauth URI; no QR library),
 * held sealed in Redis for 10 minutes, and turned on only by a valid code.
 * It is never logged or audited.
 */
export interface MfaEnrolState {
  ok: boolean;
  message?: string;
  secret?: string;
  uri?: string;
}

const UNAVAILABLE = 'Two-step verification is unavailable right now. Try again later.';

/**
 * Step 1. Re-proves the CURRENT password first (reserved on the same
 * login-guard buckets as sign-in, same seed-admin predicate), so a borrowed
 * or stolen session alone cannot bind its own authenticator to the account.
 */
export async function beginMfaEnrolmentAction(_prev: MfaEnrolState, formData: FormData): Promise<MfaEnrolState> {
  const me = await requireStaff();
  const current = String(formData.get('currentPassword') ?? '');
  if (!current) return { ok: false, message: 'Enter your current password.' };
  const fresh = await getAuthStore().getStaff(me.username);
  if (!fresh) redirect('/login');
  const ip = clientIpFrom(await headers());
  const guard = getStaffLoginGuard();
  const reservation = await guard.reserve(me.username, ip, { seedExempt: isSeedAdminRecord(fresh) });
  if (!reservation.allowed) {
    if (reservation.justTripped) {
      await getStaffAuthAudit().record({
        action: 'auth.login.throttled',
        actorType: 'staff',
        actor: me.username,
        subjectId: me.username,
        partnerId: fresh.partnerId,
        ip,
        meta: { bucket: reservation.justTripped, context: 'mfa.enroll' },
      });
    }
    return { ok: false, message: 'Too many attempts. Try again later.' };
  }
  if (!(await verifyPassword(current, fresh.passwordHash))) {
    await getStaffAuthAudit().record({
      action: 'auth.login.failed',
      actorType: 'staff',
      actor: me.username,
      subjectId: me.username,
      partnerId: fresh.partnerId,
      ip,
      meta: { reason: 'invalid', context: 'mfa.enroll' },
    });
    return { ok: false, message: 'Your current password is incorrect.' };
  }
  await guard.refund(reservation.keys);
  await guard.clear(me.username, ip);
  try {
    const begun = await getStaffMfaStore().beginEnrolment(me.username);
    if (!begun.ok) {
      return { ok: false, message: 'Two-step verification is already on. Ask a platform admin to reset it first.' };
    }
    return { ok: true, secret: begun.secretBase32, uri: begun.uri };
  } catch (err) {
    logWarn('staff.mfa', 'enrolment could not start', { error: err instanceof Error ? err.name : 'unknown' });
    return { ok: false, message: UNAVAILABLE };
  }
}

export async function confirmMfaEnrolmentAction(_prev: MfaEnrolState, formData: FormData): Promise<MfaEnrolState> {
  const me = await requireStaff();
  const code = String(formData.get('code') ?? '').replace(/\s+/g, '');
  let outcome;
  try {
    outcome = await getStaffMfaStore().confirmEnrolment(me.username, code);
  } catch (err) {
    logWarn('staff.mfa', 'enrolment could not be confirmed', { error: err instanceof Error ? err.name : 'unknown' });
    return { ok: false, message: UNAVAILABLE };
  }
  switch (outcome) {
    case 'ok':
      await getStaffAuthAudit().record({
        action: 'auth.mfa.enroll',
        actorType: 'staff',
        actor: me.username,
        subjectId: me.username,
        partnerId: me.partnerId,
        ip: clientIpFrom(await headers()),
      });
      revalidatePath('/admin-dashboard/account');
      return { ok: true, message: 'Two-step verification is on. You will be asked for a code at every sign-in.' };
    case 'invalid':
      return { ok: false, message: 'That code is not valid. Check the time on your device and try again.' };
    case 'throttled':
      return { ok: false, message: 'Too many codes. Start the setup again.' };
    case 'enrolled':
      return { ok: false, message: 'Two-step verification is already on.' };
    default:
      return { ok: false, message: 'The setup expired. Start again.' };
  }
}
