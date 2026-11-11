import { getConsumeRedis, getRedis } from './redis';
import { markOtpConsumeFailure } from './otp-consume-failure';
import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import type { RedisLike } from './store';
import { raiseLimiterDownAlert } from './limiter-alert';
import { DEFAULT_PARTNER_ID } from './defaults';

/**
 * transaction-otp — a per-transaction step-up code (Phase 3, Part B).
 *
 * A 6-digit code bound to BOTH the transaction id (draftId/transferId) AND the
 * sender phone, so a code issued for one transaction can't authorize another and
 * can't be redirected to a different number. Reuses the same primitives as
 * otp-store (CSPRNG, sha256-at-rest, constant-time compare, attempt cap) but a
 * transaction-scoped key. The code goes out as free-form text in-session, or
 * through a Meta AUTHENTICATION template outside the 24-hour window (see
 * sendTransactionOtp). Never logged.
 *
 * Authorisation record (fix pack 4, C5): the record carries `issuedAt`, and a
 * successful verify reports `issuedAt`, the per-code `attempt` and the delivery
 * `channel`. The channel is NOT in the record: the route notes it afterwards in
 * a separate key per code, `txotp:ch:<sha(txId)>:<issuedAt>` (`noteDelivery`,
 * value `<issuedAt>|<wa|tg>`), so a late note can never recreate a consumed
 * code, tag a newer one, or overwrite a newer code's note (review R1-P4 B1: a
 * late note lands on its own code's key, which nobody reads, and expires). A
 * correct code is consumed atomically with GETDEL on the no-retry consume
 * client (R1-P4 B2: a GETDEL is never resent, so a lost response throws rather
 * than answering "wrong code"); the record is never rewritten after issue. An
 * expired or exhausted record is burned only if it is still the one verify read
 * (R1-P4 B3: a Resend landing in between keeps its new code).
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
 *  - `txotp:phone:<kind>:<partnerId>:<sha(digits(phone))>:<day>` — codes per
 *    phone per UTC-day bucket (≤ TXOTP_MAX_ISSUES_PER_PHONE_PER_DAY), across
 *    transactions, scoped by caller kind and partner (see TxOtpBudget).
 *  Both are reserved with an atomic INCR AFTER the cooldown and fail-cap
 *  refusals (a refused request never burns quota) and BEFORE a code is minted;
 *  neither cap's refusal burns the other's budget (see issueInner). At a cap `issue()` returns `locked`. A Redis error
 *  propagates (fails closed) after `onStoreError` raises the ops signal.
 */
const TTL_S = 10 * 60;
const COOLDOWN_S = 30;
/** Program-Fix 25 PR B: the cooldown floor after a code whose send failed. */
const SEND_FAIL_COOLDOWN_S = 10;
const MAX_ATTEMPTS = 5;
export const TXOTP_MAX_FAILS_PER_DAY = 15;
const DAY_MS = 24 * 60 * 60 * 1000;
const FAIL_BUCKET_TTL_S = 2 * 24 * 60 * 60; // outlives its day bucket
export const TXOTP_MAX_ISSUES_PER_TX = 10;
export const TXOTP_MAX_ISSUES_PER_PHONE_PER_DAY = 20;
// Outlives the 7-day unpaid pay-link expiry. B2B invoice and seller ids do NOT
// expire, so for those the lifetime counter lapses after 8 days and the budget
// renews; the per-phone daily cap still bounds them in the meantime.
const ISSUED_TTL_S = 8 * 24 * 60 * 60;
/** The scope name the ops signal carries when an issue hits a Redis error. */
export const TXOTP_ISSUE_SCOPE = 'txotp-issue';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const key = (txId: string) => `txotp:${sha(txId)}`;
const cdKey = (txId: string) => `txotp:cd:${sha(txId)}`;
const attKey = (txId: string) => `txotp:att:${sha(txId)}`;
const failKey = (txId: string, t: number) => `txotp:fail:${sha(txId)}:${Math.floor(t / DAY_MS)}`;
const issuedKey = (txId: string) => `txotp:issued:${sha(txId)}`;
/**
 * Fix pack 4 (C5), review R1-P4 (B1): the delivery channel of the code issued
 * at `issuedAt`, value `<issuedAt>|<wa|tg>`. One key per code, so a late note
 * for an older code never overwrites the live code's note. (The previous
 * build's `txotp:ch:<sha>` key is never read here; it expires within TTL_S.)
 */
