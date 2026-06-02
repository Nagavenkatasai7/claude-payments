import { Redis } from '@upstash/redis';
import { env } from './env';
import type { RedisLike } from './store';

/**
 * Append-only audit log for staff (team) mutations.
 *
 * Every create / update / suspend / reactivate / remove of a staff account is
 * recorded with the acting admin, the target, and a human summary — table stakes
 * for a remittance/compliance tool (per the team-management research). Stored as a
 * single JSON array under one key (newest first, capped) so it fits the existing
 * RedisLike abstraction (get/set) without needing native list ops; volume here is
 * low (admin actions only). Read-only on the Team page, gated to platform admins.
 */

export type StaffAuditAction =
  | 'created'
  | 'updated'
  | 'suspended'
  | 'reactivated'
  | 'removed';

export interface StaffAuditEntry {
  at: string; // ISO-8601
  actor: string; // username who performed the action
  action: StaffAuditAction;
  target: string; // affected username
  detail?: string; // human-readable summary
}

const KEY = 'audit:staff';
const MAX = 200;

export function createAuditLogStore(redis: RedisLike) {
  return {
    async record(entry: StaffAuditEntry): Promise<void> {
      const raw = await redis.get(KEY);
      const list: StaffAuditEntry[] = raw ? (JSON.parse(raw) as StaffAuditEntry[]) : [];
      list.unshift(entry);
      await redis.set(KEY, JSON.stringify(list.slice(0, MAX)));
    },
    async list(limit = 50): Promise<StaffAuditEntry[]> {
      const raw = await redis.get(KEY);
      const list: StaffAuditEntry[] = raw ? (JSON.parse(raw) as StaffAuditEntry[]) : [];
      return list.slice(0, Math.max(0, limit));
    },
  };
}

export type AuditLogStore = ReturnType<typeof createAuditLogStore>;

let cached: AuditLogStore | null = null;

export function getAuditLogStore(): AuditLogStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createAuditLogStore(redis as unknown as RedisLike);
  }
  return cached;
}
