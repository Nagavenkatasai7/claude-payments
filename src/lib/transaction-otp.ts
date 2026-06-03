import { createHash, randomInt as cryptoRandomInt, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';

/**
 * transaction-otp — a per-transaction step-up code (Phase 3, Part B).
 *
 * A 6-digit code bound to BOTH the transaction id (draftId/transferId) AND the
 * sender phone, so a code issued for one transaction can't authorize another and
 * can't be redirected to a different number. Reuses the same primitives as
 * otp-store (CSPRNG, sha256-at-rest, constant-time compare, attempt cap) but a
 * transaction-scoped key. The code is delivered IN-SESSION (free-form WhatsApp),
 * so it needs no Meta AUTHENTICATION template. Never logged.
 */
const TTL_S = 10 * 60;
const COOLDOWN_S = 30;
const MAX_ATTEMPTS = 5;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const key = (txId: string) => `txotp:${sha(txId)}`;
const cdKey = (txId: string) => `txotp:cd:${sha(txId)}`;

interface Rec {
  codeHash: string;
  phoneHash: string;
  attempts: number;
  expiresAt: number;
}

export type IssueResult = { ok: true; code: string } | { ok: false; reason: 'cooldown' };
export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_code' | 'expired' | 'locked' | 'wrong' };

export interface TxOtpOptions {
  now?: () => number;
  randomInt?: (min: number, max: number) => number;
}

export function createTransactionOtpStore(redis: RedisLike, opts: TxOtpOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const randomInt = opts.randomInt ?? ((min: number, max: number) => cryptoRandomInt(min, max));

  return {
    async issue(txId: string, phone: string): Promise<IssueResult> {
      if (await redis.get(cdKey(txId))) return { ok: false, reason: 'cooldown' };
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const rec: Rec = {
        codeHash: sha(code),
        phoneHash: sha(phone),
        attempts: 0,
        expiresAt: now() + TTL_S * 1000,
      };
      await redis.set(key(txId), JSON.stringify(rec), { ex: TTL_S });
      await redis.set(cdKey(txId), '1', { ex: COOLDOWN_S });
      return { ok: true, code }; // caller delivers it; never logged here
    },

    async verify(txId: string, phone: string, code: string): Promise<VerifyResult> {
      const raw = await redis.get(key(txId));
      if (!raw) return { ok: false, reason: 'no_code' };
      let rec: Rec;
      try {
        rec = JSON.parse(raw) as Rec;
      } catch {
        return { ok: false, reason: 'no_code' };
      }
      if (now() > rec.expiresAt) {
        await redis.del(key(txId));
        return { ok: false, reason: 'expired' };
      }
      if (rec.attempts >= MAX_ATTEMPTS) {
        await redis.del(key(txId));
        return { ok: false, reason: 'locked' };
      }
      const okPhone = sha(phone) === rec.phoneHash;
      const a = Buffer.from(sha(code), 'utf8');
      const b = Buffer.from(rec.codeHash, 'utf8');
      const okCode = a.length === b.length && timingSafeEqual(a, b);
      if (okPhone && okCode) {
        await redis.del(key(txId)); // single-use
        return { ok: true };
      }
      rec.attempts += 1;
      await redis.set(key(txId), JSON.stringify(rec), { ex: TTL_S });
      return { ok: false, reason: 'wrong' };
    },
  };
}

export type TransactionOtpStore = ReturnType<typeof createTransactionOtpStore>;

let cached: TransactionOtpStore | null = null;

export function getTransactionOtpStore(): TransactionOtpStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createTransactionOtpStore(redis as unknown as RedisLike);
  }
  return cached;
}
