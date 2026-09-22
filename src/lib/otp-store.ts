import { getRedis } from './redis';
import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import { normalizePhone } from './phone';
import { countryForPhone } from './partner-currency';
import type { RedisLike } from './store';
import type { CountryCode } from './types';

/**
 * WhatsApp phone-OTP engine — NIST 800-63B + OWASP.
 *
 * Possession-proof only (a RESTRICTED authenticator); it is NOT the AML control.
 * Hardening invariants enforced here:
 *  - 6-digit code from a CRYPTOGRAPHIC RNG (node:crypto randomInt), leading zeros kept.
 *  - Only a sha256 HASH of the code is persisted, under an OPAQUE key (sha256 of the
 *    normalized phone, namespaced by PURPOSE). Plaintext code returned ONLY from
 *    issueOtp (to send it), NEVER persisted plain, NEVER logged.
 *  - PURPOSE-namespaced ('login'|'register'|'reset') so a code issued for one
 *    ceremony can't be redeemed at another (NIST 800-63B authenticator binding).
 *  - One live code per (number, purpose); a fresh issue overwrites the prior one.
 *  - 300s server TTL; single-use (consumed on the first correct verify).
 *  - ≤5 compares per code → burn, PLUS a per-number DAILY ceiling that survives
 *    resend (≤10 verify attempts/number/day → locked) — the per-code cap alone is
 *    reset by resend, so the daily ceiling is the real brute-force bound. Both are
 *    RESERVED with an atomic INCR before the compare (Program-Fix 19): a parallel
 *    burst cannot read one stale count and all pass. A success consumes one daily
 *    reservation; a lock burns the code record but leaves the per-code counter to
 *    its TTL so a late request can never restart it at 1.
 *  - Send throttle: independent ≥30s cooldown key, ≤5/hour, ≤10/day per number,
 *    8-country geo allow-list; rate buckets use atomic incr+expire (no clobber).
 *  - Constant-time hash comparison on verify; obviously-malformed input is rejected
 *    BEFORE it can consume the per-code attempt budget.
 */

export type OtpPurpose = 'login' | 'register' | 'reset';

const CODE_TTL_MS = 300_000; // 5 minutes (≤ the 10-min NIST ceiling)
const RESEND_COOLDOWN_MS = 30_000; // ≥30s between sends (independent key)
const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 10;
const MAX_ATTEMPTS = 5; // compares allowed per code before burn
const MAX_FAIL_PER_DAY = 10; // verify attempts per number/day before lock (reserved, not counted after)

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const HOUR_BUCKET_TTL_S = 2 * 60 * 60;
const DAY_BUCKET_TTL_S = 2 * 24 * 60 * 60;
const COOLDOWN_TTL_S = 60;
const OTP_TTL_S = 360; // a little past the logical 300s expiry

const ALLOWED_COUNTRIES = new Set<CountryCode>(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);

export interface OtpRecord {
  hash: string; // sha256hex(code)
  /** Legacy per-code counter. Always written as 0 so a pre-fix-19 build reads a number during a rolling release; the `otp:att:` key is authoritative. */
  attempts: number;
  expMs: number; // absolute expiry (ms epoch)
}

export type IssueResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'throttled' | 'locked' | 'unsupported_geo'; retryAfterMs?: number };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'wrong' | 'locked' };

export interface OtpStoreOptions {
  now?: () => number;
  randomInt?: (maxExclusive: number) => number;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
function otpKey(purpose: OtpPurpose, phoneHash: string): string {
  return `otp:${purpose}:${phoneHash}`;
}
/** Per-code compare reservations (INCR'd before every compare; cleared by issue/success/expiry). */
function attKey(purpose: OtpPurpose, phoneHash: string): string {
  return `otp:att:${purpose}:${phoneHash}`;
}

export function createOtpStore(redis: RedisLike, opts: OtpStoreOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const randomInt = opts.randomInt ?? ((maxExclusive: number) => cryptoRandomInt(0, maxExclusive));

  async function readCounter(key: string): Promise<number> {
    const raw = await redis.get(key);
    return raw ? Number(raw) : 0;
  }
  /** Atomic increment + set TTL on first write in the window (no read-then-set race). */
  async function bump(key: string, ttlS: number): Promise<number> {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, ttlS);
    return n;
  }
  function failKey(phoneHash: string, t: number): string {
    return `otp:faillock:${phoneHash}:${Math.floor(t / DAY_MS)}`;
  }
  /** Issue-time read of the daily ceiling; verify-time uses a RESERVATION (bump) instead. */
  async function isDailyLocked(phoneHash: string, t: number): Promise<boolean> {
    return (await readCounter(failKey(phoneHash, t))) >= MAX_FAIL_PER_DAY;
  }

