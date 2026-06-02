import { Redis } from '@upstash/redis';
import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import { env } from './env';
import { normalizePhone } from './phone';
import type { RedisLike } from './store';

/**
 * WhatsApp phone-OTP engine — NIST 800-63B + OWASP.
 *
 * Possession-proof only (a RESTRICTED authenticator); it is NOT the AML control.
 * Hardening invariants enforced here:
 *  - 6-digit code from a CRYPTOGRAPHIC RNG (node:crypto randomInt), leading zeros kept.
 *  - Only a sha256 HASH of the code is persisted, under an OPAQUE key (sha256 of the
 *    normalized phone). The plaintext code is returned ONLY from issueOtp (to send it)
 *    and is NEVER persisted plain and NEVER logged.
 *  - One live code per number: a fresh issue overwrites the prior one.
 *  - 300s server TTL; single-use (consumed on the first correct verify).
 *  - ≤5 wrong guesses per code, then the code is burned (locked).
 *  - Send throttle: ≥30s between sends, ≤5/hour, ≤10/day per number.
 *  - Constant-time hash comparison on verify.
 */

const CODE_TTL_MS = 300_000; // 5 minutes (≤ the 10-min NIST ceiling)
const RESEND_COOLDOWN_MS = 30_000; // ≥30s between sends
const MAX_PER_HOUR = 5;
const MAX_PER_DAY = 10;
const MAX_ATTEMPTS = 5; // wrong guesses allowed per code before burn

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Redis TTLs (seconds) on the rate buckets so they self-clean in real Redis.
const HOUR_BUCKET_TTL_S = 2 * 60 * 60;
const DAY_BUCKET_TTL_S = 2 * 24 * 60 * 60;
const OTP_TTL_S = 360; // a little past the logical 300s expiry

export interface OtpRecord {
  hash: string; // sha256hex(code)
  attempts: number; // wrong-guess count
  expMs: number; // absolute expiry (ms epoch)
  lastSentAt: number; // ms epoch of issue (drives the 30s resend cooldown)
}

export type IssueResult =
  | { ok: true; code: string }
  | { ok: false; reason: 'throttled'; retryAfterMs: number };

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'wrong' | 'locked' };

export interface OtpStoreOptions {
  /** Injectable clock (default: system clock). Tests stub this for determinism. */
  now?: () => number;
  /** Injectable CSPRNG (default: node:crypto randomInt). Tests stub this. */
  randomInt?: (maxExclusive: number) => number;
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function otpKey(phoneHash: string): string {
  return `otp:${phoneHash}`;
}

export function createOtpStore(redis: RedisLike, opts: OtpStoreOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const randomInt = opts.randomInt ?? ((maxExclusive: number) => cryptoRandomInt(0, maxExclusive));

  async function readCounter(key: string): Promise<number> {
    const raw = await redis.get(key);
    return raw ? Number(raw) : 0;
  }

  return {
    /**
     * Issue (or re-issue) the single live code for `phone`. Returns the plaintext
     * code to the caller for delivery; that is the ONLY place it is ever exposed.
     */
    async issueOtp(phone: string): Promise<IssueResult> {
      const normalized = normalizePhone(phone);
      const phoneHash = sha256hex(normalized);
      const t = now();

      // 30s resend cooldown — derived from the still-live prior record.
      const existingRaw = await redis.get(otpKey(phoneHash));
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw) as OtpRecord;
          if (existing.expMs > t) {
            const elapsed = t - existing.lastSentAt;
            if (elapsed < RESEND_COOLDOWN_MS) {
              return {
                ok: false,
                reason: 'throttled',
                retryAfterMs: RESEND_COOLDOWN_MS - elapsed,
              };
            }
          }
        } catch {
          // malformed record — fall through and overwrite it
        }
      }

      // Hourly / daily caps. Bucketed keys roll over with the window so an
      // expired window naturally reads back as 0 even without Redis TTL.
      const hourBucket = Math.floor(t / HOUR_MS);
      const dayBucket = Math.floor(t / DAY_MS);
      const hourKey = `otp:rate:hour:${phoneHash}:${hourBucket}`;
      const dayKey = `otp:rate:day:${phoneHash}:${dayBucket}`;

      const [hourCount, dayCount] = await Promise.all([
        readCounter(hourKey),
        readCounter(dayKey),
      ]);
      if (hourCount >= MAX_PER_HOUR || dayCount >= MAX_PER_DAY) {
        // Conservatively report the longer of the two window remainders.
        const hourRemain = HOUR_MS - (t % HOUR_MS);
        const dayRemain = DAY_MS - (t % DAY_MS);
        const retryAfterMs = dayCount >= MAX_PER_DAY ? dayRemain : hourRemain;
        return { ok: false, reason: 'throttled', retryAfterMs };
      }

      // CSPRNG 6-digit code, leading zeros preserved.
      const code = String(randomInt(1_000_000)).padStart(6, '0');

      const record: OtpRecord = {
        hash: sha256hex(code),
        attempts: 0,
        expMs: t + CODE_TTL_MS,
        lastSentAt: t,
      };
      // Overwrite any prior code → exactly one live code per number.
      await redis.set(otpKey(phoneHash), JSON.stringify(record), { ex: OTP_TTL_S });

      // Count this send against the windows.
      await redis.incr(hourKey);
      await redis.incr(dayKey);
      await redis.set(hourKey, String(hourCount + 1), { ex: HOUR_BUCKET_TTL_S });
      await redis.set(dayKey, String(dayCount + 1), { ex: DAY_BUCKET_TTL_S });

      return { ok: true, code };
    },

    /**
     * Verify a candidate code. Single-use: a correct code is consumed (deleted).
     * Wrong codes increment the attempt counter; once the cap is exceeded the
     * code is burned. Comparison is constant-time over the hashes.
     */
    async verifyOtp(phone: string, code: string): Promise<VerifyResult> {
      const normalized = normalizePhone(phone);
      const phoneHash = sha256hex(normalized);
      const key = otpKey(phoneHash);
      const t = now();

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
        return { ok: false, reason: 'expired' };
      }

      // Count this guess. Once it pushes past the cap, burn the code.
      record.attempts += 1;
      if (record.attempts > MAX_ATTEMPTS) {
        await redis.del(key);
        return { ok: false, reason: 'locked' };
      }

      const candidateHash = sha256hex(code);
      const a = Buffer.from(candidateHash, 'hex');
      const b = Buffer.from(record.hash, 'hex');
      const match = a.length === b.length && timingSafeEqual(a, b);

      if (match) {
        await redis.del(key); // consume — single use
        return { ok: true };
      }

      // Persist the incremented attempt count and report the miss.
      await redis.set(key, JSON.stringify(record), { ex: OTP_TTL_S });
      return { ok: false, reason: 'wrong' };
    },
  };
}

export type OtpStore = ReturnType<typeof createOtpStore>;

let cached: OtpStore | null = null;

export function getOtpStore(): OtpStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createOtpStore(redis as unknown as RedisLike);
  }
  return cached;
}
