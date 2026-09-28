import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { RedisLike } from './store';
import type { PartnerId } from './types';
import { getRedis } from './redis';
import { normalizePhone, isValidPhone } from './phone';
import { isDeviceLabel, UNKNOWN_DEVICE } from './portal-device-label';
import { PORTAL_SESSION_POLICY } from './portal-session-cookie';

export { PORTAL_SESSION_COOKIE, PORTAL_SESSION_POLICY, portalSessionCookieOptions } from './portal-session-cookie';

/**
 * portal-session-store — customer PORTAL sessions (UI redesign M2-2, SPEC §2.1).
 *
 * A session belongs to ONE customer row: (partnerId, phone), the `customers` PK.
 * The same phone under two partners is two unrelated customers with independent
 * sessions, device lists and revocations.
 *
 * Tokens: 256-bit opaque, sent only in the `__Host-sr_portal` cookie. Redis holds
 * sha256(token), never the token. The device index maps a 128-bit `sid` (what the
 * Devices page shows and posts) to the token hash; neither the token nor its hash
 * ever leaves this module.
 *
 * Lifetimes (owner O1 + addendum): 30-day sliding idle, 90-day absolute cap,
 * enforced in code off the injectable clock (Redis TTL is only a backstop).
 * Step-up: `authAtMs` is the last WhatsApp-code proof (login counts), `totpAtMs`
 * the last TOTP proof; `isFresh` requires the proof(s) within 15 minutes.
 *
 * Key schema (no phone, partner id or token in any key):
 *   psess:<sha256(token)>              → JSON record, EX ≤ idle and ≤ the absolute remainder
 *   psess_ix:<sha256(partnerId|phone)> → hash sid → sha256(token), EX = absolute, re-armed on create
 *
 * The index TTL is the ABSOLUTE cap, not the idle window: `resolve` slides only
 * the record, so an idle-length index could expire under a session that is still
 * in use. Every session in the index was created no later than the last re-arm,
 * and none outlives 90 days from creation, so none outlives the index.
 *
 * `resolve` requires the session to still be listed in its customer's index
 * (constant-time compare of the stored hash), so a revoke that removed the index
 * entry but failed to delete the record still ends the session.
 */

export interface PortalSession {
  sid: string;
  partnerId: PartnerId;
  /** Digits only (the `customers` PK format). */
  phone: string;
  createdAtMs: number;
  lastSeenMs: number;
  /** Last WhatsApp-code proof (sign-in or step-up). */
  authAtMs: number;
  /** Last TOTP proof (step-up for an enrolled customer); absent until one happens. */
  totpAtMs?: number;
  /** A closed-set label from portal-device-label; never a raw user agent. */
  device: string;
}

export type PortalDevice = Pick<PortalSession, 'sid' | 'createdAtMs' | 'lastSeenMs' | 'device'>;

