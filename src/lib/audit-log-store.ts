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

/** The five team actions the Team feed shows (Program-Fix 17a: filtered in SQL). */
export const STAFF_AUDIT_ACTIONS: readonly StaffAuditAction[] = [
  'created',
  'updated',
  'suspended',
  'reactivated',
  'removed',
];

export interface StaffAuditEntry {
  at: string; // ISO-8601
  actor: string; // username who performed the action
  action: StaffAuditAction;
  target: string; // affected username
  detail?: string; // human-readable summary
  /** partner-demo R5: the target's tenant (audit_events.partner_id); absent = a platform account. */
  partnerId?: string;
  /** partner-demo R5: whether the ACTOR was a platform or a partner-scoped admin. */
  actorScope?: 'platform' | 'partner';
}

/** The two actions a tenant's own staff feed shows (partner-demo R5). */
export const TENANT_STAFF_FEED_ACTIONS: readonly StaffAuditAction[] = ['created', 'removed'];

function toEntry(r: { at: Date; actor: string; action: string; subjectId: string | null; partnerId: string | null; meta: unknown }): StaffAuditEntry {
  const e: StaffAuditEntry = {
    at: r.at.toISOString(),
    actor: r.actor,
    action: r.action as StaffAuditAction,
    target: r.subjectId ?? '',
  };
  const meta = r.meta as { detail?: string; actorScope?: string } | null;
  if (meta?.detail) e.detail = meta.detail;
  if (meta?.actorScope === 'platform' || meta?.actorScope === 'partner') e.actorScope = meta.actorScope;
  if (r.partnerId) e.partnerId = r.partnerId;
  return e;
}

export function createAuditLogStore(db: DbOrTx) {
  const repo = createAuditRepo(db);
  return {
    async record(entry: StaffAuditEntry): Promise<void> {
      const meta: Record<string, unknown> = {};
      if (entry.detail) meta.detail = entry.detail;
      if (entry.actorScope) meta.actorScope = entry.actorScope;
      await repo.record({
        partnerId: entry.partnerId || undefined,
        actor: entry.actor,
        actorType: 'staff',
        action: entry.action,
        subjectId: entry.target,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      });
    },
    async list(limit = 50): Promise<StaffAuditEntry[]> {
      // Filter IN the query on BOTH conditions: actor_type 'staff' (Program-Fix
      // 14: one system sanctions.screen row per mint) AND the five team actions
      // (Program-Fix 17a: auth.* sign-in rows, many of them actor_type 'staff').
      // Taking the newest N rows and filtering afterwards let either kind push
      // every team change off the list.
      const rows = await repo.listRecentByActions(STAFF_AUDIT_ACTIONS, limit, { actorType: 'staff' });
      return rows.map(toEntry);
    },
    /**
     * partner-demo R5: ONE tenant's staff created/removed rows, newest first,
     * filtered IN SQL on partner_id + actor_type 'staff' + the two actions (a
     * raw listByPartner would also return pii.view / KYC rows). The caller
     * passes the tenant from the session scope, never from a form.
     */
    async listForPartner(partnerId: string, limit = 20): Promise<StaffAuditEntry[]> {
      if (!partnerId) return [];
      const rows = await repo.listRecentByActions(TENANT_STAFF_FEED_ACTIONS, limit, { actorType: 'staff', partnerId });
      return rows.map(toEntry);
    },
  };
}

export type AuditLogStore = ReturnType<typeof createAuditLogStore>;

let cached: AuditLogStore | null = null;

export function getAuditLogStore(): AuditLogStore {
  if (!cached) cached = createAuditLogStore(getDb());
  return cached;
}
