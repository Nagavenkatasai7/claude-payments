import { getRedis } from './redis';
import { createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from './store';
import { SUPPORT_DEFAULT_PERMISSIONS, type Staff, type StaffPermissions, type StaffRole } from './types';
import { isSeedAdminRecord, seedAdminUsername } from './staff-login-guard';
import { logWarn } from './log';
import { createStaffRepo, type StaffRepo } from '@/db/repos/staff-repo';
import { getDb } from '@/db/client';

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

// ── Program-Fix 45 P5 (crypto-03): the staff ledger (Postgres `staff`, 0022) ──
//
// DUAL-WRITE RELEASE. The previous build reads and writes only Redis, so for
// this release:
//   • a record EXISTS only while its Redis record exists (a row alone is never
//     a login: an old-build delete must not resurrect anyone, and a Redis flush
//     still re-seeds the seed admin because listStaff walks the Redis index);
//   • the row can only RESTRICT the Redis record (mergeStaffRecords), because an
//     old-build suspend lands only in Redis and a row must never grant;
//   • the seed admin's platform-admin Redis record is never restricted by its
//     row (owner rule: nothing locks out the seed admin; a Redis writer already
//     controls that account's hash, so the exemption adds no reach);
//   • any ledger READ failure falls back to the Redis record, the pre-P5
//     behaviour, so a Neon blip never signs staff out;
//   • saveStaff writes the row FIRST and throws on failure, so a change is
//     never reported done while one store still holds the old state;
//     deleteStaff removes the Redis record FIRST (existence), then the row
//     (best-effort: an orphan row is never a member); login-path writes
//     (lastLoginAt, the password mirror) are best-effort.
// The row's password_hash is a MIRROR that nothing reads yet. The PG-first flip
// (and the atomic password compare-and-set it enables) is a later PR.

/** The ledger surface auth-store uses (the staff-repo). */
export type StaffLedger = Pick<
  StaffRepo,
  'getMany' | 'upsert' | 'insertIfMissing' | 'remove' | 'setLastLogin' | 'setPasswordHash'
>;

export interface AuthStoreOptions {
  /** Resolved on first use, so a store built without a database never touches one. */
  ledger?: () => StaffLedger;
  /** SEED_ADMIN_USERNAME ('' when unset); injectable for tests. */
  seedName?: () => string;
}

export interface SaveStaffOptions {
  /** Seed path only: a ledger failure is logged and the Redis record still lands. */
  ledgerBestEffort?: boolean;
}

/**
 * Role merge. admin is above both others, but agent and support are
 * INCOMPARABLE: support has surfaces agents lack (the global ticket queue,
 * requireSupportOrAdmin, the copilot triage/review routes) and agents have
 * money surfaces support lacks. So admin vs X → X, and agent vs support is a
 * disagreement that fails closed (suspended, Redis role kept), like partner
 * scope. Returns the role and whether to suspend.
 */
function mergeRole(fromRedis: StaffRole, fromLedger: StaffRole): { role: StaffRole; suspend: boolean } {
  if (fromRedis === fromLedger) return { role: fromRedis, suspend: false };
  if (fromRedis === 'admin') return { role: fromLedger, suspend: false };
  if (fromLedger === 'admin') return { role: fromRedis, suspend: false };
  return { role: fromRedis, suspend: true };
}

function andPermissions(a: StaffPermissions, b: StaffPermissions): StaffPermissions {
  return {
    canCancel: a.canCancel === true && b.canCancel === true,
    canResend: a.canResend === true && b.canResend === true,
    canAssign: a.canAssign === true && b.canAssign === true,
    canRevealPii: a.canRevealPii === true && b.canRevealPii === true,
  };
}

/**
 * The most restrictive view of one staff member across the two stores.
 * Identity, name, password hash and timestamps come from Redis (the store both
 * builds write). Status: suspended if either says so. Role: admin vs a lower
 * role takes the lower one; agent vs support (incomparable) suspends and keeps
 * the Redis role; a support result carries no permissions.
 * Permissions: per-key AND. Partner scope: Redis's; a row naming a different
 * partner (or one where Redis says platform) fails closed (suspended). The seed admin's
 * platform-admin record is returned unchanged.
 */
export function mergeStaffRecords(fromRedis: Staff, fromLedger: Staff | null, seedName: string): Staff {
  if (!fromLedger || isSeedAdminRecord(fromRedis, seedName)) return fromRedis;
  const merged: Staff = { ...fromRedis };
  const { role, suspend: roleConflict } = mergeRole(fromRedis.role, fromLedger.role);
  merged.role = role;
  merged.permissions =
    role === 'support' ? { ...SUPPORT_DEFAULT_PERMISSIONS } : andPermissions(fromRedis.permissions, fromLedger.permissions);
  if (fromRedis.status === 'suspended' || fromLedger.status === 'suspended' || roleConflict) {
    merged.status = 'suspended';
  }
  // Partner scope always comes from Redis. A row that disagrees (a different
  // partner, or a partner where Redis says platform) fails closed: suspended,
  // never re-scoped, so a merged record can never pass as another tenant's
  // staff (the partner-staff removal guard, the platform-admin counts). A
  // platform row under a partner-scoped Redis record is simply narrower.
  if (fromLedger.partnerId !== undefined && fromLedger.partnerId !== fromRedis.partnerId) {
    merged.status = 'suspended';
  }
  return merged;
}

function sameAccess(a: Staff, b: Staff): boolean {
  return (
    a.role === b.role &&
    (a.status ?? 'active') === (b.status ?? 'active') &&
    a.partnerId === b.partnerId &&
    // andPermissions(p, p) normalises absent keys to false before comparing.
    JSON.stringify(andPermissions(a.permissions, a.permissions)) ===
      JSON.stringify(andPermissions(b.permissions, b.permissions))
  );
}

/** A short, non-reversible tag so ops can tell restricted members apart without a name in the logs. */
function userTag(username: string): string {
  return sha256hex(username).slice(0, 12);
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'unknown';
}

export function createAuthStore(redis: RedisLike, opts: AuthStoreOptions = {}) {
  const seedName = opts.seedName ?? seedAdminUsername;
  let ledgerCache: StaffLedger | null = null;
  const ledger = (): StaffLedger | null => {
    if (!opts.ledger) return null;
    if (!ledgerCache) ledgerCache = opts.ledger();
    return ledgerCache;
  };

  async function readRedisStaff(username: string): Promise<Staff | null> {
    const raw = await redis.get(`staff:${username}`);
    return raw ? (JSON.parse(raw) as Staff) : null;
  }

  /** Merge Redis records with their rows; copy the missing rows in. Never throws on the ledger. */
  async function withLedger(records: Staff[]): Promise<Staff[]> {
    if (records.length === 0 || !opts.ledger) return records;
    let rows: Map<string, Staff>;
    try {
      rows = await ledger()!.getMany(records.map((r) => r.username));
    } catch (e) {
      logWarn('staff_ledger.read_failed', 'staff ledger read failed; using the Redis record', { error: errName(e) });
      return records;
    }
    const missing = records.filter((r) => !rows.has(r.username));
    if (missing.length > 0) {
      try {
        await ledger()!.insertIfMissing(missing);
      } catch {
        // One bad record (e.g. a partner id with no partners row) must not
        // stop the rest: retry row by row, counting the refusals.
        let failed = 0;
        for (const m of missing) {
          try {
            await ledger()!.insertIfMissing([m]);
          } catch {
            failed++;
          }
        }
        if (failed > 0) logWarn('staff_ledger.copy_failed', 'staff ledger copy-on-read failed', { count: failed });
      }
    }
    const seed = seedName();
    return records.map((r) => {
      const merged = mergeStaffRecords(r, rows.get(r.username) ?? null, seed);
      const row = rows.get(r.username);
      if (row && !sameAccess(merged, r)) {
        logWarn('staff_ledger.restricted', 'staff record restricted by the ledger row', { user: userTag(r.username) });
      } else if (row && isSeedAdminRecord(r, seed) && !sameAccess(r, row)) {
        logWarn('staff_ledger.seed_divergence', 'seed admin ledger row differs from Redis; Redis record used', {
          user: userTag(r.username),
        });
      }
      return merged;
    });
  }

  /** A best-effort ledger mirror: logged, never thrown. */
  async function mirror(what: string, fn: (l: StaffLedger) => Promise<void>): Promise<void> {
    if (!opts.ledger) return;
    try {
      await fn(ledger()!);
    } catch (e) {
      logWarn('staff_ledger.mirror_failed', `staff ledger ${what} mirror failed`, { error: errName(e) });
    }
  }

  return {
    async getStaff(username: string): Promise<Staff | null> {
      const fromRedis = await readRedisStaff(username);
      if (!fromRedis) return null;
      return (await withLedger([fromRedis]))[0];
    },
    async saveStaff(staff: Staff, saveOpts: SaveStaffOptions = {}): Promise<void> {
      // Row FIRST (see the header): a failure throws before Redis changes,
      // unless the caller is the seed path, which must always land.
      if (opts.ledger) {
        if (saveOpts.ledgerBestEffort) await mirror('seed upsert', (l) => l.upsert(staff));
        else {
          try {
            await ledger()!.upsert(staff);
          } catch (e) {
            // drizzle's DrizzleQueryError message carries the query PARAMS
            // (password hash, username, name). Never let it reach a caller or
            // a log: rethrow a bare error with no cause, log the class only.
            logWarn('staff_ledger.write_failed', 'staff ledger write failed', { error: errName(e) });
            throw new Error('staff ledger write failed');
          }
        }
      }
      await redis.set(`staff:${staff.username}`, JSON.stringify(staff));
      await redis.sadd('staff:index', staff.username);
    },
    async listStaff(): Promise<Staff[]> {
      // The Redis index decides who exists (a row alone is never a member).
      const usernames = await redis.smembers('staff:index');
      const all = (await Promise.all(usernames.map((u) => readRedisStaff(u)))).filter(
        (s): s is Staff => s !== null,
      );
      return (await withLedger(all)).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    },
    async deleteStaff(username: string): Promise<void> {
      // Redis FIRST: it decides existence, the row only restricts. Removing the
      // row first would briefly lift a restriction from a member who still
      // exists (and forever, if the Redis delete then failed). A row left
      // behind by a failed removal is never a member (logged, not thrown).
      await redis.del(`staff:${username}`);
      await redis.srem('staff:index', username);
      await mirror('remove', (l) => l.remove(username));
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
      const at = staff.lastLoginAt;
      await mirror('lastLoginAt', (l) => l.setLastLogin(username, at));
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
      await mirror('password', (l) => l.setPasswordHash(username, newHash));
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
      await mirror('password', (l) => l.setPasswordHash(username, newHash));
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
    // Program-Fix 45 P5: the Postgres staff ledger rides along, resolved on
    // first use (a failure to reach it degrades to the Redis-only behaviour).
    cached = createAuthStore(getRedis(), { ledger: () => createStaffRepo(getDb()) });
  }
  return cached;
}
