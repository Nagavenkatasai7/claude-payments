'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getAuthStore } from '@/lib/auth-store';
import { getPartnerStore } from '@/lib/partner-store';
import { ensureSeedAdmin } from '@/lib/seed';
import { hashPassword, needsRehash, verifyPasswordOrDummy } from '@/lib/password';
import { clearStaffSessionCookies, setStaffSessionCookie, staffSessionTokens } from '@/lib/session-cookie';
import { clientIpFrom, isIpRateLimited } from '@/lib/ip-rate-limit';
import { getStaffLoginGuard, isSeedAdminRecord } from '@/lib/staff-login-guard';
import { getStaffAuthAudit } from '@/lib/staff-auth-audit';

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
  // Team: a suspended staff member cannot log in. Generic message (no leak).
  if (staff.status === 'suspended') {
    await audit.record({
      action: 'auth.login.failed',
      actorType: 'system',
      actor: 'login',
      subjectId: staff.username,
      partnerId: staff.partnerId,
      ip,
      meta: { reason: 'suspended' },
    });
    return UNAVAILABLE;
  }
  // P3: block login if the staff's partner is suspended or missing.
  // Generic error so credential validity isn't leaked.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') {
      await audit.record({
        action: 'auth.login.failed',
        actorType: 'system',
        actor: 'login',
        subjectId: staff.username,
        partnerId: staff.partnerId,
        ip,
        meta: { reason: 'partner_inactive' },
      });
      return UNAVAILABLE;
    }
  }
  // Proven login: give this attempt's reservation back, then clear the
  // username's counters, so successes never consume the budget.
  await guard.refund(reservation.keys);
  await guard.clear(username, ip);
  // Fix 21: lazy upgrade of a legacy scrypt hash to Argon2id, only after every
  // refusal gate above. Program-Fix 17a: a compare-and-set against the hash this
  // login just verified, so a reset landing in between is never reverted.
  if (needsRehash(staff.passwordHash)) {
    await getAuthStore().updatePasswordHash(username, staff.passwordHash, await hashPassword(password));
  }
  // Record an "active" signal for the Team page (re-reads fresh; won't clobber a
  // concurrent suspend/edit — see auth-store.recordLogin).
  await getAuthStore().recordLogin(username);
  const token = await getAuthStore().createSession(username);
  // Program-Fix 45 P1: the __Host- cookie (12 h, matching the session's
  // absolute window); the legacy cookie is expired in the same response.
  setStaffSessionCookie(await cookies(), token);
  // Best-effort and time-bounded (staff-auth-audit never throws); the
  // redirect below stays outside any try/catch.
  await audit.record({
    action: 'auth.login',
    actorType: 'staff',
    actor: staff.username,
    subjectId: staff.username,
    partnerId: staff.partnerId,
    ip,
  });
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