const chKey = (txId: string, issuedAt: number) => `txotp:ch:${sha(txId)}:${issuedAt}`;
/**
 * Which per-phone daily budget an issue draws from. Budgets are separate per
 * caller kind AND per partner, so one flow (or one tenant) reaching its cap can
 * never block a phone's codes in another. The default is the remittance pay
 * page of the default partner, so no caller is ever left unscoped.
 */
// 'agent' (Stage C2): pay codes for a draft an AI app prepared, so an app that keeps asking for
// codes never uses up the customer's own 'pay' budget.
export type TxOtpBudgetKind = 'pay' | 'b2b' | 'seller' | 'agent';
export interface TxOtpBudget {
  kind: TxOtpBudgetKind;
  partnerId: string;
}
const DEFAULT_BUDGET: TxOtpBudget = { kind: 'pay', partnerId: DEFAULT_PARTNER_ID };
const keySafe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
// Digits only, so '+1555…' and '1555…' share one budget. Only this cap key is
// normalised: the record's phoneHash stays sha(phone), which old builds verify.
const phoneDayKey = (phone: string, t: number, b: TxOtpBudget) =>
  `txotp:phone:${b.kind}:${keySafe(b.partnerId)}:${sha(phone.replace(/\D/g, ''))}:${Math.floor(t / DAY_MS)}`;

interface Rec {
  codeHash: string;
  phoneHash: string;
  /** Legacy per-code counter. Always written as 0 so a pre-fix-19 build reads a number during a rolling release; the `txotp:att:` key is authoritative. */
  attempts: number;
  expiresAt: number;
  /** Fix pack 4 (C5): when the code was issued. Always written now; optional so a previous-build record parses (then `expiresAt - TTL`). */
  issuedAt?: number;
}

/** Fix pack 4 (C5): the channel a code was delivered on. */
export type TxOtpChannel = 'wa' | 'tg';

export type IssueResult =
  | { ok: true; code: string; issuedAt: number }
  | { ok: false; reason: 'cooldown' | 'locked' };
export type VerifyResult =
  // The extras are optional so route-spec mocks returning `{ ok: true }` stay valid.
  | { ok: true; issuedAt?: number; attempt?: number; channel?: TxOtpChannel | null }
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
  /**
   * Review R1-P4 (B2): the client for the code's single-use GETDEL ONLY. It
   * must not retry (getConsumeRedis): a GETDEL whose response was lost would
   * be resent and answer null. Defaults to `redis` (tests, fakes).
   */
  consume?: RedisLike;
}

