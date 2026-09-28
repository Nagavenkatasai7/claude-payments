import { createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from './store';
import type { PartnerId } from './types';
import { getRedis } from './redis';
import { isValidPhone, normalizePhone } from './phone';

/**
 * portal-pending-store — the single-use token that carries a customer-portal sign-in (or step-up)
 * between its steps (UI redesign M2-5). Its own module (the plan put it inside
 * portal-session-store.ts; a separate file keeps that reviewed module unchanged).
 *
 * - The token is 256-bit hex and goes to the browser in a hidden field. Redis holds only
 *   sha256(token): `ppend:<hash>` → JSON record, `ppend_n:<hash>` → attempt counter.
 * - The record carries the partner, the NORMALIZED phone (the exact digits every later step uses)
 *   and the purpose. peek() requires the host partner and the purpose to match, so a token minted
 *   on partner A's site is dead on partner B's. The phone never leaves the server.
 * - Lifetimes are enforced in code off the injectable clock (the Redis TTL is only a backstop).
 */

export type PortalPendingPurpose = 'login' | 'mfa' | 'consent' | 'stepup';

export interface PortalPending {
  partnerId: PartnerId;
  phone: string;
  purpose: PortalPendingPurpose;
  createdMs: number;
  /** stepup only: the session this proof is for. */
  sid?: string;
}

/** Wrong codes allowed per token before the flow restarts. */
export const PORTAL_PENDING_MAX_ATTEMPTS = 5;

const TTL_MS: Record<PortalPendingPurpose, number> = {
  login: 300_000, // the code's own life
  stepup: 300_000,
  mfa: 600_000,
  consent: 600_000,
};

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SID_RE = /^[0-9a-f]{32}$/;
const PURPOSES: ReadonlySet<string> = new Set(['login', 'mfa', 'consent', 'stepup']);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const recKey = (h: string) => `ppend:${h}`;
const cntKey = (h: string) => `ppend_n:${h}`;

function parse(raw: string | null): PortalPending | null {
  if (typeof raw !== 'string') return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof r.partnerId !== 'string' || !r.partnerId ||
      typeof r.phone !== 'string' || !isValidPhone(r.phone) ||
      typeof r.purpose !== 'string' || !PURPOSES.has(r.purpose) ||
      typeof r.createdMs !== 'number' || !Number.isFinite(r.createdMs) ||
      (r.sid !== undefined && (typeof r.sid !== 'string' || !SID_RE.test(r.sid)))
    ) {
      return null;
    }
    return {
      partnerId: r.partnerId,
      phone: r.phone,
      purpose: r.purpose as PortalPendingPurpose,
      createdMs: r.createdMs,
      ...(r.sid !== undefined ? { sid: r.sid as string } : {}),
    };
  } catch {
    return null;
  }
}

export function createPortalPendingStore(redis: RedisLike, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  return {
    async create(input: { partnerId: PartnerId; phone: string; purpose: PortalPendingPurpose; sid?: string }): Promise<string> {
      const phone = normalizePhone(input.phone);
      if (!input.partnerId || !isValidPhone(phone)) throw new Error('portal pending: invalid input');
      if (input.sid !== undefined && !SID_RE.test(input.sid)) throw new Error('portal pending: invalid sid');
      const token = randomBytes(32).toString('hex');
      const rec: PortalPending = {
        partnerId: input.partnerId,
        phone,
        purpose: input.purpose,
        createdMs: now(),
        ...(input.sid !== undefined ? { sid: input.sid } : {}),
      };
      await redis.set(recKey(sha(token)), JSON.stringify(rec), { ex: Math.ceil(TTL_MS[input.purpose] / 1000) + 60 });
      return token;
    },

    /** The live record for this host partner and purpose, else null. */
    async peek(token: unknown, hostPartnerId: PartnerId, purpose: PortalPendingPurpose): Promise<PortalPending | null> {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const rec = parse(await redis.get(recKey(sha(token))));
      if (!rec || rec.partnerId !== hostPartnerId || rec.purpose !== purpose) return null;
      if (now() - rec.createdMs > TTL_MS[rec.purpose] || now() < rec.createdMs) return null;
      return rec;
    },

    /** One more attempt against this token (TTL attached at creation: SET NX EX, then INCR). */
    async countAttempt(token: string): Promise<number> {
      const k = cntKey(sha(token));
      await redis.set(k, '0', { nx: true, ex: 900 });
      return redis.incr(k);
    },

    /** Single-use: drop the record and its counter. */
    async consume(token: string): Promise<void> {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return;
      const h = sha(token);
      await redis.del(recKey(h));
      await redis.del(cntKey(h));
    },
  };
}

export type PortalPendingStore = ReturnType<typeof createPortalPendingStore>;

let cached: PortalPendingStore | null = null;
export function getPortalPendingStore(): PortalPendingStore {
  return (cached ??= createPortalPendingStore(getRedis()));
}
