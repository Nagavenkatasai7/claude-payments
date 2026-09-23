import { getRedis } from './redis';
import { createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from './store';

/**
 * Pending-auth token — the binding that makes the OTP step a true SECOND factor.
 *
 * A 256-bit single-use token is minted ONLY after a prior factor is proven:
 *  - 'login'    → after the password is verified (AAL1),
 *  - 'register' → after the account is created,
 *  - 'reset'    → after a reset is requested for a real account.
 *
 * The OTP-verify step must `consume()` a token of the RIGHT purpose; it derives
 * the phone from the token (NOT from the form), so a valid OTP alone — without a
 * matching pending-auth token — cannot mint a session. This closes the AAL2
 * bypass (password-skip) and prevents a 'reset' code from authenticating a login
 * (purpose mismatch). The token hash (not the token) is the Redis key, so a dump
 * leaks nothing usable. TTL 5 min — the OTP step must complete within it.
 */

export type AuthPurpose = 'login' | 'register' | 'reset' | 'mfa';

/**
 * Program-Fix 49D: 'mfa' is the TOTP step of a password-proven sign-in of an
 * enrolled customer. Its record also carries `bind` — a short tag of the
 * password hash that was proven (customer-mfa passwordTag), so a password
 * change or reset inside the 5-minute window voids it. An old build never
 * mints 'mfa', and every consumer checks the purpose it expects.
 */
export interface PendingAuth {
  phone: string;
  purpose: AuthPurpose;
  bind?: string;
}

interface PendingRecord {
  phone: string;
  purpose: AuthPurpose;
  createdMs: number;
  bind?: string;
}

const TTL_S = 300; // 5 minutes
/** Program-Fix 49D: codes tried against one 'mfa' token before it is dropped. */
export const PENDING_MAX_ATTEMPTS = 5;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function key(token: string): string {
  return `pending:${sha256hex(token)}`;
}
function attemptsKey(token: string): string {
  return `pending_n:${sha256hex(token)}`;
}

export function createPendingAuthStore(redis: RedisLike, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  function parse(raw: string | null): PendingAuth | null {
    if (!raw) return null;
    let rec: PendingRecord;
    try {
      rec = JSON.parse(raw) as PendingRecord;
    } catch {
      return null;
    }
    if (now() - rec.createdMs > TTL_S * 1000) return null; // expired (in-code guard)
    // `bind` only when present, so the pre-49D tokens keep their exact shape.
    return typeof rec.bind === 'string'
      ? { phone: rec.phone, purpose: rec.purpose, bind: rec.bind }
      : { phone: rec.phone, purpose: rec.purpose };
  }

  return {
    /** Mint a single-use token AFTER a prior factor is proven. */
    async create(phone: string, purpose: AuthPurpose, opts: { bind?: string } = {}): Promise<string> {
      const token = randomBytes(32).toString('hex');
      const rec: PendingRecord = { phone, purpose, createdMs: now() };
      if (opts.bind) rec.bind = opts.bind;
      await redis.set(key(token), JSON.stringify(rec), { ex: TTL_S });
      return token;
    },
    /** Read without consuming (the OTP step + resend peek to learn phone/purpose). */
    async peek(token: string): Promise<PendingAuth | null> {
      if (!token) return null;
      return parse(await redis.get(key(token)));
    },
    /** Consume single-use (on a SUCCESSFUL OTP verify), atomically via getdel. */
    async consume(token: string): Promise<PendingAuth | null> {
      if (!token) return null;
      const rec = parse(await redis.getdel(key(token)));
      await redis.del(attemptsKey(token));
      return rec;
    },
    /**
     * Program-Fix 49D: count ONE code attempt against the token (atomic INCR,
     * TTL on the first). Past PENDING_MAX_ATTEMPTS the token is dropped and
     * this returns false, so the caller must start over from the password.
     */
    async countAttempt(token: string): Promise<boolean> {
      if (!token) return false;
      const k = attemptsKey(token);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, TTL_S);
      if (n > PENDING_MAX_ATTEMPTS) {
        await redis.del(key(token));
        await redis.del(k);
        return false;
      }
      return true;
    },
    /** Drop a token and its attempt counter (a stale or voided sign-in). */
    async drop(token: string): Promise<void> {
      if (!token) return;
      await redis.del(key(token));
      await redis.del(attemptsKey(token));
    },
  };
}

export type PendingAuthStore = ReturnType<typeof createPendingAuthStore>;

let cached: PendingAuthStore | null = null;

export function getPendingAuthStore(): PendingAuthStore {
  if (!cached) {
    cached = createPendingAuthStore(getRedis());
  }
  return cached;
}
