import { createHash, randomBytes } from 'node:crypto';
import { getRedis } from './redis';
import { ctx } from './crypto-context';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from './field-crypto';
import { base32Decode, base32Encode, generateTotpSecret, totpOtpauthUri, verifyTotp, TOTP_STEP_SECONDS } from './totp';
import type { RedisLike } from './store';

/**
 * staff-mfa-store — Program-Fix 17b. Opt-in TOTP for staff, in Redis keys of
 * its own (never a field on `Staff`), so the team actions' whole-object
 * `saveStaff({...target})` writes — and the previous build's — can never undo
 * an enrolment:
 *
 *   staff_mfa:<username>              {secretEnc, enrolledAt}  (no TTL)
 *   staff_mfa_enroll:<username>       sealed secret awaiting its first code (10 min)
 *   staff_mfa_enroll_n:<username>     confirm attempts for that enrolment (10 min)
 *   staff_totp_last:<username>        last accepted step (replay guard, 1 day)
 *   staff_totp_used:<username>:<step> atomic per-step NX marker (replay guard, 2 min)
 *   staff_mfa_pending:<sha(token)>    `<passwordTag>:<username>` of a password-proven sign-in (5 min)
 *   staff_mfa_pending_n:<sha(token)>  codes tried against that token (5 min)
 *
 * The secret (base32) is sealed with field-crypto's encryptField under
 * ctx.staffMfa(username): v1 today, v2 (context-bound) once fix 46B flips
 * writes, and permanently v1-exempt for 46B's reject flag. A successful
 * verify re-seals it when a fresh seal would be a different version (a no-op
 * before 46B, once per user after it). The pending token is stored only as
 * sha256(token); the plaintext lives only in the browser's httpOnly cookie.
 */

export const STAFF_MFA_ISSUER = 'SmartRemit';
export const STAFF_MFA_ENROLL_TTL_S = 10 * 60;
export const STAFF_MFA_ENROLL_MAX_CODES = 5;
export const STAFF_MFA_PENDING_TTL_S = 5 * 60;
export const STAFF_MFA_PENDING_MAX_CODES = 5;
const LAST_STEP_TTL_S = 24 * 60 * 60;
/** Covers the ±1 window (a code is acceptable for at most 90 s) with margin. */
const USED_STEP_TTL_S = 4 * TOTP_STEP_SECONDS;

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** Key builders — shared with scripts/staff-break-glass.ts so the two can never drift. */
export const staffMfaKeys = {
  secret: (username: string) => `staff_mfa:${username}`,
  enroll: (username: string) => `staff_mfa_enroll:${username}`,
  enrollCount: (username: string) => `staff_mfa_enroll_n:${username}`,
  last: (username: string) => `staff_totp_last:${username}`,
  used: (username: string, step: number) => `staff_totp_used:${username}:${step}`,
  pending: (token: string) => `staff_mfa_pending:${sha256hex(token)}`,
  pendingCount: (token: string) => `staff_mfa_pending_n:${sha256hex(token)}`,
  /** Everything a reset / break-glass clears for one username (the NX step markers expire in 2 min). */
  perUser: (username: string) => [
    staffMfaKeys.secret(username),
    staffMfaKeys.enroll(username),
    staffMfaKeys.enrollCount(username),
    staffMfaKeys.last(username),
  ],
};

interface StoredSecret {
  secretEnc: string;
  enrolledAt: string;
}

export type BeginEnrolmentResult = { ok: true; secretBase32: string; uri: string } | { ok: false; reason: 'enrolled' };
export type ConfirmEnrolmentResult = 'ok' | 'invalid' | 'expired' | 'throttled' | 'enrolled';

export interface StaffMfaStoreOptions {
  now?: () => number;
  provider?: () => EncryptionKeyProvider;
}

const versionOf = (blob: string) => blob.slice(0, blob.indexOf('.'));

const PASSWORD_TAG_HEX = 32;

export interface PendingSignIn {
  username: string;
  passwordTag: string;
}

