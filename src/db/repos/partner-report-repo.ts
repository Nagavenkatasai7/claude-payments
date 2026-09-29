import { and, asc, count, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { partnerReportJobs, partners, transfers } from '@/db/schema';
import { LEASE_MS } from './outbox-repo';
import { rowToTransfer } from './mappers';
import type { FeesDayAggregate, ReportKind } from '@/lib/partner-reports';
import type { PartnerId, Transfer, TransferStatus } from '@/lib/types';

// partner-report-repo (UI redesign M3-16): the partner_report_jobs table (migration 0028) and the
// two tenant-REQUIRED ledger reads the report worker needs. Every function that reads or writes a
// tenant's data takes the partner id FIRST and REQUIRED, and throws on '' (never "all tenants").
// The ledger reads are MASKED (rowToTransfer without decrypt): payout destinations come back as
// `****last4` and no sealed column is ever opened here. A new file, so transfer-repo is untouched.
//
// Job lifecycle: queued → running (claimJob) → ready | failed; ready → expired (expireDue).
// claimJob is single-winner (FOR UPDATE SKIP LOCKED) and stamps claimed_at; complete/fail are
// compare-and-set on (status = 'running', claimed_at = the claim's stamp), the same lease-owner
// discipline as the outbox, so a reclaimed job's late ghost cannot overwrite the new run.
// A 'running' job whose claim is older than LEASE_MS (its worker was killed at maxDuration) is
// reclaimable, so no job is stranded 'running'.

export type ReportJobRow = typeof partnerReportJobs.$inferSelect;
export type ReportJobSummary = Omit<ReportJobRow, 'contentEnc'>;

function requireTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('partner-report-repo: a tenant is required');
}

/** Every column except the sealed CSV: the list never drags multi-MB blobs. */
const SUMMARY_COLUMNS = {
  id: partnerReportJobs.id,
  partnerId: partnerReportJobs.partnerId,
  kind: partnerReportJobs.kind,
  params: partnerReportJobs.params,
  status: partnerReportJobs.status,
  requestedBy: partnerReportJobs.requestedBy,
  rowCount: partnerReportJobs.rowCount,
  claimedAt: partnerReportJobs.claimedAt,
  errorCode: partnerReportJobs.errorCode,
  createdAt: partnerReportJobs.createdAt,
  completedAt: partnerReportJobs.completedAt,
  expiresAt: partnerReportJobs.expiresAt,
};

export interface ExportPageReq {
  from: Date;
  to: Date;
  environment: 'live' | 'test';
  status?: TransferStatus;
  limit: number;
  cursor?: string;
}

function parseCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const at = new Date(cursor.slice(0, sep));
  return isNaN(at.getTime()) ? null : { createdAt: at, id: cursor.slice(sep + 1) };
}

