import { getRedis } from './redis';
import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import type { RedisLike } from './store';
import { raiseLimiterDownAlert } from './limiter-alert';

/**
 * transaction-otp — a per-transaction step-up code (Phase 3, Part B).
 *
 * A 6-digit code bound to BOTH the transaction id (draftId/transferId) AND the
 * sender phone, so a code issued for one transaction can't authorize another and
 * can't be redirected to a different number. Reuses the same primitives as
 * otp-store (CSPRNG, sha256-at-rest, constant-time compare, attempt cap) but a
 * transaction-scoped key. The code is delivered IN-SESSION (free-form WhatsApp),
 * so it needs no Meta AUTHENTICATION template. Never logged.
 *
 * Attempt caps (Program-Fix 19, F59/F60): every verify RESERVES its attempt with
 * an atomic INCR before any compare — a parallel burst cannot read one stale
 * count and all pass. Two ceilings, both keyed on a hash of the transaction id:
 *  - `txotp:att:<sha(txId)>` — compares per issued code (≤ MAX_ATTEMPTS). Reset
 *    only by `issue()`; a lock deletes the code record but leaves this counter
 *    to its TTL so a late request can never restart it at 1.
 *  - `txotp:fail:<sha(txId)>:<day>` — verify attempts per transaction per UTC-day
 *    bucket (≤ TXOTP_MAX_FAILS_PER_DAY), however many codes are issued; also a
 *    reservation (a success consumes one). At the ceiling both `verify()` and
 *    `issue()` refuse with `locked`.
 *
 * Issue caps (Program-Fix 45): two more ceilings bound how many codes are SENT.
 *  - `txotp:issued:<sha(txId)>` — codes per transaction over its lifetime
 *    (≤ TXOTP_MAX_ISSUES_PER_TX; TTL 8 days, past the 7-day unpaid-link expiry).
 *  - `txotp:phone:<sha(digits(phone))>:<day>` — codes per phone per UTC-day
 *    bucket (≤ TXOTP_MAX_ISSUES_PER_PHONE_PER_DAY), across all transactions.
 *  Both are reserved with an atomic INCR AFTER the cooldown and fail-cap
 *  refusals (a refused request never burns quota) and BEFORE a code is minted;
 *  the transaction counter goes first, so a refusal there leaves the phone's
 *  budget untouched. At a cap `issue()` returns `locked`. A Redis error
 *  propagates (fails closed) after `onStoreError` raises the ops signal.
 */
const TTL_S = 10 * 60;
const COOLDOWN_S = 30;
const MAX_ATTEMPTS = 5;
export const TXOTP_MAX_FAILS_PER_DAY = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAIL_BUCKET_TTL_S = 2 * 24 * 60 * 60; // outlives its day bucket
export const TXOTP_MAX_ISSUES_PER_TX = 10;
export const TXOTP_MAX_ISSUES_PER_PHONE_PER_DAY = 20;
const ISSUED_TTL_S = 8 * 24 * 60 * 60; // outlives the 7-day unpaid-link expiry
/** The scope name the ops signal carries when an issue hits a Redis error. */
export const TXOTP_ISSUE_SCOPE = 'txotp-issue';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const key = (txId: string) => `txotp:${sha(txId)}`;
const cdKey = (txId: string) => `txotp:cd:${sha(txId)}`;
const attKey = (txId: string) => `txotp:att:${sha(txId)}`;
const failKey = (txId: string, t: number) => `txotp:fail:${sha(txId)}:${Math.floor(t / DAY_MS)}`;
const issuedKey = (txId: string) => `txotp:issued:${sha(txId)}`;
// Digits only, so '+1555…' and '1555…' share one budget. Only this cap key is
// normalised: the record's phoneHash stays sha(phone), which old builds verify.
const phoneDayKey = (phone: string, t: number) =>
  `txotp:phone:${sha(phone.replace(/\D/g, ''))}:${Math.floor(t / DAY_MS)}`;

interface Rec {
  codeHash: string;
  phoneHash: string;
  /** Legacy per-code counter. Always written as 0 so a pre-fix-19 build reads a number during a rolling release; the `txotp:att:` key is authoritative. */
  attempts: number;
  expiresAt: number;
}

export type IssueResult = { ok: true; code: string } | { ok: false; reason: 'cooldown' | 'locked' };
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'locked' | 'wrong' };

export interface TxOtpOptions {
  now?: () => number;
  randomInt?: (min: number, max: number) => number;
  /**
   * Called (and awaited) when `issue()` hits a Redis error, before the error is
   * rethrown. Receives only the scope name: never the phone, id or error text.
   * Its own failure is swallowed so the original error always propagates.
   */
  onStoreError?: (scope: string) => Promise<void> | void;
}

