import { createHash } from 'node:crypto';
import { env } from './env';
import { getRedis } from './redis';
import type { RedisLike } from './store';
import type { Staff } from './types';

/**
 * staff-login-guard — Program-Fix 17a. Reserve-before-compare throttling for
 * the STAFF sign-in (and the change-own-password check), mirroring fix 19's
 * customer design (customer-auth-store.reserveLoginAttempt) without sharing
 * its keys or editing that file.
 *
 * Every password check RESERVES one attempt with an atomic INCR (TTL armed on
 * the bucket's first write) BEFORE the Argon2 verify, under three caps checked
 * in this order, so a refused reservation never advances a later counter:
 *
 *   ui  `staff_lf:ui:<sha(user)>:<sha(ip)>:<hour>`  10 per (username, IP) per hour
 *   u   `staff_lf:u:<sha(user)>:<day>`              30 per username per day, all IPs
 *   ip  `staff_lf:ip:<sha(ip)>:<hour>`              50 per IP per hour, all usernames
 *                                                   (skipped for an 'unknown' IP)
 *
 * The SEED ADMIN (see isSeedAdminRecord) is reserved against `ui` ONLY: no
 * all-IP username cap and no per-IP cap can ever lock it out, so a flood from
 * anywhere (including the owner's own IP, under other usernames) leaves the
 * owner a way in. Its remaining exposure is bounded by `ui` per IP.
 *
 * A successful login REFUNDS exactly the keys it bumped (DECR, skipped when
 * the key has already expired so no TTL-less key is ever created) and then
 * CLEARS the username's `ui` + `u` counters. Successes therefore never consume
 * the budget. No raw username or IP is stored: both are sha256'd in the key.
 */

export const STAFF_UI_CAP = 10;
export const STAFF_U_CAP = 30;
export const STAFF_IP_CAP = 50;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_BUCKET_TTL_S = 2 * 60 * 60;
const DAY_BUCKET_TTL_S = 2 * 24 * 60 * 60;

export type StaffBucket = 'ui' | 'u' | 'ip';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/** The key builders — shared with scripts/staff-break-glass.ts so the two can never drift. */
export const staffLoginKeys = {
  ui: (username: string, ip: string, nowMs: number) =>
    `staff_lf:ui:${sha256hex(username)}:${sha256hex(ip)}:${Math.floor(nowMs / HOUR_MS)}`,
  u: (username: string, nowMs: number) => `staff_lf:u:${sha256hex(username)}:${Math.floor(nowMs / DAY_MS)}`,
  ip: (ip: string, nowMs: number) => `staff_lf:ip:${sha256hex(ip)}:${Math.floor(nowMs / HOUR_MS)}`,
  /** SCAN prefix for every `ui` bucket of one username (break-glass without --ip). */
  uiPrefix: (username: string) => `staff_lf:ui:${sha256hex(username)}:`,
};

/** SEED_ADMIN_USERNAME, or '' when unset (env.seedAdminUsername throws on a missing var). */
export function seedAdminUsername(): string {
  try {
    return env.seedAdminUsername.trim();
  } catch {
    return '';
  }
}

/**
 * The seed-admin exemptions apply ONLY when the seed username is configured
 * AND the matched record is a platform admin (role admin, no partnerId). A
 * same-named account re-created later as partner staff or a non-admin never
 * inherits them.
 */
export function isSeedAdminRecord(staff: Staff | null | undefined, seedName: string = seedAdminUsername()): boolean {
  return (
    seedName !== '' &&
    !!staff &&
    staff.username === seedName &&
    staff.role === 'admin' &&
    staff.partnerId === undefined
  );
}

export interface StaffReservation {
  /** true ⇒ run the compare; false ⇒ refuse without touching Argon2. */
  allowed: boolean;
  /** Every key this reservation INCR'd (the refund set). */
  keys: string[];
  /** The bucket that refused, only on the attempt that first crossed its cap (cap + 1). */
  justTripped: StaffBucket | null;
}

export interface StaffLoginGuardOptions {
  now?: () => number;
}

export function createStaffLoginGuard(redis: RedisLike, opts: StaffLoginGuardOptions = {}) {
  const now = opts.now ?? (() => Date.now());

  async function bump(key: string, ttlS: number): Promise<number> {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlS);
    return n;
  }

  return {
    /**
     * Reserve ONE attempt for (username, ip). `seedExempt` (from
     * isSeedAdminRecord) limits the reservation to the `ui` bucket.
     */
    async reserve(username: string, ip: string, reserveOpts: { seedExempt?: boolean } = {}): Promise<StaffReservation> {
      const t = now();
      const keys: string[] = [];
      const plan: Array<{ bucket: StaffBucket; key: string; cap: number; ttl: number }> = [
        { bucket: 'ui', key: staffLoginKeys.ui(username, ip, t), cap: STAFF_UI_CAP, ttl: HOUR_BUCKET_TTL_S },
      ];
      if (!reserveOpts.seedExempt) {
        plan.push({ bucket: 'u', key: staffLoginKeys.u(username, t), cap: STAFF_U_CAP, ttl: DAY_BUCKET_TTL_S });
        // No per-IP bucket for an unknown client IP (no forwarded header): one
        // shared 'unknown' bucket would lock out everyone behind such a proxy.
        // Same rule as ip-rate-limit.isIpRateLimited. The username buckets hold.
        if (ip !== 'unknown') {
          plan.push({ bucket: 'ip', key: staffLoginKeys.ip(ip, t), cap: STAFF_IP_CAP, ttl: HOUR_BUCKET_TTL_S });
        }
      }
      for (const step of plan) {
        const n = await bump(step.key, step.ttl);
        keys.push(step.key);
        if (n > step.cap) {
          return { allowed: false, keys, justTripped: n === step.cap + 1 ? step.bucket : null };
        }
      }
      return { allowed: true, keys, justTripped: null };
    },

    /**
     * Give back a successful attempt's reservation: DECR exactly the keys it
     * bumped. A key that has already expired is skipped (a DECR would create a
     * TTL-less -1 key); a result at or below zero is deleted for the same reason.
     */
    async refund(keys: string[]): Promise<void> {
      for (const k of keys) {
        if (!(await redis.exists(k))) continue;
        const n = await redis.decr(k);
        if (n <= 0) await redis.del(k);
      }
    },

    /**
     * After an admin password reset: drop the username's all-IP day counter,
     * so a member locked out by `u` can sign in with the new password. The
     * per-IP buckets are left alone (the reset proves nothing about any IP).
     */
    async clearUsernameDay(username: string): Promise<void> {
      await redis.del(staffLoginKeys.u(username, now()));
    },

    /** After a proven login: drop the username's `ui` (this IP) and `u` counters. */
    async clear(username: string, ip: string): Promise<void> {
      const t = now();
      await redis.del(staffLoginKeys.ui(username, ip, t));
      await redis.del(staffLoginKeys.u(username, t));
    },
  };
}

export type StaffLoginGuard = ReturnType<typeof createStaffLoginGuard>;

let cached: StaffLoginGuard | null = null;

export function getStaffLoginGuard(): StaffLoginGuard {
  if (!cached) cached = createStaffLoginGuard(getRedis());
  return cached;
}