export function createPartnerReportRepo(db: DbOrTx) {
  return {
    /** Insert a queued job for this tenant. Call inside the request transaction. */
    async createJob(
      partnerId: PartnerId,
      j: { id: string; kind: ReportKind; params: Record<string, unknown>; requestedBy: string },
    ): Promise<void> {
      requireTenant(partnerId);
      await db.insert(partnerReportJobs).values({ id: j.id, partnerId, kind: j.kind, params: j.params, requestedBy: j.requestedBy, status: 'queued' });
    },

    /**
     * Lock the tenant's partners row (FOR NO KEY UPDATE) inside the request transaction, so the
     * concurrency + daily caps are counted by one request at a time per tenant. NO KEY UPDATE, not
     * UPDATE: it does not conflict with the FOR KEY SHARE lock every FK insert into transfers
     * (and the other partner_id children) takes, so money-path mints never wait on it
     * (LockStrength: node_modules/drizzle-orm/pg-core/query-builders/select.types.d.ts:60).
     * False when the tenant does not exist.
     */
    async lockTenant(partnerId: PartnerId): Promise<boolean> {
      requireTenant(partnerId);
      const rows = await db.select({ id: partners.id }).from(partners).where(eq(partners.id, partnerId)).for('no key update');
      return rows.length > 0;
    },

    /** Queued or running jobs created at or after `since` (older ones are stale, not active). */
    async countActive(partnerId: PartnerId, since: Date): Promise<number> {
      requireTenant(partnerId);
      const [r] = await db
        .select({ n: count() })
        .from(partnerReportJobs)
        .where(and(eq(partnerReportJobs.partnerId, partnerId), inArray(partnerReportJobs.status, ['queued', 'running']), gte(partnerReportJobs.createdAt, since)));
      return Number(r?.n ?? 0);
    },

    /** Every job this tenant created at or after `since` (the daily rate limit). */
    async countSince(partnerId: PartnerId, since: Date): Promise<number> {
      requireTenant(partnerId);
      const [r] = await db
        .select({ n: count() })
        .from(partnerReportJobs)
        .where(and(eq(partnerReportJobs.partnerId, partnerId), gte(partnerReportJobs.createdAt, since)));
      return Number(r?.n ?? 0);
    },

    /**
     * queued → running, or reclaim a running job whose claim is older than LEASE_MS. Single
     * winner: the row is locked with FOR UPDATE SKIP LOCKED, so a concurrent claimer skips it.
     * Returns the claimed row (claimedAt = `now`, the compare-and-set token) or null.
     */
    async claimJob(id: string, now: Date): Promise<ReportJobRow | null> {
      const staleBefore = new Date(now.getTime() - LEASE_MS);
      const rows = await db
        .update(partnerReportJobs)
        .set({ status: 'running', claimedAt: now })
        .where(
          and(
            eq(partnerReportJobs.id, id),
            or(
              eq(partnerReportJobs.status, 'queued'),
              and(eq(partnerReportJobs.status, 'running'), lt(partnerReportJobs.claimedAt, staleBefore)),
            ),
            sql`${partnerReportJobs.id} IN (SELECT id FROM partner_report_jobs WHERE id = ${id} FOR UPDATE SKIP LOCKED)`,
          ),
        )
        .returning();
      return rows[0] ?? null;
    },

    /** The job's status by id (worker-internal: the outbox payload carries only the job id). */
    async getStatus(id: string): Promise<{ status: string; claimedAt: Date | null } | null> {
      const rows = await db
        .select({ status: partnerReportJobs.status, claimedAt: partnerReportJobs.claimedAt })
        .from(partnerReportJobs)
        .where(eq(partnerReportJobs.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    async completeJob(
      id: string,
      claimedAt: Date,
      r: { contentEnc: string; rowCount: number; params: Record<string, unknown>; expiresAt: Date },
    ): Promise<boolean> {
      const rows = await db
        .update(partnerReportJobs)
        .set({ status: 'ready', contentEnc: r.contentEnc, rowCount: r.rowCount, params: r.params, expiresAt: r.expiresAt, completedAt: new Date(), errorCode: null })
        .where(and(eq(partnerReportJobs.id, id), eq(partnerReportJobs.status, 'running'), eq(partnerReportJobs.claimedAt, claimedAt)))
        .returning({ id: partnerReportJobs.id });
      return rows.length > 0;
    },

    /** running → queued again (a transient build error): the next outbox retry can claim it at once. */
    async releaseJob(id: string, claimedAt: Date): Promise<boolean> {
      const rows = await db
        .update(partnerReportJobs)
        .set({ status: 'queued', claimedAt: null })
        .where(and(eq(partnerReportJobs.id, id), eq(partnerReportJobs.status, 'running'), eq(partnerReportJobs.claimedAt, claimedAt)))
        .returning({ id: partnerReportJobs.id });
      return rows.length > 0;
    },

    /** running → failed with a FIXED code (never an exception message). */
    async failJob(id: string, claimedAt: Date, errorCode: string): Promise<boolean> {
      const rows = await db
        .update(partnerReportJobs)
        .set({ status: 'failed', errorCode, contentEnc: null, completedAt: new Date() })
        .where(and(eq(partnerReportJobs.id, id), eq(partnerReportJobs.status, 'running'), eq(partnerReportJobs.claimedAt, claimedAt)))
        .returning({ id: partnerReportJobs.id });
      return rows.length > 0;
    },

    /** One of THIS tenant's jobs (content included), or null for a missing OR foreign id. */
    async getJobForPartner(partnerId: PartnerId, id: string): Promise<ReportJobRow | null> {
      requireTenant(partnerId);
      const rows = await db
        .select()
        .from(partnerReportJobs)
        .where(and(eq(partnerReportJobs.partnerId, partnerId), eq(partnerReportJobs.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    /** This tenant's newest jobs, WITHOUT the sealed content. */
    async listJobs(partnerId: PartnerId, limit = 25): Promise<ReportJobSummary[]> {
      requireTenant(partnerId);
      return db
        .select(SUMMARY_COLUMNS)
        .from(partnerReportJobs)
        .where(eq(partnerReportJobs.partnerId, partnerId))
        .orderBy(desc(partnerReportJobs.createdAt), desc(partnerReportJobs.id))
        .limit(Math.min(Math.max(1, Math.trunc(limit) || 1), 100));
    },

    /** ready past expires_at → expired, content nulled (the row stays for audit). Returns the count. */
    async expireDue(now: Date): Promise<number> {
      const rows = await db
        .update(partnerReportJobs)
        .set({ status: 'expired', contentEnc: null })
        .where(and(eq(partnerReportJobs.status, 'ready'), lt(partnerReportJobs.expiresAt, now)))
        .returning({ id: partnerReportJobs.id });
      return rows.length;
    },

    /**
     * One keyset page (created_at DESC, id DESC) of THIS tenant's transfers in one environment and
     * a [from, to) created_at window, optionally one status. MASKED rows only.
     */
    async transfersForExport(partnerId: PartnerId, req: ExportPageReq): Promise<{ items: Transfer[]; nextCursor?: string }> {
      requireTenant(partnerId);
      const cur = parseCursor(req.cursor);
      const conds = [
        eq(transfers.partnerId, partnerId),
        eq(transfers.environment, req.environment),
        gte(transfers.createdAt, req.from),
        lt(transfers.createdAt, req.to),
        req.status ? eq(transfers.status, req.status) : undefined,
        cur
          ? or(lt(transfers.createdAt, cur.createdAt), and(eq(transfers.createdAt, cur.createdAt), lt(transfers.id, cur.id)))
          : undefined,
      ].filter((c): c is NonNullable<typeof c> => Boolean(c));
      const limit = Math.min(Math.max(1, Math.trunc(req.limit) || 1), 1000);
      const rows = await db
        .select()
        .from(transfers)
        .where(and(...conds))
        .orderBy(desc(transfers.createdAt), desc(transfers.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map((r) => rowToTransfer(r, { decrypt: false }));
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : undefined };
    },

    /**
     * The monthly fees read: per UTC day and source currency, LIVE rows of this tenant with
     * status paid or delivered (the same "earned" rule as the dashboard summary's commission),
     * created in [start, end). Sums are done in minor units, then scaled back.
     */
    async feesByDay(partnerId: PartnerId, start: Date, end: Date): Promise<FeesDayAggregate[]> {
      requireTenant(partnerId);
      const day = sql<string>`to_char(${transfers.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
      const rows = await db
        .select({
          day,
          currency: transfers.sourceCurrency,
          transfers: sql<number>`count(*)::int`,
          amountMinor: sql<string>`coalesce(sum(round(${transfers.amountSource} * 100)), 0)::bigint`,
          feeMinor: sql<string>`coalesce(sum(round(${transfers.feeSource} * 100)), 0)::bigint`,
          feeUsdMinor: sql<string>`coalesce(sum(round(${transfers.feeUsd} * 100)), 0)::bigint`,
        })
        .from(transfers)
        .where(
          and(
            eq(transfers.partnerId, partnerId),
            eq(transfers.environment, 'live'),
            inArray(transfers.status, ['paid', 'delivered']),
            gte(transfers.createdAt, start),
            lt(transfers.createdAt, end),
          ),
        )
        .groupBy(day, transfers.sourceCurrency)
        .orderBy(asc(day), asc(transfers.sourceCurrency));
      return rows.map((r) => ({
        day: String(r.day),
        currency: String(r.currency),
        transfers: Number(r.transfers),
        amountSource: Number(r.amountMinor) / 100,
        feeSource: Number(r.feeMinor) / 100,
        feeUsd: Number(r.feeUsdMinor) / 100,
      }));
    },
  };
}

export type PartnerReportRepo = ReturnType<typeof createPartnerReportRepo>;