export function createTransactionOtpStore(redis: RedisLike, opts: TxOtpOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const randomInt = opts.randomInt ?? ((min: number, max: number) => cryptoRandomInt(min, max));

  async function readCounter(k: string): Promise<number> {
    const raw = await redis.get(k);
    return raw ? Number(raw) : 0;
  }
  /** Atomic increment + TTL on the first write in the window (no read-then-set race). */
  async function bump(k: string, ttlS: number): Promise<number> {
    const n = await redis.incr(k);
    if (n === 1) await redis.expire(k, ttlS);
    return n;
  }

  async function issueInner(txId: string, phone: string): Promise<IssueResult> {
    const t = now();
    // Cooldown is judged in code off the injectable clock (the Redis TTL is a
    // backstop). A pre-fix-19 build wrote the marker '1' (TTL 30 s): still in cooldown.
    const cdRaw = await redis.get(cdKey(txId));
    if (cdRaw) {
      const elapsed = t - Number(cdRaw);
      if (cdRaw === '1' || (elapsed >= 0 && elapsed < COOLDOWN_S * 1000)) {
        return { ok: false, reason: 'cooldown' };
      }
    }
    if ((await readCounter(failKey(txId, t))) >= TXOTP_MAX_FAILS_PER_DAY) {
      return { ok: false, reason: 'locked' };
    }
    // Program-Fix 45: reserve the send budgets only now, past every refusal
    // above. Transaction first, so a refusal there leaves the phone's budget alone.
    if ((await bump(issuedKey(txId), ISSUED_TTL_S)) > TXOTP_MAX_ISSUES_PER_TX) {
      return { ok: false, reason: 'locked' };
    }
    if ((await bump(phoneDayKey(phone, t), FAIL_BUCKET_TTL_S)) > TXOTP_MAX_ISSUES_PER_PHONE_PER_DAY) {
      return { ok: false, reason: 'locked' };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const rec: Rec = {
      codeHash: sha(code),
      phoneHash: sha(phone),
      attempts: 0,
      expiresAt: t + TTL_S * 1000,
    };
    // Fresh code ⇒ fresh per-code budget. The counter is cleared BEFORE the
    // record lands so a reservation racing this issue counts against the new
    // code rather than being erased.
    await redis.del(attKey(txId));
    await redis.set(key(txId), JSON.stringify(rec), { ex: TTL_S });
    await redis.set(cdKey(txId), String(t), { ex: COOLDOWN_S });
    return { ok: true, code }; // caller delivers it; never logged here
  }

  return {
    async issue(txId: string, phone: string): Promise<IssueResult> {
      try {
        return await issueInner(txId, phone);
      } catch (err) {
        try {
          await opts.onStoreError?.(TXOTP_ISSUE_SCOPE);
        } catch {
          /* the signal is best-effort; the original error wins */
        }
        throw err; // fail closed: no code is sent
      }
    },

    async verify(txId: string, phone: string, code: string): Promise<VerifyResult> {
      const t = now();
      // 1. Per-transaction daily ceiling: at the cap, nothing is compared.
      if ((await readCounter(failKey(txId, t))) >= TXOTP_MAX_FAILS_PER_DAY) {
        await redis.del(key(txId));
        return { ok: false, reason: 'locked' };
      }
      // 2. The live code record.
      const raw = await redis.get(key(txId));
      if (!raw) return { ok: false, reason: 'no_code' };
      let rec: Rec;
      try {
        rec = JSON.parse(raw) as Rec;
      } catch {
        return { ok: false, reason: 'no_code' };
      }
      if (t > rec.expiresAt) {
        await redis.del(key(txId));
        return { ok: false, reason: 'expired' };
      }
      // 3. Reserve this attempt atomically BEFORE the compare: the daily ceiling
      //    first (it survives re-issues), then the per-code budget. Past a cap the
      //    record is burned; the per-code counter is left to its TTL (see header).
      const dayN = await bump(failKey(txId, t), FAIL_BUCKET_TTL_S);
      if (dayN > TXOTP_MAX_FAILS_PER_DAY) {
        await redis.del(key(txId));
        return { ok: false, reason: 'locked' };
      }
      const n = await bump(attKey(txId), TTL_S);
      if (n > MAX_ATTEMPTS) {
        await redis.del(key(txId));
        return { ok: false, reason: 'locked' };
      }
      // 4. Compare (constant-time on the hash).
      const okPhone = sha(phone) === rec.phoneHash;
      const a = Buffer.from(sha(code), 'utf8');
      const b = Buffer.from(rec.codeHash, 'utf8');
      const okCode = a.length === b.length && timingSafeEqual(a, b);
      if (okPhone && okCode) {
        await redis.del(key(txId)); // single-use
        await redis.del(attKey(txId));
        return { ok: true };
      }
      return { ok: false, reason: 'wrong' }; // the reservations above already counted it
    },
  };
}

export type TransactionOtpStore = ReturnType<typeof createTransactionOtpStore>;

let cached: TransactionOtpStore | null = null;

export function getTransactionOtpStore(): TransactionOtpStore {
  if (!cached) {
    // Program-Fix 45: a Redis error fails the send closed AND tells ops (deduped, scope-only payload).
    cached = createTransactionOtpStore(getRedis(), {
      onStoreError: (scope) => raiseLimiterDownAlert(scope, 'fail-closed'),
    });
  }
  return cached;
}
