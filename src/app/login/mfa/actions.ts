'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { clientIpFrom } from '@/lib/ip-rate-limit';
import { getStaffLoginGuard, isSeedAdminRecord } from '@/lib/staff-login-guard';
import { getStaffAuthAudit } from '@/lib/staff-auth-audit';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { clearMfaPendingCookie, readMfaPendingToken } from '@/lib/staff-mfa-cookie';
import { completeStaffSignIn, staffSignInBlocked } from '@/lib/staff-sign-in';

// Program-Fix 17b: the sign-in's second step (a public POST endpoint, like
// every server action). The ONLY input trusted for WHO is signing in is the
// pending token in the httpOnly cookie, set by login() after a proven
// password; the form carries just the code. Every code attempt reserves on
// the SAME login-guard buckets as the password step (ui / u / ip, seed admin
// ui only) and counts against the token (5 per token), so a code is never
// cheaper to guess than a password.
const THROTTLED = 'Too many attempts. Try again later.';
const INVALID_CODE = 'That code is not valid. Try again.';
const TOO_MANY_CODES = 'Too many codes. Sign in again.';
const UNAVAILABLE = 'Account unavailable. Contact SmartRemit support.';

export async function verifyMfa(_prev: string | null, formData: FormData): Promise<string | null> {
  const jar = await cookies();
  const token = readMfaPendingToken(jar);
  const mfa = getStaffMfaStore();
  const pending = token ? await mfa.pendingUser(token) : null;
  if (!pending) {
    clearMfaPendingCookie(jar);
    redirect('/login');
  }
  const staff = await getAuthStore().getStaff(pending.username);
  // Gone, or its password changed/reset since this token was minted: start over.
  if (!staff || mfa.passwordTag(staff.passwordHash) !== pending.passwordTag) {
    await mfa.dropPending(token);
    clearMfaPendingCookie(jar);
    redirect('/login');
  }
  const ip = clientIpFrom(await headers());
  const audit = getStaffAuthAudit();

  // Re-checked at the code step: a suspend (of the member or its partner)
  // inside the 5-minute window still refuses.
  const blocked = await staffSignInBlocked(staff);
  if (blocked) {
    await mfa.dropPending(token);
    clearMfaPendingCookie(jar);
    await audit.record({
      action: 'auth.login.failed',
      actorType: 'system',
      actor: 'login',
      subjectId: staff.username,
      partnerId: staff.partnerId,
      ip,
      meta: { reason: blocked, context: 'mfa' },
    });
    return UNAVAILABLE;
  }

  const guard = getStaffLoginGuard();
  const reservation = await guard.reserve(staff.username, ip, { seedExempt: isSeedAdminRecord(staff) });
  if (!reservation.allowed) {
    if (reservation.justTripped) {
      await audit.record({
        action: 'auth.login.throttled',
        actorType: 'system',
        actor: 'login',
        subjectId: staff.username,
        partnerId: staff.partnerId,
        ip,
        meta: { bucket: reservation.justTripped, context: 'mfa' },
      });
    }
    return THROTTLED;
  }
  if (!(await mfa.countPendingAttempt(token))) {
    clearMfaPendingCookie(jar);
    return TOO_MANY_CODES;
  }

  // A pasted code may carry spaces ("123 456"); nothing else is normalised.
  const code = String(formData.get('code') ?? '').replace(/\s+/g, '');
  if (!(await mfa.verifyCode(staff.username, code))) {
    await audit.record({
      action: 'auth.mfa.failed',
      actorType: 'system',
      actor: 'login',
      subjectId: staff.username,
      partnerId: staff.partnerId,
      ip,
    });
    return INVALID_CODE;
  }
  // Single use: of two concurrent successes on one token, only one mints.
  if ((await mfa.consumePending(token))?.username !== staff.username) {
    clearMfaPendingCookie(jar);
    redirect('/login');
  }
  clearMfaPendingCookie(jar);
  await guard.refund(reservation.keys);
  await guard.clear(staff.username, ip);
  await completeStaffSignIn(staff, ip, { mfa: true });
  redirect('/admin-dashboard');
}
