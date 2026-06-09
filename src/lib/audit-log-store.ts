import { getDb, type DbOrTx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';

// audit-log-store — CUT OVER to Postgres (Stage 2a). Staff (team) mutations now
// land in the append-only `audit_events` table (actor_type 'staff') instead of
// a capped Redis JSON blob — durable, uncapped, queryable. Module path + the
// record/list surface are unchanged for the Team page + actions.

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

export function createAuditLogStore(db: DbOrTx) {
  const repo = createAuditRepo(db);
  return {
    async record(entry: StaffAuditEntry): Promise<void> {
      await repo.record({
        actor: entry.actor,
        actorType: 'staff',
        action: entry.action,
        subjectId: entry.target,
        meta: entry.detail ? { detail: entry.detail } : undefined,
      });
    },
    async list(limit = 50): Promise<StaffAuditEntry[]> {
      const rows = await repo.listRecent(limit);
      return rows
        .filter((r) => r.actorType === 'staff')
        .map((r) => {
          const e: StaffAuditEntry = {
            at: r.at.toISOString(),
            actor: r.actor,
            action: r.action as StaffAuditAction,
            target: r.subjectId ?? '',
          };
          const detail = (r.meta as { detail?: string } | null)?.detail;
          if (detail) e.detail = detail;
          return e;
        });
    },
  };
}

export type AuditLogStore = ReturnType<typeof createAuditLogStore>;

let cached: AuditLogStore | null = null;

export function getAuditLogStore(): AuditLogStore {
  if (!cached) cached = createAuditLogStore(getDb());
  return cached;
}
