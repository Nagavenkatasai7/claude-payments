import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import { getRedis } from './redis';
import { normalizePhone } from './phone';
import { countryForPhone } from './partner-currency';
import type { RedisLike } from './store';
import type { CountryCode, PartnerId } from './types';

/**
 * Portal OTP store (UI redesign M2, SPEC §2.1). Dormant library: M2-5 wires it.
 *
 * TENANT-KEYED: every per-customer key is under h = sha256("<partnerId>|<normalized phone>"),
 * so a code issued on partner A's site never verifies on partner B's, and B's cooldown,
 * send buckets, failure budget and lock are independent of A's. The raw phone is never
 * part of a key or a value. The legacy phone-keyed otp-store.ts stays for /account.
 *
 * Invariants:
 *  - 6-digit code from a CRYPTOGRAPHIC RNG, leading zeros kept, 5-minute expiry,
 *    single-use (atomic GETDEL consume), purpose-bound ('login' | 'stepup').
 *  - Only a sha256 of the code is stored. The plaintext is returned by issue() for the
 *    caller to send and is NEVER logged or persisted here (this module imports no logger
 *    and no outbox; a test pins it).
 *  - Brute-force bound (review round 1, H2): ONE failure budget per (partner, phone),
 *    shared by both purposes, that a resend never resets: 5 failures in a 15-min bucket
 *    → 15-min lock; 10 in a UTC day → locked until the next UTC midnight. Both counters
 *    are RESERVED (INCR) before the code is read, so a parallel burst cannot read one
 *    stale count. A correct code refunds exactly its own two reservations (DECR, the
 *    Program-Fix 17 pattern), so an honest customer's step-ups never eat the budget.
 *  - Oracle-proof (review round 1, M2): a verify that finds no code (never sent, already
 *    used, expired) costs the budget exactly like a wrong guess and locks the same way.
 *  - Send caps: 60 s cooldown claimed atomically (SET NX), shared by both purposes;
 *    5/hour and 10/day per (partner, phone); 300/hour and 2,000/day per partner, which
 *    refuse ONLY numbers that are not yet this partner's customers (O13).
 *  - Every method is request-scope free (no headers()/cookies()), so M2-5 can run all
 *    phone-dependent calls inside after() (review round 1, M1).
 */

export type PortalOtpPurpose = 'login' | 'stepup';

export const PORTAL_OTP_POLICY = {
  codeTtlMs: 300_000,
  cooldownMs: 60_000,
  maxSendsPerHourPerPhone: 5,
  maxSendsPerDayPerPhone: 10,
  maxFailuresPerWindow: 5,
  failWindowMs: 900_000,
  lockMs: 900_000,
  maxFailuresPerDay: 10,
  partnerSendsPerHour: 300,
  partnerSendsPerDay: 2_000,
} as const;

/**
 * The per-IP limit on code requests (20/hour). Enforced by the M2-5 action with
 * checkIpRateLimit(getRedis(), scope, clientIpFrom(headers), { limit, windowSec }); the
 * store itself never sees an IP. Defined here so the whole OTP policy lives in one file.
 */
export const PORTAL_OTP_IP_LIMIT = { scope: 'portalotp', limit: 20, windowSec: 3600 } as const;

/** Equal to the legacy allow-list (otp-store.ts ALLOWED_COUNTRIES); a test pins it. */
export const PORTAL_OTP_COUNTRIES: ReadonlySet<CountryCode> = new Set<CountryCode>([
  'US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN',
]);

export type PortalIssueResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'cooldown' | 'throttled' | 'locked' | 'unsupported_geo' | 'partner_ceiling' };

export type PortalVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'wrong' | 'locked' };

