import { createHash, randomBytes } from 'node:crypto';
import { getRedis } from './redis';
import type { RedisLike } from './store';
import type { PartnerId, StaffRole } from './types';

// staff-invite-store — UI redesign M3-8. A partner admin's invitation for a new teammate: a 72 h,
// SINGLE-USE capability, the same class as OTPs and the onboarding token, so it lives in Redis
// (hot/ephemeral, CLAUDE.md). Durability comes from the audit rows and the sealed outbox email in
// Postgres; a lost invite is simply re-sent.
//
//   - The raw token (256-bit CSPRNG, base64url, 43 chars) exists ONLY in the emailed link. Redis
//     holds its SHA-256 (`staffinvite:<hash>`), so a Redis dump leaks nothing usable.
//   - The record never carries the invitee's email (it is only the outbox `to`).
//   - consume = GETDEL (RedisLike.getdel, store.ts): two parallel accepts see the record once.
//   - Expiry is checked on every read against the injected clock, independent of the Redis TTL.
//   - Every list/revoke goes through ONE tenant's index set (`staffinvites:<partnerId>`); an id is
//     the first 12 hex of the hash and is only ever resolved inside that tenant's set.

export interface StaffInvite {
  partnerId: PartnerId;
  username: string;
  name: string;
  role: StaffRole;
  invitedBy: string;
  /**
   * UI redesign M3-21: 'platform' when a SmartRemit platform admin issued the invite (a new partner's
   * first admin, create-from-request). Absent means tenant-issued: every record written before M3-21
   * parses as tenant-issued, so the M3-9 accept rule is unchanged for them.
   */
  inviterScope?: 'platform';
  createdAt: string;
  expiresAt: string;
}

export const INVITE_TTL_SEC = 72 * 3600;
export const MAX_PENDING_INVITES = 20;
/** The visible, tenant-scoped handle of an invite: the first 12 hex of its token hash. */
export const INVITE_ID_LEN = 12;

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const INVITE_ID_RE = /^[0-9a-f]{12}$/;
const inviteKey = (hash: string) => `staffinvite:${hash}`;
const indexKey = (partnerId: PartnerId) => `staffinvites:${partnerId}`;

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isInviteId(id: string): boolean {
  return INVITE_ID_RE.test(id);
}

function parseInvite(raw: string | null): StaffInvite | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<StaffInvite> | null;
    if (!v || typeof v !== 'object') return null;
    const { partnerId, username, name, role, invitedBy, createdAt, expiresAt, inviterScope } = v;
    if (
      typeof partnerId !== 'string' || !partnerId ||
      typeof username !== 'string' || typeof name !== 'string' || typeof role !== 'string' ||
      typeof invitedBy !== 'string' || typeof createdAt !== 'string' || typeof expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(expiresAt))
    ) {
      return null;
    }
    return {
      partnerId, username, name, role: role as StaffRole, invitedBy, createdAt, expiresAt,
      ...(inviterScope === 'platform' ? { inviterScope: 'platform' as const } : {}),
    };
  } catch {
    return null;
  }
}

export function createStaffInviteStore(redis: RedisLike, now: () => Date = () => new Date()) {
  const live = (inv: StaffInvite | null): StaffInvite | null =>
    inv && Date.parse(inv.expiresAt) > now().getTime() ? inv : null;

  async function listForPartner(partnerId: PartnerId): Promise<Array<StaffInvite & { id: string }>> {
    if (!partnerId) return [];
    const out: Array<StaffInvite & { id: string }> = [];
    for (const hash of await redis.smembers(indexKey(partnerId))) {
      const inv = live(parseInvite(await redis.get(inviteKey(hash))));
      // A member whose record is gone, expired, corrupt or (defensively) another tenant's is pruned.
      if (!inv || inv.partnerId !== partnerId) {
        await redis.srem(indexKey(partnerId), hash);
        continue;
      }
      out.push({ ...inv, id: hash.slice(0, INVITE_ID_LEN) });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return {
    async issue(
      input: Omit<StaffInvite, 'createdAt' | 'expiresAt'>,
    ): Promise<{ token: string; hash: string; expiresAt: string } | { error: 'too_many' }> {
      if (!input.partnerId) throw new Error('A tenant is required.');
      if ((await listForPartner(input.partnerId)).length >= MAX_PENDING_INVITES) return { error: 'too_many' };
      const at = now();
      const token = randomBytes(32).toString('base64url');
      const hash = hashInviteToken(token);
      const expiresAt = new Date(at.getTime() + INVITE_TTL_SEC * 1000).toISOString();
      const record: StaffInvite = {
        partnerId: input.partnerId,
        username: input.username,
        name: input.name,
        role: input.role,
        invitedBy: input.invitedBy,
        ...(input.inviterScope === 'platform' ? { inviterScope: 'platform' as const } : {}),
        createdAt: at.toISOString(),
        expiresAt,
      };
      const set = await redis.set(inviteKey(hash), JSON.stringify(record), { ex: INVITE_TTL_SEC, nx: true });
      if (set === null) throw new Error('Invite collision.'); // 2^-256: never in practice
      await redis.sadd(indexKey(input.partnerId), hash);
      // The index self-cleans: every issue pushes its TTL to the newest member's lifetime.
      await redis.expire(indexKey(input.partnerId), INVITE_TTL_SEC);
      return { token, hash, expiresAt };
    },

    /** Read without consuming. Malformed, unknown, expired ⇒ null (no Redis call for a malformed token). */
    async peek(token: string): Promise<StaffInvite | null> {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      return live(parseInvite(await redis.get(inviteKey(hashInviteToken(token)))));
    },

    /** Single use: GETDEL, then the expiry check. A second call (or a parallel one) sees null. */
    async consume(token: string): Promise<StaffInvite | null> {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      const hash = hashInviteToken(token);
      const inv = parseInvite(await redis.getdel(inviteKey(hash)));
      if (inv) await redis.srem(indexKey(inv.partnerId), hash);
      return live(inv);
    },

    listForPartner,

    /** Revoke one of THIS tenant's invites by its id. Another tenant's id, or an unknown one, is false. */
    async revoke(partnerId: PartnerId, id: string): Promise<boolean> {
      if (!partnerId || typeof id !== 'string' || !isInviteId(id)) return false;
      const hash = (await redis.smembers(indexKey(partnerId))).find((h) => h.slice(0, INVITE_ID_LEN) === id);
      if (!hash) return false;
      const inv = parseInvite(await redis.getdel(inviteKey(hash)));
      await redis.srem(indexKey(partnerId), hash);
      return inv !== null && inv.partnerId === partnerId;
    },
  };
}

export type StaffInviteStore = ReturnType<typeof createStaffInviteStore>;

/** The store over the app's Redis (not cached: getRedis() is itself the singleton). */
export function getStaffInviteStore(): StaffInviteStore {
  return createStaffInviteStore(getRedis());
}
