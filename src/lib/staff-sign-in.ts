import { cookies } from 'next/headers';
import { getAuthStore } from './auth-store';
import { getPartnerStore } from './partner-store';
import { setStaffSessionCookie, staffSessionTokens } from './session-cookie';
import { getStaffAuthAudit } from './staff-auth-audit';
import type { Staff } from './types';

/**
 * staff-sign-in — Program-Fix 17b. The ONE place a staff session is minted
 * after proof (password, or password + TOTP code), shared by login() and the
 * /login/mfa action so the Program-Fix 45 P1 session behaviour cannot drift
 * between them: the prior sessions behind the presented cookies are revoked,
 * a fresh session is created through auth-store (30 min idle / 12 h absolute
 * windows) and written with setStaffSessionCookie (the __Host- cookie).
 * Not a 'use server' module: callers keep redirect() outside any try/catch.
 */

/** Why an otherwise-proven account may not sign in, or null. Generic to the user. */
export async function staffSignInBlocked(staff: Staff): Promise<'suspended' | 'partner_inactive' | null> {
  // Team: a suspended staff member cannot log in.
  if (staff.status === 'suspended') return 'suspended';
  // P3: block login if the staff's partner is suspended or missing.
  if (staff.partnerId) {
    const partner = await getPartnerStore().getPartner(staff.partnerId);
    if (!partner || partner.status !== 'active') return 'partner_inactive';
  }
  return null;
}

export async function completeStaffSignIn(staff: Staff, ip: string, meta?: Record<string, unknown>): Promise<void> {
  const store = getAuthStore();
  // Record an "active" signal for the Team page (re-reads fresh; won't clobber a
  // concurrent suspend/edit — see auth-store.recordLogin).
  await store.recordLogin(staff.username);
  // Program-Fix 45 P1: this sign-in replaces the browser's session, so the
  // sessions behind the cookies it presented (either name) are revoked, not
  // left alive in Redis after their cookie is overwritten.
  const jar = await cookies();
  for (const { token: prior } of staffSessionTokens(jar)) await store.deleteSession(prior);
  const token = await store.createSession(staff.username);
  // The __Host- cookie (12 h, matching the session's absolute window); the
  // legacy cookie is expired in the same response.
  setStaffSessionCookie(jar, token);
  // Best-effort and time-bounded (staff-auth-audit never throws).
  await getStaffAuthAudit().record({
    action: 'auth.login',
    actorType: 'staff',
    actor: staff.username,
    subjectId: staff.username,
    partnerId: staff.partnerId,
    ip,
    ...(meta ? { meta } : {}),
  });
}
