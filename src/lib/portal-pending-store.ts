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

export type PortalPendingPurpose = 'login' | 'mfa' | 'consent' | 'stepup' | 'stepup_totp';

export interface PortalPending {
  partnerId: PartnerId;
  phone: string;
  purpose: PortalPendingPurpose;
  createdMs: number;
  /** stepup / stepup_totp: the session this proof is for. */
  sid?: string;
}

/** Wrong codes allowed per token before the flow restarts. */
export const PORTAL_PENDING_MAX_ATTEMPTS = 5;

const TTL_MS: Record<PortalPendingPurpose, number> = {
  login: 300_000, // the code's own life
  stepup: 300_000,
  mfa: 600_000,
  consent: 600_000,
  stepup_totp: 600_000,
};

/**
 * M2-14 (#394 L7): "Send a new code" restarts a code-carrying token's clock (the new code has its own
 * 5 minutes), up to this cap from creation. Kept in a SEPARATE key (`ppend_x:`), so an extend racing
 * a consume can never re-create the record; an old build ignores it (a shorter life only).
 */
const EXTENDABLE: ReadonlySet<PortalPendingPurpose> = new Set(['login', 'stepup']);
const MAX_EXTENDED_LIFE_MS = 30 * 60_000;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SID_RE = /^[0-9a-f]{32}$/;
const PURPOSES: ReadonlySet<string> = new Set(['login', 'mfa', 'consent', 'stepup', 'stepup_totp']);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const recKey = (h: string) => `ppend:${h}`;
const cntKey = (h: string) => `ppend_n:${h}`;
const extKey = (h: string) => `ppend_x:${h}`;

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
  /** Within its logical life: from the later of creation and the last extend, never past the cap. */
  async function live(rec: PortalPending, h: string, extRaw?: string | null): Promise<boolean> {
    const t = now();
    if (t < rec.createdMs) return false;
    let start = rec.createdMs;
    if (EXTENDABLE.has(rec.purpose)) {
      if (t - rec.createdMs > MAX_EXTENDED_LIFE_MS) return false;
      const ext = Number(extRaw === undefined ? await redis.get(extKey(h)) : extRaw);
      if (Number.isFinite(ext) && ext > start && ext <= t) start = ext;
    }
    return t - start <= TTL_MS[rec.purpose];
  }
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
      const h = sha(token);
      const rec = parse(await redis.get(recKey(h)));
      if (!rec || rec.partnerId !== hostPartnerId || rec.purpose !== purpose) return null;
      if (!(await live(rec, h))) return null;
      return rec;
    },

    /**
     * M2-14 (#394 L7): restart a live login / step-up token's clock after a resend (capped at 30
     * minutes from creation). Returns whether it extended. Never touches the record itself.
     */
    async extend(token: unknown, hostPartnerId: PartnerId, purpose: PortalPendingPurpose): Promise<boolean> {
      if (!EXTENDABLE.has(purpose) || typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
      const h = sha(token);
      const rec = parse(await redis.get(recKey(h)));
      if (!rec || rec.partnerId !== hostPartnerId || rec.purpose !== purpose) return false;
      if (!(await live(rec, h))) return false;
      const ttlS = Math.ceil(MAX_EXTENDED_LIFE_MS / 1000) + 60;
      await redis.set(extKey(h), String(now()), { ex: ttlS });
      await redis.expire(recKey(h), ttlS);
      await redis.expire(cntKey(h), ttlS); // the per-token attempt count survives the longer life
      // A consume that raced this extend: drop the marker again (the record stays gone either way).
      if (!(await redis.exists(recKey(h)))) await redis.del(extKey(h));
      return true;
    },

    /**
     * ATOMIC single-use: GETDEL the record, then validate it (partner, purpose, lifetime). The first
     * caller wins; a concurrent second caller (a double submit) gets null. A mismatched take burns
     * the token too.
     */
    async take(token: unknown, hostPartnerId: PartnerId, purpose: PortalPendingPurpose): Promise<PortalPending | null> {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const h = sha(token);
      const rec = parse(await redis.getdel(recKey(h)));
      await redis.del(cntKey(h));
      const ext = await redis.getdel(extKey(h));
      if (!rec || rec.partnerId !== hostPartnerId || rec.purpose !== purpose) return null;
      if (!(await live(rec, h, ext))) return null;
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
      await redis.del(extKey(h));
    },
  };
}

export type PortalPendingStore = ReturnType<typeof createPortalPendingStore>;

let cached: PortalPendingStore | null = null;
export function getPortalPendingStore(): PortalPendingStore {
  return (cached ??= createPortalPendingStore(getRedis()));
}
