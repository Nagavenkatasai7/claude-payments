import { Redis } from '@upstash/redis';
import { createHash, randomBytes } from 'node:crypto';
import { env } from './env';
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

export type AuthPurpose = 'login' | 'register' | 'reset';

interface PendingRecord {
  phone: string;
  purpose: AuthPurpose;
  createdMs: number;
}

const TTL_S = 300; // 5 minutes

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function key(token: string): string {
  return `pending:${sha256hex(token)}`;
}

export function createPendingAuthStore(redis: RedisLike, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  function parse(raw: string | null): { phone: string; purpose: AuthPurpose } | null {
    if (!raw) return null;
    let rec: PendingRecord;
    try {
      rec = JSON.parse(raw) as PendingRecord;
    } catch {
      return null;
    }
    if (now() - rec.createdMs > TTL_S * 1000) return null; // expired (in-code guard)
    return { phone: rec.phone, purpose: rec.purpose };
  }

  return {
    /** Mint a single-use token AFTER a prior factor is proven. */
    async create(phone: string, purpose: AuthPurpose): Promise<string> {
      const token = randomBytes(32).toString('hex');
      const rec: PendingRecord = { phone, purpose, createdMs: now() };
      await redis.set(key(token), JSON.stringify(rec), { ex: TTL_S });
      return token;
    },
    /** Read without consuming (the OTP step + resend peek to learn phone/purpose). */
    async peek(token: string): Promise<{ phone: string; purpose: AuthPurpose } | null> {
      if (!token) return null;
      return parse(await redis.get(key(token)));
    },
    /** Consume single-use (on a SUCCESSFUL OTP verify), atomically via getdel. */
    async consume(token: string): Promise<{ phone: string; purpose: AuthPurpose } | null> {
      if (!token) return null;
      return parse(await redis.getdel(key(token)));
    },
  };
}

export type PendingAuthStore = ReturnType<typeof createPendingAuthStore>;

let cached: PendingAuthStore | null = null;

export function getPendingAuthStore(): PendingAuthStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createPendingAuthStore(redis as unknown as RedisLike);
  }
  return cached;
}