export function createTransactionOtpStore(redis: RedisLike, opts: TxOtpOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const randomInt = opts.randomInt ?? ((min: number, max: number) => cryptoRandomInt(min, max));
  const consume = opts.consume ?? redis;

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

  /** Put a newer record back that a GETDEL took by mistake (never one that was compared). */
  async function restoreNewer(txId: string, taken: string, t: number): Promise<void> {
    try {
      const newer = JSON.parse(taken) as Rec;
      const ttl = Math.ceil((newer.expiresAt - t) / 1000);
      if (ttl > 0) await redis.set(key(txId), taken, { ex: ttl, nx: true });
    } catch {
      /* an unparseable record is not restored */
    }
  }

  /**
   * Review R1-P4 (B3): burn the expired or exhausted record `raw` that verify
   * read, and only that one. A Resend that landed after the GET wrote a newer
   * record; a plain DEL would delete it, so take with GETDEL and put a newer
   * record back (NX). The main (retrying) client is used. Review R3-Y1 O3: if
   * the first GETDEL's response is lost, the retry answers null. When that
   * GETDEL took `raw`, the burn simply happened. When it took a NEWER record
   * (a Resend that landed after verify's GET), that newer code is gone for good:
   * its value left with the lost response, so no client choice can restore it,
   * and the customer taps Resend again. The answer is still the caller's
   * expired or locked refusal, never ok. Known limit.
   */
  async function burn(txId: string, raw: string, t: number): Promise<void> {
    const taken = await redis.getdel(key(txId));
    if (taken !== null && taken !== raw) await restoreNewer(txId, taken, t);
  }

  async function issueInner(txId: string, phone: string, budget: TxOtpBudget): Promise<IssueResult> {
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
    // above. A transaction already at its lifetime cap is refused on a plain
    // read first, so it never touches the phone's budget. Then the phone budget
    // is reserved, and only once that passes is the transaction's (so a phone-cap
    // refusal never burns the transaction's budget). Only a concurrent race at the
    // transaction cap can cost the phone one unit; RedisLike has no DECR to refund.
    if ((await readCounter(issuedKey(txId))) >= TXOTP_MAX_ISSUES_PER_TX) {
      return { ok: false, reason: 'locked' };
    }
    if ((await bump(phoneDayKey(phone, t, budget), FAIL_BUCKET_TTL_S)) > TXOTP_MAX_ISSUES_PER_PHONE_PER_DAY) {
      return { ok: false, reason: 'locked' };
    }
    if ((await bump(issuedKey(txId), ISSUED_TTL_S)) > TXOTP_MAX_ISSUES_PER_TX) {
      return { ok: false, reason: 'locked' };
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const rec: Rec = {
      codeHash: sha(code),
      phoneHash: sha(phone),
      attempts: 0,
      expiresAt: t + TTL_S * 1000,
      issuedAt: t,
    };
    // Fresh code ⇒ fresh per-code budget. The counter is cleared BEFORE the
    // record lands so a reservation racing this issue counts against the new
    // code rather than being erased.
    await redis.del(attKey(txId));
    // A channel noted for an earlier code never carries over (C5): it sits on
    // that code's own key (R1-P4 B1), which verify never reads for this one.
    await redis.set(key(txId), JSON.stringify(rec), { ex: TTL_S });
    await redis.set(cdKey(txId), String(t), { ex: COOLDOWN_S });
    return { ok: true, code, issuedAt: t }; // caller delivers it; never logged here
  }

  return {
    async issue(txId: string, phone: string, budget: TxOtpBudget = DEFAULT_BUDGET): Promise<IssueResult> {
      try {
        return await issueInner(txId, phone, budget);
      } catch (err) {
        try {
          await opts.onStoreError?.(TXOTP_ISSUE_SCOPE);
        } catch {
          /* the signal is best-effort; the original error wins */
        }
        throw err; // fail closed: no code is sent
      }
    },

    /**
     * Program-Fix 25 PR B (cooldown trap, review r1): the code issued last never
     * reached the customer (the WhatsApp send threw). SHORTEN the 30-s cooldown
     * to a floor of SEND_FAIL_COOLDOWN_S from now: a retry works soon, but Resend
     * cannot be hammered through the lifetime issue budget during a WhatsApp
     * outage (deleting it would let 10 taps lock the link in seconds). Never
     * lengthens a cooldown with less left; touches ONLY the cooldown marker.
     */
    async shortenCooldown(txId: string): Promise<void> {
      const t = now();
      const cdRaw = await redis.get(cdKey(txId));
      if (!cdRaw) return;
      const startedAt = cdRaw === '1' ? t : Number(cdRaw); // pre-fix-19 marker: a full cooldown
      const remainingMs = startedAt + COOLDOWN_S * 1000 - t;
      if (!(remainingMs > SEND_FAIL_COOLDOWN_S * 1000)) return;
      // The in-code check reads the start time; back-date it so exactly the floor remains.
      await redis.set(cdKey(txId), String(t - (COOLDOWN_S - SEND_FAIL_COOLDOWN_S) * 1000), {
        ex: SEND_FAIL_COOLDOWN_S,
      });
    },

    /**
     * Fix pack 4 (C5): record the channel the code issued at `issuedAt` went out
     * on. Best-effort and never throws: a null channel or a non-finite issuedAt
     * (a mocked issue without it) writes nothing, and a Redis error is swallowed
     * without a log. It never touches the code record, so a late note cannot
     * recreate a consumed code; verify takes it only when its issuedAt matches.
     */
    async noteDelivery(txId: string, issuedAt: number, channel: TxOtpChannel | null): Promise<void> {
      if (channel === null || !Number.isFinite(issuedAt)) return;
      try {
        await redis.set(chKey(txId, issuedAt), `${issuedAt}|${channel}`, { ex: TTL_S });
      } catch {
        /* best-effort: never blocks the send; nothing logged */
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
        await burn(txId, raw, t);
        return { ok: false, reason: 'expired' };
      }
      // 3. Reserve this attempt atomically BEFORE the compare: the daily ceiling
      //    first (it survives re-issues), then the per-code budget. Past a cap the
      //    record is burned; the per-code counter is left to its TTL (see header).
      const dayN = await bump(failKey(txId, t), FAIL_BUCKET_TTL_S);
      if (dayN > TXOTP_MAX_FAILS_PER_DAY) {
        await burn(txId, raw, t);
        return { ok: false, reason: 'locked' };
      }
      const n = await bump(attKey(txId), TTL_S);
      if (n > MAX_ATTEMPTS) {
        await burn(txId, raw, t);
        return { ok: false, reason: 'locked' };
      }
      // 4. Compare (constant-time on the hash).
      const okPhone = sha(phone) === rec.phoneHash;
      const a = Buffer.from(sha(code), 'utf8');
      const b = Buffer.from(rec.codeHash, 'utf8');
      const okCode = a.length === b.length && timingSafeEqual(a, b);
      if (okPhone && okCode) {
        // Single-use, atomically (C5): only the request whose GETDEL returns the
        // exact record it compared is accepted. R1-P4 (B2): on the no-retry
        // consume client, so a network error PROPAGATES (the route answers its
        // retryable 503) instead of a resent GETDEL answering null ("wrong
        // code"). Nothing is restored after a throw: whether the server ran it
        // is unknown, and another request may already have accepted the code.
        // Review R2-Q1 B4: the throw is marked (otp-consume-failure.ts), so every caller answers
        // its retryable error whatever the network error's shape.
        let taken: string | null;
        try {
          taken = await consume.getdel(key(txId));
        } catch (err) {
          throw markOtpConsumeFailure(err);
        }
        if (taken === null) return { ok: false, reason: 'no_code' }; // another request consumed it
        if (taken !== raw) {
          // A Resend re-issued between the GET and the GETDEL: put the newer
          // record back (it was never compared, so this cannot double-accept).
          // Its per-code counter belongs to the new code: left alone.
          await restoreNewer(txId, taken, t);
          return { ok: false, reason: 'no_code' };
        }
        await redis.del(attKey(txId));
        const issuedAt = typeof rec.issuedAt === 'number' ? rec.issuedAt : rec.expiresAt - TTL_S * 1000;
        let channel: TxOtpChannel | null = null;
        try {
          // The main (retrying) client: the code is already consumed, and a
          // resent GETDEL can only lose the note (null), never accept anything.
          const noted = await redis.getdel(chKey(txId, issuedAt));
          if (noted === `${issuedAt}|wa`) channel = 'wa';
          else if (noted === `${issuedAt}|tg`) channel = 'tg';
        } catch {
          channel = null;
        }
        return { ok: true, issuedAt, attempt: n, channel };
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
      consume: getConsumeRedis(), // R1-P4 B2: the code GETDEL is never resent
    });
  }
  return cached;
}
