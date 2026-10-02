import { createHash } from 'node:crypto';
import type { RedisLike } from './store';
import type { StaffAuthEvent } from './staff-auth-audit';
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
 * must enrol is staff-mfa-policy.ts, which this file never reads or changes.
 *
 * Throttle: every attempt reserves on the step-up's OWN buckets before any verify,
 *   staff_su:s:<sha256(token)>:<UTC hour>     5 per session per hour
 *   staff_su:u:<sha256(username)>:<UTC day>  10 per user per day, all sessions
 * and a success gives both back. It never touches the /login buckets (staff-login-guard.ts), so a
 * sign-in budget spent against a username cannot block a signed-in member's step-up, and step-up
 * failures never lock the member out of /login. Only a holder of a live session of the user can
 * spend these buckets. No IP bucket: the caller is already authenticated. The seed admin gets no
 * exemption here, and none is needed: it is a PLATFORM record (isSeedAdminRecord), and /partner
 * admits partner-scoped staff only (partner-access.ts), so it never reaches a step-up.
 *
 * Audit rows (auth.stepup / auth.stepup.failed) carry the factor, the target action and
 * the server-derived actorScope: never the code or the password. Redis errors PROPAGATE: the caller
 * refuses (fail closed).
 */

export const STAFF_STEP_UP_WINDOW_MS = 15 * 60 * 1000;
/** A TOTP code is 6 digits; a staff password is at most 128 chars (staff-password.ts STAFF_PASSWORD_MAX). */
const MAX_SECRET_LENGTH = 256;
const TOTP_RE = /^\d{6}$/;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

export const STEP_UP_SESSION_HOURLY_CAP = 5;
export const STEP_UP_USER_DAILY_CAP = 10;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The step-up's own throttle buckets (hashed: no raw username or token in a key). */
export const staffStepUpLimitKeys = (username: string, token: string, nowMs: number) => ({
  session: `staff_su:s:${sha256hex(token)}:${Math.floor(nowMs / HOUR_MS)}`,
  user: `staff_su:u:${sha256hex(username)}:${Math.floor(nowMs / DAY_MS)}`,
});

export const staffStepUpKey = (token: string) => `staff_stepup:${sha256hex(token)}`;

/** The action a step-up unlocks (audit meta only). */
export type StepUpTarget = 'api_key.issue' | 'api_key.rotate' | 'webhook.endpoint.save' | 'webhook.secret.rotate' | 'webhook.replay' | 'disclosure.save';

export interface StaffStepUpDeps {
  redis: RedisLike;
  now?: () => number;
  mfa: { isEnrolled(username: string): Promise<boolean>; verifyCode(username: string, code: string): Promise<boolean> };
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

  /** Reserve one attempt: the session bucket first, so a refused one never spends the user's day. */
  async function reserve(username: string, token: string): Promise<{ allowed: boolean; keys: string[]; justTripped: boolean }> {
    const k = staffStepUpLimitKeys(username, token, now());
    const plan = [
      { key: k.session, cap: STEP_UP_SESSION_HOURLY_CAP, ttl: 2 * 60 * 60 },
      { key: k.user, cap: STEP_UP_USER_DAILY_CAP, ttl: 2 * 24 * 60 * 60 },
    ];
    const keys: string[] = [];
    for (const step of plan) {
      const n = await deps.redis.incr(step.key);
      if (n === 1) await deps.redis.expire(step.key, step.ttl);
      keys.push(step.key);
      if (n > step.cap) return { allowed: false, keys, justTripped: n === step.cap + 1 };
    }
    return { allowed: true, keys, justTripped: false };
  }

  /** Give a successful attempt back (best-effort; an expired bucket is skipped, never recreated). */
  async function giveBack(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!(await deps.redis.exists(key))) continue;
      if ((await deps.redis.decr(key)) <= 0) await deps.redis.del(key);
    }
  }

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
      const reservation = await reserve(a.staff.username, a.token);
      if (!reservation.allowed) {
        if (reservation.justTripped) await deps.audit.record({ ...base, action: 'auth.stepup.failed', meta: { ...meta, reason: 'throttled' } });
        return { outcome: 'throttled', factor };
      }
      if (!(await check(factor, a))) {
        await deps.audit.record({ ...base, action: 'auth.stepup.failed', meta });
        return { outcome: 'invalid', factor };
      }
      // Refund and audit BEFORE the marker: a success is never left fresh-but-unaudited. The refund is
      // best-effort (a missed refund only costs this user one attempt); the audit never throws.
      try {
        await giveBack(reservation.keys);
      } catch {
        /* the reservation expires with its bucket */
      }
      await deps.audit.record({ ...base, action: 'auth.stepup', meta });
      await self.mark(a.token, a.staff.username);
      return { outcome: 'ok', factor };
    },
  };
  return self;
}

export type StaffStepUp = ReturnType<typeof createStaffStepUp>;
