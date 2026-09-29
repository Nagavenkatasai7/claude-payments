import { createHash } from 'node:crypto';
import type { RedisLike } from './store';
import type { StaffAuthEvent } from './staff-auth-audit';
import type { StaffReservation } from './staff-login-guard';
import type { StepUpFactor } from './staff-step-up-result';
import type { Staff } from './types';

/**
 * staff-step-up — the partner-staff 15-minute re-authentication (M3-14 follow-up), the staff
 * counterpart of the customer portal's step-up (portal-auth.ts isPortalSessionFresh, #403).
 *
 *   staff_stepup:<sha256(session token)>   `<username>:<proofAtMs>`   EX 900
 *
 * One marker per staff SESSION: another session of the same user, or another user, is never fresh.
 * Freshness is checked twice (the TTL AND the stamped time), so a key that outlived its TTL still
 * reads stale. The factor is the strongest one the account HAS: a TOTP code when the account is
 * enrolled (staff-mfa-store isEnrolled, present means enrolled), else the current password. WHO
 * must enrol is staff-mfa-policy.ts, which this file never reads or changes. Every attempt reserves
 * on the staff login guard first (a step-up guess is never cheaper than a /login guess); a success
 * refunds it. Audit rows (auth.stepup / auth.stepup.failed) carry the factor, the target action and
 * the server-derived actorScope: never the code or the password. Redis errors PROPAGATE: the caller
 * refuses (fail closed).
 */

export const STAFF_STEP_UP_WINDOW_MS = 15 * 60 * 1000;
/** A TOTP code is 6 digits; a staff password is at most 128 chars (staff-password.ts STAFF_PASSWORD_MAX). */
const MAX_SECRET_LENGTH = 256;
const TOTP_RE = /^\d{6}$/;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export const staffStepUpKey = (token: string) => `staff_stepup:${sha256hex(token)}`;

/** The action a step-up unlocks (audit meta only). */
export type StepUpTarget = 'api_key.issue' | 'api_key.rotate' | 'webhook.endpoint.save' | 'webhook.secret.rotate' | 'webhook.replay';

export interface StaffStepUpDeps {
  redis: RedisLike;
  now?: () => number;
  mfa: { isEnrolled(username: string): Promise<boolean>; verifyCode(username: string, code: string): Promise<boolean> };
  guard: { reserve(username: string, ip: string): Promise<StaffReservation>; refund(keys: string[]): Promise<void> };
  verifyPassword(plain: string, stored: string): Promise<boolean>;
  getStaff(username: string): Promise<Staff | null>;
  audit: { record(ev: StaffAuthEvent): Promise<void> };
}

export interface StepUpAttempt {
  token: string;
  staff: Staff;
  /** The submitted TOTP code or password. Never logged, never audited. */
  secret: string;
  ip: string;
  target: StepUpTarget;
  actorScope: 'platform' | 'partner';
}

export type StepUpOutcome = { outcome: 'ok' | 'invalid' | 'throttled'; factor: StepUpFactor };

export function createStaffStepUp(deps: StaffStepUpDeps) {
  const now = deps.now ?? (() => Date.now());
  const windowS = STAFF_STEP_UP_WINDOW_MS / 1000;

  async function check(factor: StepUpFactor, a: StepUpAttempt): Promise<boolean> {
    if (a.secret.length > MAX_SECRET_LENGTH) return false;
    if (factor === 'totp') {
      // A pasted code may carry spaces ("123 456"); nothing else is normalised (login/mfa/actions.ts).
      const code = a.secret.replace(/\s+/g, '');
      return TOTP_RE.test(code) && deps.mfa.verifyCode(a.staff.username, code);
    }
    // The FRESH record's hash: a password changed since the session began is the one that counts.
    const fresh = await deps.getStaff(a.staff.username);
    if (!fresh || !a.secret) return false;
    return deps.verifyPassword(a.secret, fresh.passwordHash);
  }

  const self = {
    async isFresh(token: string, username: string): Promise<boolean> {
      if (!token) return false;
      const raw = await deps.redis.get(staffStepUpKey(token));
      if (!raw) return false;
      const i = raw.lastIndexOf(':');
      if (i <= 0 || raw.slice(0, i) !== username) return false;
      const at = raw.slice(i + 1);
      if (!/^\d+$/.test(at)) return false;
      const t = now();
      const atMs = Number(at);
      return atMs <= t && t - atMs <= STAFF_STEP_UP_WINDOW_MS;
    },

    async mark(token: string, username: string): Promise<void> {
      await deps.redis.set(staffStepUpKey(token), `${username}:${now()}`, { ex: windowS });
    },

    /** TOTP when enrolled, else the password. An unknown enrolment demands TOTP (fail closed). */
    async factorFor(username: string): Promise<StepUpFactor> {
      try {
        return (await deps.mfa.isEnrolled(username)) ? 'totp' : 'password';
      } catch {
        return 'totp';
      }
    },

    async verify(a: StepUpAttempt): Promise<StepUpOutcome> {
      const factor = await self.factorFor(a.staff.username);
      const base = { actorType: 'staff' as const, actor: a.staff.username, subjectId: a.staff.username, partnerId: a.staff.partnerId, ip: a.ip };
      const meta = { factor, target: a.target, actorScope: a.actorScope };
      const reservation = await deps.guard.reserve(a.staff.username, a.ip);
      if (!reservation.allowed) {
        if (reservation.justTripped) await deps.audit.record({ ...base, action: 'auth.stepup.failed', meta: { ...meta, reason: 'throttled' } });
        return { outcome: 'throttled', factor };
      }
      if (!(await check(factor, a))) {
        await deps.audit.record({ ...base, action: 'auth.stepup.failed', meta });
        return { outcome: 'invalid', factor };
      }
      await self.mark(a.token, a.staff.username);
      await deps.guard.refund(reservation.keys);
      await deps.audit.record({ ...base, action: 'auth.stepup', meta });
      return { outcome: 'ok', factor };
    },
  };
  return self;
}

export type StaffStepUp = ReturnType<typeof createStaffStepUp>;
