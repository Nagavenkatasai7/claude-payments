'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { ensureSeedAdmin } from '@/lib/seed';
import { hashPassword, needsRehash, verifyPasswordOrDummy } from '@/lib/password';
import { clearStaffSessionCookies, staffSessionTokens } from '@/lib/session-cookie';
import { clientIpFrom, isIpRateLimited } from '@/lib/ip-rate-limit';
import { getStaffLoginGuard, isSeedAdminRecord } from '@/lib/staff-login-guard';
import { getStaffAuthAudit } from '@/lib/staff-auth-audit';
import { getStaffMfaStore } from '@/lib/staff-mfa-store';
import { setMfaPendingCookie } from '@/lib/staff-mfa-cookie';
import { completeStaffSignIn, staffSignInBlocked } from '@/lib/staff-sign-in';

// Program-Fix 17a: ONE refusal string for every throttle (known and unknown
// usernames alike, outer ring or reservation), so it says nothing about
// whether the username exists. ('use server' files export only async
// functions, so these stay module-private.)
const THROTTLED = 'Too many attempts. Try again later.';
const INVALID = 'Invalid username or password.';
const UNAVAILABLE = 'Account unavailable. Contact SmartRemit support.';
/** Outer per-IP ring (ip-rate-limit, 60 s window). Counts every POST, never refunded. */
const LOGIN_RING_SCOPE = 'staff-login';
const LOGIN_RING_LIMIT = 20;

export async function login(
  _prev: string | null,
  formData: FormData,
): Promise<string | null> {
  await ensureSeedAdmin();
  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const hdrs = await headers();
  const ip = clientIpFrom(hdrs);
  const staff = await getAuthStore().getStaff(username);
  const audit = getStaffAuthAudit();
  // The seed admin can never be locked out by anything this login ships: it
  // skips the outer ring and is reserved against the per-(username, IP) bucket
  // only (staff-login-guard). Only for a platform-admin record under the
  // configured seed name; a same-named partner or non-admin account gets nothing.
  const seedExempt = isSeedAdminRecord(staff);

  // Outer ring first (cheap, fail-open, never audited: that bounds the audit flood).
  if (!seedExempt && (await isIpRateLimited(hdrs, LOGIN_RING_SCOPE, LOGIN_RING_LIMIT))) {
    return THROTTLED;
  }

  // Reserve BEFORE the Argon2 verify (fix 19's reserve-before-compare).
  const guard = getStaffLoginGuard();
  const reservation = await guard.reserve(username, ip, { seedExempt });
  if (!reservation.allowed) {
    // One throttled row per bucket per window (the attempt that crossed the cap).
    if (reservation.justTripped) {
      await audit.record({
        action: 'auth.login.throttled',
        actorType: 'system',
        actor: 'login',
        ...(staff ? { subjectId: staff.username, partnerId: staff.partnerId } : {}),
        ip,
        meta: { bucket: reservation.justTripped },
      });
    }
    return THROTTLED;
  }

  // Fix 21 (F62): ONE Argon2id verify on every attempt — an unknown username
  // pays the same work against a per-instance dummy hash, so response time
  // does not say whether the username exists. One generic message either way.
  const ok = await verifyPasswordOrDummy(password, staff?.passwordHash);
  if (!staff || !ok) {
    // The typed username is never persisted for an unknown account (people
    // paste passwords into that field): subjectId only when the record exists.
    await audit.record({
      action: 'auth.login.failed',
      actorType: 'system',
      actor: 'login',
      ...(staff ? { subjectId: staff.username, partnerId: staff.partnerId } : {}),
      ip,
      meta: { reason: 'invalid' },
    });
    return INVALID;
  }
  // Team: a suspended staff member cannot log in; P3: nor one whose partner is
  // suspended or missing. Generic message so credential validity isn't leaked.
  const blocked = await staffSignInBlocked(staff);
  if (blocked) {
    await audit.record({
      action: 'auth.login.failed',
      actorType: 'system',
      actor: 'login',
      subjectId: staff.username,
      partnerId: staff.partnerId,
      ip,
      meta: { reason: blocked },
    });
    return UNAVAILABLE;
  }
  // Program-Fix 17b: an enrolled account owes a TOTP code before any session.
  const enrolled = await getStaffMfaStore().isEnrolled(staff.username);
  // Proven password: give this attempt's reservation back, so successes never
  // consume the budget. The username's counters are CLEARED only when no code
  // is owed; otherwise re-entering the password would wipe the failed-code
  // count (the code step reserves on the same buckets and clears on success).
  await guard.refund(reservation.keys);
  if (!enrolled) await guard.clear(username, ip);
  // Fix 21: lazy upgrade of a legacy scrypt hash to Argon2id, only after every
  // refusal gate above. Program-Fix 17a: a compare-and-set against the hash this
  // login just verified, so a reset landing in between is never reverted.
  // The hash now stored (the pending code step is bound to it, 17b).
  let storedHash = staff.passwordHash;
  if (needsRehash(staff.passwordHash)) {
    const upgraded = await hashPassword(password);
    if (await getAuthStore().updatePasswordHash(username, staff.passwordHash, upgraded)) storedHash = upgraded;
  }
  if (enrolled) {
    const pending = await getStaffMfaStore().createPending(staff.username, storedHash);
    setMfaPendingCookie(await cookies(), pending);
    redirect('/login/mfa');
  }
  // Records the login, replaces the browser's session (Program-Fix 45 P1:
  // __Host- cookie, idle/absolute windows) and audits auth.login.
  // Best-effort audit; the redirect below stays outside any try/catch.
  await completeStaffSignIn(staff, ip);
  redirect('/admin-dashboard');
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  // Program-Fix 45 P1: revoke the session behind EITHER cookie (the __Host-
  // one and a legacy one may both be present), then expire both cookies with
  // Path=/ and Secure, which a browser needs to drop a __Host- cookie.
  const store = getAuthStore();
  let username: string | null = null;
  for (const { token } of staffSessionTokens(jar)) {
    username ??= await store.getSessionUser(token);
    await store.deleteSession(token);
  }
  if (username) {
    const staff = await store.getStaff(username);
    await getStaffAuthAudit().record({
      action: 'auth.logout',
      actorType: 'staff',
      actor: username,
      subjectId: username,
      partnerId: staff?.partnerId,
      ip: clientIpFrom(await headers()),
    });
  }
  clearStaffSessionCookies(jar);
  redirect('/login');
}