function parsePending(raw: string | null): PendingSignIn | null {
  if (!raw || raw.length < PASSWORD_TAG_HEX + 2 || raw[PASSWORD_TAG_HEX] !== ':') return null;
  const passwordTag = raw.slice(0, PASSWORD_TAG_HEX);
  if (!/^[0-9a-f]+$/.test(passwordTag)) return null;
  return { passwordTag, username: raw.slice(PASSWORD_TAG_HEX + 1) };
}

function parseStored(raw: string | null): StoredSecret | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSecret>;
    return typeof v?.secretEnc === 'string' && v.secretEnc ? { secretEnc: v.secretEnc, enrolledAt: String(v.enrolledAt ?? '') } : null;
  } catch {
    return null;
  }
}

export function createStaffMfaStore(redis: RedisLike, opts: StaffMfaStoreOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const provider = opts.provider ?? defaultProvider;
  const seal = (username: string, b32: string) => encryptField(b32, provider(), ctx.staffMfa(username));
  const open = (username: string, blob: string) => base32Decode(decryptField(blob, provider(), ctx.staffMfa(username)));

  /**
   * Check `code` against `secret`, then claim its step atomically: the step
   * must be above the last accepted one AND its NX marker must be new. Either
   * failing is a replay.
   */
  async function acceptCode(username: string, secret: Buffer, code: string): Promise<boolean> {
    const lastRaw = await redis.get(staffMfaKeys.last(username));
    const lastStep = lastRaw !== null && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
    const step = verifyTotp(secret, code, now(), { lastStep });
    if (step === null) return false;
    const claimed = await redis.set(staffMfaKeys.used(username, step), '1', { nx: true, ex: USED_STEP_TTL_S });
    if (claimed === null) return false;
    await redis.set(staffMfaKeys.last(username), String(step), { ex: LAST_STEP_TTL_S });
    return true;
  }

  return {
    /**
     * PRESENT means enrolled, even when the record cannot be read: a corrupt
     * record fails CLOSED (the code step then refuses every code) instead of
     * silently turning the second factor off. Only a reset clears it.
     */
    async isEnrolled(username: string): Promise<boolean> {
      return (await redis.get(staffMfaKeys.secret(username))) !== null;
    },

    async enrolledAmong(usernames: string[]): Promise<Set<string>> {
      const flags = await Promise.all(usernames.map((u) => this.isEnrolled(u)));
      return new Set(usernames.filter((_, i) => flags[i]));
    },

    /**
     * Generate a fresh secret and hold it (sealed) for 10 minutes until the
     * first code confirms it. The plaintext is returned to the caller ONCE
     * (the action state), never persisted unsealed. Refused while enrolled.
     */
    async beginEnrolment(username: string): Promise<BeginEnrolmentResult> {
      if (await this.isEnrolled(username)) return { ok: false, reason: 'enrolled' };
      const secretBase32 = base32Encode(generateTotpSecret());
      await redis.set(staffMfaKeys.enroll(username), seal(username, secretBase32), { ex: STAFF_MFA_ENROLL_TTL_S });
      await redis.del(staffMfaKeys.enrollCount(username));
      return {
        ok: true,
        secretBase32,
        uri: totpOtpauthUri({ issuer: STAFF_MFA_ISSUER, account: username, secretBase32 }),
      };
    },

    /** Confirm the pending enrolment with one code (at most 5 tries per enrolment). */
    async confirmEnrolment(username: string, code: string): Promise<ConfirmEnrolmentResult> {
      if (await this.isEnrolled(username)) return 'enrolled';
      const sealed = await redis.get(staffMfaKeys.enroll(username));
      if (!sealed) return 'expired';
      const n = await redis.incr(staffMfaKeys.enrollCount(username));
      if (n === 1) await redis.expire(staffMfaKeys.enrollCount(username), STAFF_MFA_ENROLL_TTL_S);
      if (n > STAFF_MFA_ENROLL_MAX_CODES) {
        await redis.del(staffMfaKeys.enroll(username));
        await redis.del(staffMfaKeys.enrollCount(username));
        return 'throttled';
      }
      const secret = open(username, sealed);
      if (!(await acceptCode(username, secret, code))) return 'invalid';
      // Take the pending secret atomically: a reset (or a restarted setup)
      // that landed since the read above wins, and nothing is written.
      if ((await redis.getdel(staffMfaKeys.enroll(username))) !== sealed) return 'expired';
      await redis.del(staffMfaKeys.enrollCount(username));
      const stored: StoredSecret = { secretEnc: sealed, enrolledAt: new Date(now()).toISOString() };
      await redis.set(staffMfaKeys.secret(username), JSON.stringify(stored));
      return 'ok';
    },

    /** True only for a valid, not-yet-used code of an enrolled user. */
    async verifyCode(username: string, code: string): Promise<boolean> {
      const raw = await redis.get(staffMfaKeys.secret(username));
      const stored = parseStored(raw);
      if (!stored) return false;
      const b32 = decryptField(stored.secretEnc, provider(), ctx.staffMfa(username));
      if (!(await acceptCode(username, base32Decode(b32), code))) return false;
      // Re-seal only when a fresh seal is a different version (v1 → v2 after
      // 46B). Re-read first so a reset landing meanwhile is not undone; the
      // GET → SET gap left is milliseconds (RedisLike has no conditional SET XX).
      const fresh = seal(username, b32);
      if (versionOf(fresh) !== versionOf(stored.secretEnc)) {
        const again = await redis.get(staffMfaKeys.secret(username));
        if (again !== null && again === raw) {
          await redis.set(staffMfaKeys.secret(username), JSON.stringify({ ...stored, secretEnc: fresh }));
        }
      }
      return true;
    },

    /** Turn MFA off for a username (admin reset, removal, break-glass). */
    async reset(username: string): Promise<void> {
      for (const k of staffMfaKeys.perUser(username)) await redis.del(k);
    },

    /** A short, non-reversible tag of the password hash a pending sign-in proved. */
    passwordTag(passwordHash: string): string {
      return sha256hex(`staff-mfa-pending|${passwordHash}`).slice(0, PASSWORD_TAG_HEX);
    },

    /**
     * Mint the second-step token for a password-proven sign-in. The record
     * holds `<passwordTag>:<username>`, so a password change or reset inside
     * the 5-minute window voids it (the code step compares the tag with the
     * FRESH record's hash).
     */
    async createPending(username: string, passwordHash: string): Promise<string> {
      const token = randomBytes(32).toString('hex');
      const value = `${this.passwordTag(passwordHash)}:${username}`;
      await redis.set(staffMfaKeys.pending(token), value, { ex: STAFF_MFA_PENDING_TTL_S });
      return token;
    },

    async pendingUser(token: string): Promise<PendingSignIn | null> {
      if (!token) return null;
      return parsePending(await redis.get(staffMfaKeys.pending(token)));
    },

    /** Count one code against the token; false (and the token dropped) past the cap. */
    async countPendingAttempt(token: string): Promise<boolean> {
      const k = staffMfaKeys.pendingCount(token);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, STAFF_MFA_PENDING_TTL_S);
      if (n > STAFF_MFA_PENDING_MAX_CODES) {
        await this.dropPending(token);
        return false;
      }
      return true;
    },

    /** Single-use: the pending sign-in, or null when already consumed or expired. */
    async consumePending(token: string): Promise<PendingSignIn | null> {
      const raw = await redis.getdel(staffMfaKeys.pending(token));
      await redis.del(staffMfaKeys.pendingCount(token));
      return parsePending(raw);
    },

    async dropPending(token: string): Promise<void> {
      await redis.del(staffMfaKeys.pending(token));
      await redis.del(staffMfaKeys.pendingCount(token));
    },
  };
}

export type StaffMfaStore = ReturnType<typeof createStaffMfaStore>;

let cached: StaffMfaStore | null = null;

export function getStaffMfaStore(): StaffMfaStore {
  if (!cached) cached = createStaffMfaStore(getRedis());
  return cached;
}
