import { cookies, headers } from 'next/headers';
import { getAuthStore } from './auth-store';
import { hashPassword, verifyPassword } from './password';
import { clientIpFrom } from './ip-rate-limit';
import { setStaffSessionCookie } from './session-cookie';
import { getStaffLoginGuard, isSeedAdminRecord } from './staff-login-guard';
import { getStaffAuthAudit } from './staff-auth-audit';
import { assertStaffPasswordPolicy, StaffPasswordPolicyError } from './staff-password';
import type { Staff } from './types';

/**
 * staff-password-change (lost-features A14): the ONE "change your own password" core, behind the
 * legacy /admin-dashboard/account action and /partner/security. Moved verbatim out of
 * changeOwnPasswordAction (Program-Fix 17a); each surface maps the closed code to its own copy.
 *
 * It reserves an attempt on the SAME buckets as the login (same seed-admin predicate), verifies the
 * current password, applies the policy (breach check fail-OPEN: an HIBP outage must never stop
 * someone rotating a leaked password), compare-and-sets the hash, revokes EVERY session and mints a
 * fresh one for this browser. The caller passes the SESSION's staff record (never request input).
 */
export type PasswordChangeCode = 'missing' | 'mismatch' | 'gone' | 'throttled' | 'wrong_current' | 'same' | 'policy' | 'concurrent';
export type PasswordChangeResult = { ok: true } | { ok: false; code: PasswordChangeCode; policyMessage?: string };

export interface PasswordChangeInput {
  current: string;
  next: string;
  confirm: string;
}

export async function changeOwnPassword(me: Staff, input: PasswordChangeInput): Promise<PasswordChangeResult> {
  const { current, next, confirm } = input;
  if (!current || !next) return { ok: false, code: 'missing' };
  if (next !== confirm) return { ok: false, code: 'mismatch' };

  const store = getAuthStore();
  const fresh = await store.getStaff(me.username);
  if (!fresh) return { ok: false, code: 'gone' };
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
    return { ok: false, code: 'throttled' };
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
    return { ok: false, code: 'wrong_current' };
  }
  // The current password is proven: this attempt never counts against the budget.
  await guard.refund(reservation.keys);
  await guard.clear(me.username, ip);
  if (next === current) return { ok: false, code: 'same' };
  try {
    await assertStaffPasswordPolicy(next, { failClosed: false });
  } catch (err) {
    if (err instanceof StaffPasswordPolicyError) return { ok: false, code: 'policy', policyMessage: err.message };
    throw err;
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
    return { ok: false, code: 'concurrent' };
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
  return { ok: true };
}