  return {
    async issueOtp(phone: string, purpose: OtpPurpose): Promise<IssueResult> {
      const normalized = normalizePhone(phone);
      const phoneHash = sha256hex(normalized);
      const t = now();

      // 8-country geo allow-list — never send to an unsupported destination.
      const country = countryForPhone(normalized);
      if (!country || !ALLOWED_COUNTRIES.has(country)) {
        return { ok: false, reason: 'unsupported_geo' };
      }
      // Per-number daily fail lock (survives resend).
      if (await isDailyLocked(phoneHash, t)) {
        return { ok: false, reason: 'locked' };
      }
      // Independent 30s cooldown (NOT tied to the code record, so burn/expiry
      // can't unlock an instant resend).
      const cdKey = `otp:cd:${phoneHash}`;
      const cdRaw = await redis.get(cdKey);
      if (cdRaw) {
        const elapsed = t - Number(cdRaw);
        if (elapsed >= 0 && elapsed < RESEND_COOLDOWN_MS) {
          return { ok: false, reason: 'throttled', retryAfterMs: RESEND_COOLDOWN_MS - elapsed };
        }
      }
      // Hourly / daily SEND caps — atomic incr (only reached after the cooldown).
      const hourKey = `otp:rate:hour:${phoneHash}:${Math.floor(t / HOUR_MS)}`;
      const dayKey = `otp:rate:day:${phoneHash}:${Math.floor(t / DAY_MS)}`;
      const hourCount = await bump(hourKey, HOUR_BUCKET_TTL_S);
      const dayCount = await bump(dayKey, DAY_BUCKET_TTL_S);
      if (hourCount > MAX_PER_HOUR || dayCount > MAX_PER_DAY) {
        const retryAfterMs =
          dayCount > MAX_PER_DAY ? DAY_MS - (t % DAY_MS) : HOUR_MS - (t % HOUR_MS);
        return { ok: false, reason: 'throttled', retryAfterMs };
      }

      const code = String(randomInt(1_000_000)).padStart(6, '0');
      const record: OtpRecord = { hash: sha256hex(code), attempts: 0, expMs: t + CODE_TTL_MS };
      // Fresh code ⇒ fresh per-code budget, cleared BEFORE the record lands so a
      // reservation racing this issue counts against the new code, not nothing.
      await redis.del(attKey(purpose, phoneHash));
      await redis.set(otpKey(purpose, phoneHash), JSON.stringify(record), { ex: OTP_TTL_S });
      await redis.set(cdKey, String(t), { ex: COOLDOWN_TTL_S });

      return { ok: true, code };
    },

    async verifyOtp(phone: string, code: string, purpose: OtpPurpose): Promise<VerifyResult> {
      const normalized = normalizePhone(phone);
      const phoneHash = sha256hex(normalized);
      const key = otpKey(purpose, phoneHash);
      const t = now();

      // Reject obviously-malformed input BEFORE it can burn the code or the daily
      // budget (an empty/garbage submission must not consume the victim's code).
      if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'wrong' };

      const raw = await redis.get(key);
      if (!raw) return { ok: false, reason: 'no_code' };

      let record: OtpRecord;
      try {
        record = JSON.parse(raw) as OtpRecord;
      } catch {
        await redis.del(key);
        return { ok: false, reason: 'no_code' };
      }

      if (t >= record.expMs) {
        await redis.del(key);
        await redis.del(attKey(purpose, phoneHash));
        return { ok: false, reason: 'expired' };
      }

      // RESERVE before the compare (fix 19). Only a live code reaches here, so a
      // verify with no code burns nothing. Daily ceiling first (it survives
      // resend), then the per-code budget. Past a cap the record is burned; the
      // per-code counter is left to its TTL / the next issue (never reset by a lock).
      const dayN = await bump(failKey(phoneHash, t), DAY_BUCKET_TTL_S);
      if (dayN > MAX_FAIL_PER_DAY) {
        await redis.del(key);
        return { ok: false, reason: 'locked' };
      }
      const codeN = await bump(attKey(purpose, phoneHash), OTP_TTL_S);
      if (codeN > MAX_ATTEMPTS) {
        await redis.del(key);
        return { ok: false, reason: 'locked' };
      }

      const a = Buffer.from(sha256hex(code), 'hex');
      const b = Buffer.from(record.hash, 'hex');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        await redis.del(key); // consume — single use
        await redis.del(attKey(purpose, phoneHash));
        return { ok: true };
      }

      return { ok: false, reason: 'wrong' }; // the reservation above already counted it
    },
  };
}

export type OtpStore = ReturnType<typeof createOtpStore>;

let cached: OtpStore | null = null;

export function getOtpStore(): OtpStore {
  if (!cached) {
    cached = createOtpStore(getRedis());
  }
  return cached;
}
