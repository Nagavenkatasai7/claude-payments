import { createHash } from 'node:crypto';
import type { RedisLike } from './store';
import type { PartnerId } from './types';
import { getRedis } from './redis';

/**
 * portal-totp-budget — UI redesign M2-14 (PR 394 L2). A per-(partner, phone) daily budget of
 * authenticator-code attempts across portal sign-in and step-up. The pending token's own cap
 * (PORTAL_PENDING_MAX_ATTEMPTS) restarts with every token; this one does not, so the 6-digit
 * factor can't be guessed across many tokens.
 *
 * - reserve(): an atomic INCR BEFORE the compare (a parallel burst can't all read a stale count);
 *   false at the ceiling, and the caller compares nothing.
 * - refund(): a SUCCESS gives its unit back, so only failures consume the budget.
 * - Key `ptotp:fail:<partner>:<sha(digits)>:<utc-day>`: never the raw phone; TTL outlives the day.
 * - A Redis error propagates: callers fail closed (no compare, cant_send).
 * Accepted (as L1, H2): someone who knows a phone AND holds its WhatsApp codes can exhaust it.
 */
export const PORTAL_TOTP_FAILS_PER_DAY = 10;
const DAY_MS = 86_400_000;
const TTL_S = 2 * 86_400;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const keySafe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);

export function createPortalTotpBudget(redis: RedisLike, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const key = (partnerId: PartnerId, phone: string) =>
    `ptotp:fail:${keySafe(partnerId)}:${sha(phone.replace(/\D/g, ''))}:${Math.floor(now() / DAY_MS)}`;
  return {
    async reserve(partnerId: PartnerId, phone: string): Promise<boolean> {
      const k = key(partnerId, phone);
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, TTL_S);
      return n <= PORTAL_TOTP_FAILS_PER_DAY;
    },
    async refund(partnerId: PartnerId, phone: string): Promise<void> {
      // A refund just past UTC midnight lands on the NEW day's key: never leave it negative (and TTL-less).
      const k = key(partnerId, phone);
      if ((await redis.decr(k)) < 0) await redis.del(k);
    },
  };
}

export type PortalTotpBudget = ReturnType<typeof createPortalTotpBudget>;

let cached: PortalTotpBudget | null = null;
export function getPortalTotpBudget(): PortalTotpBudget {
  return (cached ??= createPortalTotpBudget(getRedis()));
}