export interface PortalOtpStoreOptions {
  now?: () => number;
  randomInt?: (maxExclusive: number) => number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CODE_RECORD_TTL_S = 360; // a little past the logical 300 s expiry
const COOLDOWN_TTL_S = 60;
const FAIL_WINDOW_TTL_S = 1_800;
const HOUR_BUCKET_TTL_S = 7_200;
const DAY_BUCKET_TTL_S = 172_800;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function createPortalOtpStore(redis: RedisLike, opts: PortalOtpStoreOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const rnd = opts.randomInt ?? ((m: number) => cryptoRandomInt(0, m));
  const P = PORTAL_OTP_POLICY;

  const hOf = (pid: PartnerId, phone: string) => sha(`${pid}|${normalizePhone(phone)}`);
  const lockKey = (h: string) => `potp:lock:${h}`;
  const dayFailKey = (h: string, day: number) => `potp:faild:${h}:${day}`;
  const codeKey = (purpose: PortalOtpPurpose, h: string) => `potp:${purpose}:${h}`;

  /**
   * Counter bucket increment. RedisLike has no MULTI/pipeline, so the TTL is attached at
   * creation instead: SET NX EX creates the bucket with its TTL in ONE command, and INCR/DECR
   * keep an existing TTL (src/lib/store.ts RedisLike.set opts {ex, nx}). A crash can never
   * leave a TTL-less counter, and every call makes the SAME two Redis calls whatever the
   * count (no count-dependent EXPIRE, so the call sequence reveals nothing). Every bucket's
   * TTL is at least twice its window, so it cannot expire between the two calls while the
   * bucket is current.
   */
  async function bump(key: string, ttlS: number): Promise<number> {
    await redis.set(key, '0', { nx: true, ex: ttlS });
    return redis.incr(key);
  }
  /** Refund one reservation (the same TTL-at-creation rule). */
  async function refund(key: string, ttlS: number): Promise<void> {
    await redis.set(key, '0', { nx: true, ex: ttlS });
    await redis.decr(key);
  }

  /**
   * Locked when the lock key says so (a non-numeric value fails CLOSED; the Redis TTL is
   * the backstop) OR today's failure counter has reached the daily ceiling. The counter
   * check matters because the lock write is last-write-wins: a racing request holding a
   * lower count could overwrite a midnight lock with a 15-minute one.
   */
  async function lockedAt(h: string, t: number): Promise<boolean> {
    const raw = await redis.get(lockKey(h));
    if (raw !== null) {
      const until = Number(raw);
      if (!Number.isFinite(until) || t < until) return true;
    }
    const d = await redis.get(dayFailKey(h, Math.floor(t / DAY_MS)));
    return d !== null && Number(d) >= P.maxFailuresPerDay;
  }

  async function arm(h: string, t: number, untilMs: number): Promise<void> {
    await redis.set(lockKey(h), String(untilMs), { ex: Math.max(1, Math.ceil((untilMs - t) / 1000)) });
  }

  /**
   * Claim the 60 s cooldown. In real Redis a failed NX means another send within the TTL.
   * The value check covers a key whose TTL has not fired yet (or a store without TTL):
   * elapsed < cooldown, INCLUDING a negative elapsed (clock skew), is a cooldown. A stale
   * key is released through an NX claim on a successor key named by the old value, so
   * two requests that both saw the same stale value cannot both send.
   */
  async function claimCooldown(h: string, t: number): Promise<boolean> {
    const cdKey = `potp:cd:${h}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if ((await redis.set(cdKey, String(t), { nx: true, ex: COOLDOWN_TTL_S })) !== null) return true;
      const raw = await redis.get(cdKey);
      if (raw === null) continue; // expired between the NX and the read: claim again
      const prev = Number(raw);
      if (!Number.isFinite(prev) || t - prev < P.cooldownMs) return false;
      if ((await redis.set(`potp:cdn:${h}:${raw}`, '1', { nx: true, ex: COOLDOWN_TTL_S })) === null) return false;
      await redis.set(cdKey, String(t), { ex: COOLDOWN_TTL_S });
      return true;
    }
    return false;
  }

  return {
    async isLocked(pid: PartnerId, phone: string): Promise<boolean> {
      return lockedAt(hOf(pid, phone), now());
    },

    async issue(
      pid: PartnerId,
      phone: string,
      purpose: PortalOtpPurpose,
      o: { knownCustomer?: boolean } = {},
    ): Promise<PortalIssueResult> {
      const n = normalizePhone(phone);
      const t = now();
      const country = countryForPhone(n);
      if (!country || !PORTAL_OTP_COUNTRIES.has(country)) return { ok: false, reason: 'unsupported_geo' };
      const h = hOf(pid, n);
      if (await lockedAt(h, t)) return { ok: false, reason: 'locked' };
      if (!(await claimCooldown(h, t))) return { ok: false, reason: 'cooldown' };

      const hour = Math.floor(t / HOUR_MS);
      const day = Math.floor(t / DAY_MS);
      const hr = await bump(`potp:hr:${h}:${hour}`, HOUR_BUCKET_TTL_S);
      const dy = await bump(`potp:day:${h}:${day}`, DAY_BUCKET_TTL_S);
      if (hr > P.maxSendsPerHourPerPhone || dy > P.maxSendsPerDayPerPhone) return { ok: false, reason: 'throttled' };

      // Per-partner anti-pumping ceiling (the partner's WABA pays for every message). It
      // counts every send, but refuses only numbers that are not yet this partner's
      // customers, so a flood of unknown numbers cannot lock real customers out (O13).
      const partnerH = await bump(`potp:p:${pid}:${hour}`, HOUR_BUCKET_TTL_S);
      const partnerD = await bump(`potp:pd:${pid}:${day}`, DAY_BUCKET_TTL_S);
      if ((partnerH > P.partnerSendsPerHour || partnerD > P.partnerSendsPerDay) && o.knownCustomer !== true) {
        return { ok: false, reason: 'partner_ceiling' };
      }

      const code = String(rnd(1_000_000)).padStart(6, '0');
      // A fresh code does NOT reset any failure counter (H2: the budget survives resend).
      await redis.set(codeKey(purpose, h), JSON.stringify({ hash: sha(code), expMs: t + P.codeTtlMs }), {
        ex: CODE_RECORD_TTL_S,
      });
      return { ok: true, code };
    },

    async verify(pid: PartnerId, phone: string, code: string, purpose: PortalOtpPurpose): Promise<PortalVerifyResult> {
      const t = now();
      const h = hOf(pid, phone);
      // Malformed input is rejected before it can touch the budget.
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { ok: false, reason: 'wrong' };
      if (await lockedAt(h, t)) return { ok: false, reason: 'locked' };

      // RESERVE one failure in both counters BEFORE the code is read (every verify that
      // reaches here pays, including no_code and expired: review round 1, M2).
      const winKey = `potp:fail:${h}:${Math.floor(t / P.failWindowMs)}`;
      const day = Math.floor(t / DAY_MS);
      const dKey = dayFailKey(h, day);
      const nWin = await bump(winKey, FAIL_WINDOW_TTL_S);
      const nDay = await bump(dKey, DAY_BUCKET_TTL_S);
      const lockUntil = nDay >= P.maxFailuresPerDay ? (day + 1) * DAY_MS : t + P.lockMs;
      const k = codeKey(purpose, h);

      const lockNow = async (): Promise<PortalVerifyResult> => {
        await arm(h, t, lockUntil);
        await redis.del(k);
        return { ok: false, reason: 'locked' };
      };
      // Over budget (a parallel burst past the ceiling): lock without reading the code.
      if (nWin > P.maxFailuresPerWindow || nDay > P.maxFailuresPerDay) return lockNow();
      const exhausted = nWin >= P.maxFailuresPerWindow || nDay >= P.maxFailuresPerDay;
      const fail = async (reason: 'wrong' | 'no_code' | 'expired'): Promise<PortalVerifyResult> =>
        exhausted ? lockNow() : { ok: false, reason };

      // wrong / no_code / expired must make the IDENTICAL Redis call sequence (review of #387):
      // an extra DEL only when a record exists would reveal which phones were sent a code.
      // An expired or corrupt record is left to its Redis TTL (360 s); until then every
      // verify against it keeps costing budget, exactly like a wrong guess.
      const raw = await redis.get(k);
      if (raw === null) return fail('no_code');
      let rec: { hash?: unknown; expMs?: unknown };
      try {
        rec = JSON.parse(raw) as { hash?: unknown; expMs?: unknown };
      } catch {
        return fail('no_code');
      }
      if (typeof rec.hash !== 'string' || typeof rec.expMs !== 'number' || !Number.isFinite(rec.expMs)) {
        return fail('no_code');
      }
      if (t >= rec.expMs) return fail('expired');
      const a = Buffer.from(sha(code), 'hex');
      const b = Buffer.from(rec.hash, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return fail('wrong');

      // Atomic consume. The consumed value must be the one compared: if a resend replaced
      // the record in between, the old code must not consume the new one (no refund).
      const got = await redis.getdel(k);
      if (got !== raw) {
        // A newer record (a resend) raced in between: put it back so the customer's fresh
        // code survives. NX, so a still-newer record written meanwhile is never clobbered.
        if (got !== null) await redis.set(k, got, { nx: true, ex: CODE_RECORD_TTL_S });
        return fail('no_code');
      }
      await refund(winKey, FAIL_WINDOW_TTL_S);
      await refund(dKey, DAY_BUCKET_TTL_S);
      return { ok: true };
    },
  };
}

export type PortalOtpStore = ReturnType<typeof createPortalOtpStore>;

let cached: PortalOtpStore | null = null;
export function getPortalOtpStore(): PortalOtpStore {
  return (cached ??= createPortalOtpStore(getRedis()));
}