export interface FreshnessOptions {
  /** Narrower window than the policy's 15 minutes; a wider value is clamped to the policy. */
  maxAgeMs?: number;
  /** The customer has TOTP enrolled: the TOTP proof must be fresh as well. */
  requireTotp?: boolean;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SID_RE = /^[0-9a-f]{32}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PARTNER_MAX = 128;

const INDEX_TTL_S = Math.ceil(PORTAL_SESSION_POLICY.absoluteMs / 1000);

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const recordKey = (tokenHash: string) => `psess:${tokenHash}`;
// The phone is digits only, so the last '|' separates the two parts unambiguously.
const indexKey = (partnerId: PartnerId, phone: string) => `psess_ix:${sha256hex(`${partnerId}|${phone}`)}`;

function validPartner(partnerId: unknown): partnerId is PartnerId {
  return typeof partnerId === 'string' && partnerId.length > 0 && partnerId.length <= PARTNER_MAX;
}

/** Digits-only phone, or null when it is not a valid number. */
function customerPhone(raw: string): string | null {
  const phone = normalizePhone(raw);
  return isValidPhone(phone) ? phone : null;
}

/** Constant-time equality of two hex digests (false on any shape mismatch). */
function sameHash(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !HASH_RE.test(a) || !HASH_RE.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function parseRecord(raw: string | null): PortalSession | null {
  if (typeof raw !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  if (
    typeof r.sid !== 'string' || !SID_RE.test(r.sid) ||
    !validPartner(r.partnerId) ||
    typeof r.phone !== 'string' || !isValidPhone(r.phone) ||
    !num(r.createdAtMs) || !num(r.lastSeenMs) || !num(r.authAtMs) ||
    (r.totpAtMs !== undefined && !num(r.totpAtMs)) ||
    !isDeviceLabel(r.device)
  ) {
    return null;
  }
  return {
    sid: r.sid,
    partnerId: r.partnerId,
    phone: r.phone,
    createdAtMs: r.createdAtMs as number,
    lastSeenMs: r.lastSeenMs as number,
    authAtMs: r.authAtMs as number,
    ...(r.totpAtMs !== undefined ? { totpAtMs: r.totpAtMs as number } : {}),
    device: r.device,
  };
}

/**
 * HGETALL under `automaticDeserialization:false` (the real client) is a FLAT
 * [field0, value0, ...] array; the in-memory fake returns an object. Accept both.
 */
function indexEntries(raw: unknown): Array<[sid: string, tokenHash: string]> {
  if (!raw) return [];
  const pairs: Array<[string, string]> = Array.isArray(raw)
    ? Array.from({ length: Math.floor(raw.length / 2) }, (_, i) => [String(raw[i * 2]), String(raw[i * 2 + 1])])
    : Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
  return pairs.filter(([sid]) => SID_RE.test(sid));
}

export function createPortalSessionStore(redis: RedisLike, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const P = PORTAL_SESSION_POLICY;

  const isExpired = (r: PortalSession, t: number) =>
    t - r.createdAtMs > P.absoluteMs || t - r.lastSeenMs > P.idleMs;

  /** Redis EX for a record last seen at `t`: the idle window, never past the absolute cap. */
  const recordTtlS = (r: PortalSession, t: number) =>
    Math.max(1, Math.ceil(Math.min(P.idleMs, r.createdAtMs + P.absoluteMs - t) / 1000));

  async function drop(r: PortalSession, tokenHash: string): Promise<void> {
    // Index entry first: with the membership check in `resolve`, that alone ends the session.
    await redis.hdel(indexKey(r.partnerId, r.phone), r.sid);
    await redis.del(recordKey(tokenHash));
  }

  /**
   * The live session for `token` on `hostPartnerId`'s host, or null. The order is
   * fixed: read, parse, PARTNER CHECK (a replay on another tenant's host changes
   * nothing, not even lastSeen), lifetime, index membership.
   */
  async function readLive(
    token: string,
    hostPartnerId: PartnerId,
  ): Promise<{ rec: PortalSession; tokenHash: string; t: number } | null> {
    if (typeof token !== 'string' || !TOKEN_RE.test(token) || !validPartner(hostPartnerId)) return null;
    const tokenHash = sha256hex(token);
    const rec = parseRecord(await redis.get(recordKey(tokenHash)));
    if (!rec) return null;
    if (rec.partnerId !== hostPartnerId) return null;
    const t = now();
    if (isExpired(rec, t)) {
      await drop(rec, tokenHash);
      return null;
    }
    const listed = await redis.hget(indexKey(rec.partnerId, rec.phone), rec.sid);
    if (!sameHash(listed, tokenHash)) return null;
    return { rec, tokenHash, t };
  }

  async function write(rec: PortalSession, tokenHash: string, t: number): Promise<void> {
    await redis.set(recordKey(tokenHash), JSON.stringify(rec), { ex: recordTtlS(rec, t) });
  }

  /** The customer's live sessions (with their token hashes); prunes dead index entries. */
  async function liveSessions(partnerId: PartnerId, phone: string) {
    const ix = indexKey(partnerId, phone);
    const t = now();
    const out: Array<{ rec: PortalSession; tokenHash: string }> = [];
    for (const [sid, tokenHash] of indexEntries(await redis.hgetall(ix))) {
      const rec = HASH_RE.test(tokenHash) ? parseRecord(await redis.get(recordKey(tokenHash))) : null;
      if (!rec || rec.sid !== sid || rec.partnerId !== partnerId || rec.phone !== phone || isExpired(rec, t)) {
        await redis.hdel(ix, sid);
        if (rec && HASH_RE.test(tokenHash)) await redis.del(recordKey(tokenHash));
        continue;
      }
      out.push({ rec, tokenHash });
    }
    return out;
  }

  const store = {
    /**
     * Sign-in: mint a new session (a fresh token and sid). With `replaceToken`
     * (the cookie presented at sign-in), that session is destroyed first:
     * rotation, so a pre-login token never becomes an authenticated one.
     * Beyond `maxSessionsPerCustomer` live sessions, the least recently used are evicted.
     */
    async create(
      partnerId: PartnerId,
      phoneRaw: string,
      device: string,
      replaceToken?: string,
    ): Promise<{ token: string; sid: string }> {
      if (!validPartner(partnerId)) throw new Error('portal session: invalid partner');
      const phone = customerPhone(phoneRaw);
      if (!phone) throw new Error('portal session: invalid phone');
      if (replaceToken) await store.destroy(replaceToken);

      const token = randomBytes(32).toString('hex');
      const sid = randomBytes(16).toString('hex');
      const tokenHash = sha256hex(token);
      const t = now();
      const rec: PortalSession = {
        sid,
        partnerId,
        phone,
        createdAtMs: t,
        lastSeenMs: t,
        authAtMs: t, // sign-in is a WhatsApp-code proof
        device: isDeviceLabel(device) ? device : UNKNOWN_DEVICE,
      };
      const ix = indexKey(partnerId, phone);
      // Index FIRST (a dangling index entry is harmless and pruned; an unindexed
      // record would be unrevocable, and `resolve` refuses it anyway).
      await redis.hset(ix, { [sid]: tokenHash });
      await redis.expire(ix, INDEX_TTL_S);
      await write(rec, tokenHash, t);

      const live = await liveSessions(partnerId, phone);
      const excess = live.length - P.maxSessionsPerCustomer;
      if (excess > 0) {
        const oldest = live
          .filter((s) => s.rec.sid !== sid)
          .sort((a, b) => a.rec.lastSeenMs - b.rec.lastSeenMs || a.rec.createdAtMs - b.rec.createdAtMs)
          .slice(0, excess);
        for (const s of oldest) await drop(s.rec, s.tokenHash);
      }
      return { token, sid };
    },

    /**
     * The session for a cookie token on the host of `hostPartnerId`, or null when
     * the token is malformed or unknown, the session is idle > 30 days or older
     * than 90 days, it was revoked, or it belongs to ANOTHER partner. A live
     * session slides `lastSeenMs`.
     */
    async resolve(token: string, hostPartnerId: PartnerId): Promise<PortalSession | null> {
      const live = await readLive(token, hostPartnerId);
      if (!live) return null;
      const rec: PortalSession = { ...live.rec, lastSeenMs: live.t };
      await write(rec, live.tokenHash, live.t);
      return rec;
    },

    /**
     * Record a successful step-up on this session: the WhatsApp code always, and
     * `totp: true` when a TOTP code was ALSO verified (an enrolled customer).
     * Refuses (false) a malformed/unknown/expired token and another host's session.
     */
    async markStepUp(token: string, hostPartnerId: PartnerId, proof: { totp: boolean }): Promise<boolean> {
      const live = await readLive(token, hostPartnerId);
      if (!live) return false;
      const rec: PortalSession = {
        ...live.rec,
        lastSeenMs: live.t,
        authAtMs: live.t,
        ...(proof.totp === true ? { totpAtMs: live.t } : {}),
      };
      await write(rec, live.tokenHash, live.t);
      return true;
    },

    /**
     * True when the last WhatsApp-code proof (and, with `requireTotp`, the last TOTP
     * proof) is within the step-up window. The window is 15 minutes or the caller's
     * narrower `maxAgeMs`. A stamp in the future is never fresh.
     */
    isFresh(s: PortalSession, o: FreshnessOptions = {}): boolean {
      const t = now();
      const window = Math.min(o.maxAgeMs ?? P.stepUpFreshMs, P.stepUpFreshMs);
      const fresh = (at: number | undefined) =>
        typeof at === 'number' && Number.isFinite(at) && at <= t && t - at <= window;
      return fresh(s.authAtMs) && (o.requireTotp !== true || fresh(s.totpAtMs));
    },

    /** The customer's live devices, most recently active first. Never a token or hash. */
    async list(partnerId: PartnerId, phoneRaw: string): Promise<PortalDevice[]> {
      const phone = customerPhone(phoneRaw);
      if (!validPartner(partnerId) || !phone) return [];
      return (await liveSessions(partnerId, phone))
        .map(({ rec }) => ({ sid: rec.sid, createdAtMs: rec.createdAtMs, lastSeenMs: rec.lastSeenMs, device: rec.device }))
        .sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    },

    /** Sign out ONE device, only from this customer's own index. True when it was listed. */
    async revoke(partnerId: PartnerId, phoneRaw: string, sid: string): Promise<boolean> {
      const phone = customerPhone(phoneRaw);
      if (!validPartner(partnerId) || !phone || typeof sid !== 'string' || !SID_RE.test(sid)) return false;
      const ix = indexKey(partnerId, phone);
      const tokenHash = await redis.hget(ix, sid);
      if (tokenHash === null || tokenHash === undefined) return false;
      await redis.hdel(ix, sid);
      if (HASH_RE.test(tokenHash)) await redis.del(recordKey(tokenHash));
      return true;
    },

    /** Sign out every device of this customer except `exceptSid`. Returns how many live sessions ended. */
    async revokeAll(partnerId: PartnerId, phoneRaw: string, exceptSid?: string): Promise<number> {
      const phone = customerPhone(phoneRaw);
      if (!validPartner(partnerId) || !phone) return 0;
      let n = 0;
      for (const { rec, tokenHash } of await liveSessions(partnerId, phone)) {
        if (rec.sid === exceptSid) continue;
        await drop(rec, tokenHash);
        n++;
      }
      return n;
    },

    /** Sign out this token's session (sign-out, rotation). A malformed or unknown token is a no-op. */
    async destroy(token: string): Promise<void> {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return;
      const tokenHash = sha256hex(token);
      const rec = parseRecord(await redis.get(recordKey(tokenHash)));
      if (rec) await redis.hdel(indexKey(rec.partnerId, rec.phone), rec.sid);
      await redis.del(recordKey(tokenHash));
    },
  };
  return store;
}

export type PortalSessionStore = ReturnType<typeof createPortalSessionStore>;

let cached: PortalSessionStore | null = null;

/** The process-wide store on the shared Upstash client. */
export function getPortalSessionStore(): PortalSessionStore {
  if (!cached) cached = createPortalSessionStore(getRedis());
  return cached;
}
