import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { auditEvents } from '@/db/schema';
import type { PartnerId } from '@/lib/types';

// tenant-audit-repo (UI redesign M3-4): the partner app's READ of audit_events. Read-only: nothing
// here writes. Every query's WHERE starts with the partner id the caller passes, which the page
// takes from the SESSION (requirePartnerStaff), never from the request, then an IN over an action
// allowlist (an empty list runs no query). A new file, so aux-repos.ts is untouched.
//
// Keyset paging on (at, id) newest first. audit_events.at is timestamptz (microseconds) while a JS
// Date holds milliseconds, so the order, the returned `at` and the cursor predicate all use
// date_trunc('milliseconds', at): the cursor then names a value the database compares exactly, and
// rows written in one transaction (same now()) are neither skipped nor repeated across pages.
// The window is bounded (the caller clamps it to 90 days) and the limit to 1..100.

export interface TenantAuditDbRow {
  id: number;
  at: Date;
  actor: string;
  actorType: string;
  action: string;
  subjectId: string | null;
  meta: unknown;
}

export interface TenantAuditQuery {
  actions: readonly string[];
  actor?: string;
  from: Date;
  to: Date;
  before?: { at: Date; id: number };
  limit: number;
}

const MAX_LIMIT = 100;
const clampLimit = (n: number) => Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 1, 1), MAX_LIMIT);

const atMs = sql`date_trunc('milliseconds', ${auditEvents.at})`;

const columns = {
  id: auditEvents.id,
  at: sql<Date>`${atMs}`.mapWith(auditEvents.at),
  actor: auditEvents.actor,
  actorType: auditEvents.actorType,
  action: auditEvents.action,
  subjectId: auditEvents.subjectId,
  meta: auditEvents.meta,
};

function tenantScope(partnerId: PartnerId, actions: readonly string[]): SQL | undefined {
  return and(eq(auditEvents.partnerId, partnerId), inArray(auditEvents.action, [...actions]));
}

export async function listTenantAudit(db: DbOrTx, partnerId: PartnerId, q: TenantAuditQuery): Promise<TenantAuditDbRow[]> {
  if (!partnerId || q.actions.length === 0) return [];
  const before = q.before
    ? sql`(${atMs} < ${q.before.at.toISOString()}::timestamptz OR (${atMs} = ${q.before.at.toISOString()}::timestamptz AND ${auditEvents.id} < ${q.before.id}))`
    : undefined;
  return db
    .select(columns)
    .from(auditEvents)
    .where(
      and(
        tenantScope(partnerId, q.actions),
        gte(auditEvents.at, q.from),
        lt(auditEvents.at, q.to), // exclusive: [from, to)
        q.actor ? eq(auditEvents.actor, q.actor) : undefined,
        before,
      ),
    )
    .orderBy(desc(atMs), desc(auditEvents.id))
    .limit(clampLimit(q.limit));
}

/** One subject's trail in this tenant (M3-5's transfer timeline), with the same guarantees. */
export async function listTenantAuditForSubject(
  db: DbOrTx,
  partnerId: PartnerId,
  subjectId: string,
  actions: readonly string[],
  limit: number,
): Promise<TenantAuditDbRow[]> {
  if (!partnerId || !subjectId || actions.length === 0) return [];
  return db
    .select(columns)
    .from(auditEvents)
    .where(and(tenantScope(partnerId, actions), eq(auditEvents.subjectId, subjectId)))
    .orderBy(desc(atMs), desc(auditEvents.id))
    .limit(clampLimit(limit));
}
