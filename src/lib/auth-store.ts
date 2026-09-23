import { getRedis } from './redis';
import { createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from './store';
import type { Staff } from './types';

// Program-Fix 45 P1 (sec-11 / crypto-10): a staff session lives at most 12 h
// (absolute) and ends after 30 min without a request (idle), the same windows
// as the customer store. Both are enforced IN CODE from the seen record below;
// the Redis TTLs are the backstop.
const IDLE_MS = 30 * 60 * 1000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = ABSOLUTE_MS / 1000;
/** lastSeenMs is rewritten at most once a minute (one Redis write per minute per active session). */
const SEEN_REFRESH_MS = 60 * 1000;
/**
 * The seen record always outlives its session record by this much, so a live
 * session record WITHOUT a seen record can only be one the previous build
 * minted (adopted once below), never one whose seen record just expired.
 */
const SEEN_GRACE_SECONDS = 60 * 60;
/**
 * The per-user revoke index keeps the pre-45 7-day TTL: it must outlive every
 * session either build mints during a rolling release (the previous build
 * still writes 7-day records), or revoke-all could miss one.
 */
const SESSION_INDEX_TTL_SECONDS = 7 * 24 * 60 * 60;

// Program-Fix 20 (F57): Redis never holds a usable bearer token. The record is
// keyed by sha256(token) and the per-user revoke index holds hashes, so a Redis
// read (dump, console, leaked REST token) yields nothing replayable as the
// staff session cookie. The plaintext token lives only in that cookie.
const sessionKey = (tokenHash: string) => `staff_sess:${tokenHash}`;
const sessionIndex = (username: string) => `staff_sess_ix:${username}`;
// Program-Fix 45 P1: `<createdAtMs>:<lastSeenMs>` beside the session record.
// The record itself stays `username` (the value the previous build reads).
const seenKey = (tokenHash: string) => `staff_sess_seen:${tokenHash}`;
// Pre-fix-20 schema (plaintext). NEVER read for auth: revoke paths delete them,
// and scripts/purge-legacy-session-keys.ts sweeps what is left after deploy.
const legacySessionKey = (token: string) => `session:${token}`;
const legacySessionIndex = (username: string) => `staff_sessions:${username}`;

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function formatSeen(createdAtMs: number, lastSeenMs: number): string {
  return `${createdAtMs}:${lastSeenMs}`;
}

/** Null when the value is not two non-negative integers (treated as revoked, never adopted). */
function parseSeen(raw: string): { createdAtMs: number; lastSeenMs: number } | null {
  const m = /^(\d{1,15}):(\d{1,15})$/.exec(raw);
  if (!m) return null;
  return { createdAtMs: Number(m[1]), lastSeenMs: Number(m[2]) };
}

/** Seen-record TTL: what is left of the absolute window, plus the grace. */
function seenTtlSeconds(createdAtMs: number, now: number): number {
  return Math.max(1, Math.ceil((createdAtMs + ABSOLUTE_MS - now) / 1000)) + SEEN_GRACE_SECONDS;
}

export function createAuthStore(redis: RedisLike) {
  return {
    async getStaff(username: string): Promise<Staff | null> {
      const raw = await redis.get(`staff:${username}`);
      return raw ? (JSON.parse(raw) as Staff) : null;
    },
    async saveStaff(staff: Staff): Promise<void> {
      await redis.set(`staff:${staff.username}`, JSON.stringify(staff));
      await redis.sadd('staff:index', staff.username);
    },
    async listStaff(): Promise<Staff[]> {
      const usernames = await redis.smembers('staff:index');
      const all = await Promise.all(
        usernames.map((u) => this.getStaff(u)),
      );
      return all
        .filter((s): s is Staff => s !== null)
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    },
    async deleteStaff(username: string): Promise<void> {
      await redis.del(`staff:${username}`);
      await redis.srem('staff:index', username);
    },
    /**
     * Stamp lastLoginAt on the freshest record only. Re-reads inside the call so a
     * stale snapshot from earlier in the login request can't resurrect a record an
     * admin just suspended (the full-object SET race). No-op if missing/suspended.
     */
    async recordLogin(username: string): Promise<void> {
      const raw = await redis.get(`staff:${username}`);
      if (!raw) return;
      const staff = JSON.parse(raw) as Staff;
      if (staff.status === 'suspended') return;
      staff.lastLoginAt = new Date().toISOString();
      await redis.set(`staff:${username}`, JSON.stringify(staff));
    },
    /**
     * Fix 21 lazy scrypt → Argon2id upgrade after a successful login, as a
     * COMPARE-AND-SET (Program-Fix 17a): re-reads the FRESH record and writes
     * only when its hash still equals `expectedOldHash` (the one the login just
     * verified), so an admin reset or a password change that lands between the
     * verify and this write is never reverted to the old password. A missing or
     * suspended record is left untouched (no resurrection). Returns whether it
     * wrote.
     *
     * RESIDUAL (stated in PR 17a): this is GET → compare → SET over the REST
     * client, NOT atomic — RedisLike has no `eval`. The window is the few ms
     * between the GET and the SET. The atomic fix (Lua, or staff in Postgres)
     * belongs to fix 45.
     */
    async updatePasswordHash(username: string, expectedOldHash: string, newHash: string): Promise<boolean> {
      const raw = await redis.get(`staff:${username}`);
      if (!raw) return false;
      const staff = JSON.parse(raw) as Staff;
      if (staff.status === 'suspended') return false;
      if (staff.passwordHash !== expectedOldHash) return false;
      staff.passwordHash = newHash;
      await redis.set(`staff:${username}`, JSON.stringify(staff));
      return true;
    },
    /**
     * Program-Fix 17a: the password CHANGE / RESET write. Same compare-and-set
     * as updatePasswordHash (and the same non-atomic residual), but it also
     * applies to a SUSPENDED record — an admin may reset a suspended member's
     * password — and it never changes `status` (a reset does not reactivate).
     * Only `passwordHash` changes on the fresh record. Returns whether it wrote;
     * callers surface `false` ("changed concurrently"), never swallow it.
     */
    async setPasswordHash(username: string, expectedOldHash: string, newHash: string): Promise<boolean> {
      const raw = await redis.get(`staff:${username}`);
      if (!raw) return false;
      const staff = JSON.parse(raw) as Staff;
      if (staff.passwordHash !== expectedOldHash) return false;
      staff.passwordHash = newHash;
      await redis.set(`staff:${username}`, JSON.stringify(staff));
      return true;
    },
    async createSession(username: string): Promise<string> {
      const token = randomBytes(32).toString('hex');
      const h = sha256hex(token);
      const now = Date.now();
      // Index FIRST: if a later write fails, a dangling index hash is harmless,
      // whereas a live record missing from the index would escape revoke-all.
      await redis.sadd(sessionIndex(username), h);
      // Re-armed on every add, so it expires after every session it lists.
      await redis.expire(sessionIndex(username), SESSION_INDEX_TTL_SECONDS);
      // Seen record BEFORE the session record: a live session record then
      // always has one (a failure in between leaves only a harmless orphan).
      await redis.set(seenKey(h), formatSeen(now, now), { ex: seenTtlSeconds(now, now) });
      await redis.set(sessionKey(h), username, { ex: SESSION_TTL_SECONDS });
      return token;
    },
    /**
     * The username behind a live session, or null. Program-Fix 45 P1: refuses
     * (and revokes) a session idle for more than 30 min or older than 12 h,
     * and refreshes lastSeen at most once a minute, re-arming the seen record
     * to what is left of the absolute window (never a fresh 12 h). A session
     * record with no seen record was minted by the previous build: it is
     * adopted ONCE, from now, and its record capped at 12 h.
     */
    async getSessionUser(token: string): Promise<string | null> {
      const h = sha256hex(token);
      const username = await redis.get(sessionKey(h));
      if (!username) return null;
      const now = Date.now();
      const raw = await redis.get(seenKey(h));
      if (raw === null) {
        await redis.set(seenKey(h), formatSeen(now, now), { ex: seenTtlSeconds(now, now) });
        await redis.expire(sessionKey(h), SESSION_TTL_SECONDS);
        return username;
      }
      const seen = parseSeen(raw);
      if (!seen || now - seen.createdAtMs > ABSOLUTE_MS || now - seen.lastSeenMs > IDLE_MS) {
        // Session record FIRST: if the second delete fails, what is left is
        // "no session", never "a session with no seen record" (re-adoptable).
        await redis.del(sessionKey(h));
        await redis.del(seenKey(h));
        await redis.srem(sessionIndex(username), h);
        return null;
      }
      if (now - seen.lastSeenMs >= SEEN_REFRESH_MS) {
        await redis.set(seenKey(h), formatSeen(seen.createdAtMs, now), {
          ex: seenTtlSeconds(seen.createdAtMs, now),
        });
      }
      return username;
    },
    async deleteSession(token: string): Promise<void> {
      const h = sha256hex(token);
      const username = await redis.get(sessionKey(h));
      await redis.del(sessionKey(h));
      await redis.del(seenKey(h));
      if (username) await redis.srem(sessionIndex(username), h);
      // A pre-fix cookie signing out: drop its plaintext key too (never read).
      await redis.del(legacySessionKey(token));
    },
    /** Revoke every session for a user: the hashed index AND any legacy plaintext one. */
    async deleteAllSessionsFor(username: string): Promise<void> {
      const hashes = await redis.smembers(sessionIndex(username));
      for (const h of hashes) {
        await redis.del(sessionKey(h));
        await redis.del(seenKey(h));
      }
      const legacyTokens = await redis.smembers(legacySessionIndex(username));
      for (const t of legacyTokens) await redis.del(legacySessionKey(t));
      await redis.del(sessionIndex(username));
      await redis.del(legacySessionIndex(username));
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;

let cached: AuthStore | null = null;

export function getAuthStore(): AuthStore {
  if (!cached) {
    cached = createAuthStore(getRedis());
  }
  return cached;
}
