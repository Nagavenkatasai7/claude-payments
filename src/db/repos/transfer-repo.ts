import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { transfers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { rowToTransfer, transferToRow, type TransferRow } from './mappers';
import type { PartnerId, RefundStatus, Transfer, TransferStatus } from '@/lib/types';

// transfer-repo — the Postgres ledger for transfers. Mirrors the function
// surface call sites already use (getTransfer/saveTransfer/
// updateTransferFromWebhook) and adds the indexed queries that replace every
// full-ledger scan (listByPartner/listByPhone/adminList keyset pagination,
// firstTransferAt, countByPhone) plus the reconciliation query (findStuckPaid).
//
// Tenant isolation is app-level: partner-facing methods take partnerId and
// bake it into the WHERE — getOwnedTransfer returns null for out-of-scope ids
// (the partner API's 404-never-403 contract).

export interface PageReq {
  limit: number;
  /** Keyset cursor: the `createdAt|id` of the last row of the previous page. */
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

function cursorOf(t: Transfer): string {
  return `${t.createdAt}|${t.id}`;
}

function parseCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const at = new Date(cursor.slice(0, sep));
  if (isNaN(at.getTime())) return null;
  return { createdAt: at, id: cursor.slice(sep + 1) };
}

export function createTransferRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  const toDomain = (row: TransferRow, decrypt = false) =>
    rowToTransfer(row, { decrypt, provider });

  async function page(
    where: ReturnType<typeof and>,
    req: PageReq,
    decrypt = false,
  ): Promise<Page<Transfer>> {
    const cur = parseCursor(req.cursor);
    const cursorCond = cur
      ? or(
          lt(transfers.createdAt, cur.createdAt),
          and(eq(transfers.createdAt, cur.createdAt), lt(transfers.id, cur.id)),
        )
      : undefined;
    const rows = await db
      .select()
      .from(transfers)
      .where(cursorCond ? and(where, cursorCond) : where)
      .orderBy(desc(transfers.createdAt), desc(transfers.id))
      .limit(req.limit + 1);
    const items = rows.slice(0, req.limit).map((r) => toDomain(r, decrypt));
    return {
      items,
      nextCursor: rows.length > req.limit ? cursorOf(items[items.length - 1]) : undefined,
    };
  }

  return {
    async getTransfer(id: string, opts?: { decrypt?: boolean }): Promise<Transfer | null> {
      const rows = await db.select().from(transfers).where(eq(transfers.id, id)).limit(1);
      return rows[0] ? toDomain(rows[0], opts?.decrypt ?? false) : null;
    },

    /** Partner-scoped read: null for missing OR out-of-scope (404-never-403). */
    async getOwnedTransfer(partnerId: PartnerId, id: string): Promise<Transfer | null> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(eq(transfers.id, id), eq(transfers.partnerId, partnerId)))
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * Compat upsert (mirrors the Redis saveTransfer SET semantics) — with a
     * structural guard: DEFAULT reads return a MASKED payout destination
     * (****last4) and omit the decrypt-only recipientLegalName, so a
     * read-modify-write that re-saves such a transfer must NEVER overwrite the
     * encrypted columns at rest. When the incoming destination is the mask, the
     * conflict-update leaves payout_destination_enc/_last4 and
     * recipient_legal_name_enc untouched.
     */
    async saveTransfer(t: Transfer): Promise<void> {
      const row = transferToRow(t, provider);
      const masked = /^\*{4}/.test(t.payoutDestination ?? '');
      let set: Partial<typeof row> = row;
      if (masked) {
        const {
          payoutDestinationEnc: _enc,
          payoutDestinationLast4: _l4,
          recipientLegalNameEnc: _legal,
          ...rest
        } = row;
        void _enc; void _l4; void _legal;
        set = rest;
      }
      await db
        .insert(transfers)
        .values(row)
        .onConflictDoUpdate({ target: transfers.id, set });
    },

    /** Transaction-aware insert for the money paths (no upsert — must be new). */
    async insertTransfer(t: Transfer): Promise<void> {
      await db.insert(transfers).values(transferToRow(t, provider));
    },

    /**
     * Atomic, forward-only webhook transition — ONE guarded UPDATE, immune to
     * the concurrent funded/paid_out race. Terminal states (cancelled, blocked,
     * in_review) never move; equal-or-backward ranks no-op. Non-null return ⇒
     * a REAL transition (the caller's notify contract, unchanged).
     */
    async updateTransferFromWebhook(
      id: string,
      status: TransferStatus,
    ): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({
          status,
          paidAt: sql`CASE WHEN ${status} IN ('paid','delivered') THEN COALESCE(${transfers.paidAt}, now()) ELSE ${transfers.paidAt} END`,
          deliveredAt: sql`CASE WHEN ${status} = 'delivered' THEN COALESCE(${transfers.deliveredAt}, now()) ELSE ${transfers.deliveredAt} END`,
        })
        .where(
          and(
            eq(transfers.id, id),
            sql`${transfers.status} NOT IN ('cancelled','blocked','in_review')`,
            sql`(CASE ${transfers.status} WHEN 'awaiting_payment' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END)
              < (CASE ${status} WHEN 'paid' THEN 1 WHEN 'delivered' THEN 2 ELSE -1 END)`,
          ),
        )
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /** Persist the settlement ref exactly once (never clobbers an existing ref). */
    async setProviderRef(id: string, ref: string): Promise<void> {
      await db
        .update(transfers)
        .set({ paymentProviderRef: ref })
        .where(and(eq(transfers.id, id), isNull(transfers.paymentProviderRef)));
    },

    /**
     * Persist the funding provider's charge reference exactly once, BEFORE
     * settlement begins — a crash between capture and settle leaves an
     * awaiting_payment row WITH a fundingRef, which the reconcile sweep
     * resumes (the customer was charged; the transfer must never be lost).
     */
    async setFundingRef(id: string, ref: string): Promise<void> {
      await db
        .update(transfers)
        .set({ fundingRef: ref })
        .where(and(eq(transfers.id, id), isNull(transfers.fundingRef)));
    },

    /**
     * Guarded refund-lifecycle transition. Legal moves: none→requested
     * (customer asked via bot), requested→none (ops dismissed),
     * none/requested/failed→pending (ops or auto initiated; failed retries),
     * pending→completed|failed. Returns null when the stored state isn't a
     * legal predecessor — concurrent ops clicks and webhook replays become
     * harmless no-ops. The forward-only `status` machine is untouched.
     */
    async updateRefund(
      id: string,
      next: { refundStatus: RefundStatus; refundRef?: string; refundedAt?: string },
    ): Promise<Transfer | null> {
      const legalFrom: Record<RefundStatus, RefundStatus[]> = {
        requested: ['none'],
        none: ['requested'],
        pending: ['none', 'requested', 'failed'],
        completed: ['pending'],
        failed: ['pending'],
      };
      const rows = await db
        .update(transfers)
        .set({
          refundStatus: next.refundStatus,
          ...(next.refundRef !== undefined ? { refundRef: next.refundRef } : {}),
          ...(next.refundedAt !== undefined ? { refundedAt: new Date(next.refundedAt) } : {}),
        })
        .where(and(
          eq(transfers.id, id),
          sql`${transfers.refundStatus} IN (${sql.join(legalFrom[next.refundStatus].map((s) => sql`${s}`), sql`, `)})`,
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /** Refund queues for the ops page + sweeps (masked reads). */
    async listByRefundStatus(refundStatus: RefundStatus, limit = 50): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(eq(transfers.refundStatus, refundStatus))
        .orderBy(desc(transfers.createdAt))
        .limit(limit);
      return rows.map((r) => toDomain(r));
    },

    /**
     * Every transfer with a refund in ANY non-'none' state (requested, pending,
     * completed, failed) — the full-history feed for the /admin-dashboard/refunds
     * page. Masked reads, newest first. `partnerId` scopes the feed to one tenant
     * (partner-staff visibility); omitted ⇒ platform-wide.
     */
    async listActiveRefunds(opts: { partnerId?: string; limit?: number } = {}): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(
          sql`${transfers.refundStatus} <> 'none'`,
          ...(opts.partnerId ? [eq(transfers.partnerId, opts.partnerId)] : []),
        ))
        .orderBy(desc(transfers.createdAt))
        .limit(opts.limit ?? 200);
      return rows.map((r) => toDomain(r));
    },

    /**
     * Crash-resume sweep query: charged (fundingRef set) but still
     * awaiting_payment after `olderThanMs` — the process died between capture
     * and beginSettlement. These must be resumed, never abandoned.
     */
    async listAwaitingWithFunding(olderThanMs: number, now: Date = new Date()): Promise<Transfer[]> {
      const cutoff = new Date(now.getTime() - olderThanMs);
      const rows = await db
        .select()
        .from(transfers)
        .where(and(
          eq(transfers.status, 'awaiting_payment'),
          sql`${transfers.fundingRef} IS NOT NULL`,
          lt(transfers.createdAt, cutoff),
        ))
        .limit(50);
      return rows.map((r) => toDomain(r));
    },

    /**
     * Atomically claim the awaiting_payment → paid transition (Stage 2c). Used
     * inside the settlement transaction so the status flip + outbox rows commit
     * together. Null ⇒ the transfer was already past awaiting_payment (double
     * submit / replay) — the caller treats it as an idempotent no-op.
     */
    async markPaidIfAwaiting(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'paid', paidAt: sql`COALESCE(${transfers.paidAt}, now())` })
        .where(and(eq(transfers.id, id), eq(transfers.status, 'awaiting_payment')))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /** Compliance views: newest-first by compliance_status (indexed-friendly). */
    async listByCompliance(
      complianceStatus: 'flagged' | 'blocked',
      opts: { partnerId?: PartnerId; limit?: number } = {},
    ): Promise<Transfer[]> {
      const conds = [
        eq(transfers.complianceStatus, complianceStatus),
        ...(opts.partnerId ? [eq(transfers.partnerId, opts.partnerId)] : []),
      ];
      const rows = await db
        .select()
        .from(transfers)
        .where(and(...conds))
        .orderBy(desc(transfers.createdAt), desc(transfers.id))
        .limit(opts.limit ?? 100);
      return rows.map((r) => toDomain(r));
    },

    /**
     * Today's velocity leaderboard (eastern day, matching summarize()) — one
     * GROUP BY instead of scanning the ledger through JS per render.
     */
    async topVelocityToday(
      limit: number,
      partnerId?: PartnerId,
    ): Promise<{ phone: string; count: number }[]> {
      const where = partnerId
        ? sql`WHERE (created_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date AND partner_id = ${partnerId}`
        : sql`WHERE (created_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`;
      const res = await db.execute(sql`
        SELECT phone, count(*)::int AS n FROM transfers ${where}
        GROUP BY phone ORDER BY n DESC, phone ASC LIMIT ${limit};
      `);
      return (res as unknown as { rows: { phone: string; n: number }[] }).rows.map((r) => ({
        phone: r.phone,
        count: Number(r.n),
      }));
    },

    /** Reconciliation: compliance holds nobody has reviewed in `hours`. */
    async findInReviewOlderThan(hours: number): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.status, 'in_review'),
            sql`${transfers.paidAt} < now() - make_interval(hours => ${hours})`,
          ),
        )
        .orderBy(transfers.paidAt);
      return rows.map((r) => toDomain(r));
    },

    listByPartner(partnerId: PartnerId, req: PageReq): Promise<Page<Transfer>> {
      return page(and(eq(transfers.partnerId, partnerId)), req);
    },

    listByPhone(phone: string, req: PageReq): Promise<Page<Transfer>> {
      return page(and(eq(transfers.phone, phone)), req);
    },

    /** Staff-only unscoped list (server actions behind requireStaff). */
    adminList(req: PageReq & { partnerId?: PartnerId; status?: TransferStatus }): Promise<Page<Transfer>> {
      const conds = [
        req.partnerId ? eq(transfers.partnerId, req.partnerId) : undefined,
        req.status ? eq(transfers.status, req.status) : undefined,
      ].filter((c): c is NonNullable<typeof c> => Boolean(c));
      return page(conds.length ? and(...conds) : and(sql`true`), req);
    },

    /** Replaces the full-ledger scan in upsertOnFirstInbound (grandfathering). */
    async firstTransferAt(phone: string): Promise<string | null> {
      const rows = await db
        .select({ min: sql<string | null>`min(${transfers.createdAt})` })
        .from(transfers)
        .where(eq(transfers.phone, phone));
      const v = rows[0]?.min;
      return v ? new Date(v).toISOString() : null;
    },

    /**
     * All-time transfer count for the fee tier (replaces the count:{phone}
     * counter). DERIVED now, with cleaner semantics than the old counter:
     * blocked rows don't count — a watchlist-blocked attempt no longer burns
     * the customer's free first transfer (the old counter incremented on the
     * createTransfer-blocked path; that was a latent bug, not a contract).
     */
    async countByPhone(phone: string): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(transfers)
        .where(and(eq(transfers.phone, phone), sql`${transfers.status} != 'blocked'`));
      return rows[0]?.n ?? 0;
    },

    /**
     * One-query dashboard aggregates (Stage 4) — replaces serializing the
     * whole ledger through JS on every overview render. "Today" uses the
     * EASTERN calendar day, matching lib/dashboard.ts summarize() exactly
     * (Postgres handles the DST boundary; JS-side epoch math can't).
     *
     * The result doubles as the LIVE-REFRESH CHANGE STAMP: per-status counts
     * catch every status transition, `latest` (greatest of the three
     * timestamps) catches new rows and paid/delivered flips — if no number
     * moves, nothing on a dashboard could have changed.
     */
    async summary(partnerId?: PartnerId): Promise<{
      countToday: number;
      volumeToday: number;
      commissionToday: number;
      flaggedToday: number;
      commissionAllTime: number;
      volumeAllTime: number;
      needsAttention: number;
      byStatus: Record<string, number>;
      latest: string | null;
      total: number;
    }> {
      const where = partnerId ? sql`WHERE partner_id = ${partnerId}` : sql``;
      const res = await db.execute(sql`
        WITH t AS (
          SELECT *, (created_at AT TIME ZONE 'America/New_York')::date
                    = (now() AT TIME ZONE 'America/New_York')::date AS is_today
          FROM transfers ${where}
        )
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE is_today)::int AS count_today,
          coalesce(sum(amount_usd) FILTER (WHERE is_today), 0)::float8 AS volume_today,
          coalesce(sum(fee_usd) FILTER (WHERE is_today AND status IN ('paid','delivered')), 0)::float8 AS commission_today,
          count(*) FILTER (WHERE is_today AND compliance_status IN ('flagged','blocked'))::int AS flagged_today,
          coalesce(sum(fee_usd) FILTER (WHERE status IN ('paid','delivered')), 0)::float8 AS commission_all_time,
          coalesce(sum(amount_usd), 0)::float8 AS volume_all_time,
          count(*) FILTER (
            WHERE compliance_status IN ('flagged','blocked')
               OR (status = 'awaiting_payment' AND created_at < now() - interval '30 minutes')
          )::int AS needs_attention,
          count(*) FILTER (WHERE status = 'awaiting_payment')::int AS s_awaiting,
          count(*) FILTER (WHERE status = 'paid')::int AS s_paid,
          count(*) FILTER (WHERE status = 'delivered')::int AS s_delivered,
          count(*) FILTER (WHERE status = 'in_review')::int AS s_in_review,
          count(*) FILTER (WHERE status = 'cancelled')::int AS s_cancelled,
          count(*) FILTER (WHERE status = 'blocked')::int AS s_blocked,
          max(greatest(created_at, coalesce(paid_at, created_at), coalesce(delivered_at, created_at))) AS latest
        FROM t;
      `);
      const r = (res as unknown as { rows: Record<string, unknown>[] }).rows[0];
      const round2 = (v: unknown) => Math.round(Number(v) * 100) / 100;
      return {
        total: Number(r.total),
        countToday: Number(r.count_today),
        volumeToday: round2(r.volume_today),
        commissionToday: round2(r.commission_today),
        flaggedToday: Number(r.flagged_today),
        commissionAllTime: round2(r.commission_all_time),
        volumeAllTime: round2(r.volume_all_time),
        needsAttention: Number(r.needs_attention),
        byStatus: {
          awaiting_payment: Number(r.s_awaiting),
          paid: Number(r.s_paid),
          delivered: Number(r.s_delivered),
          in_review: Number(r.s_in_review),
          cancelled: Number(r.s_cancelled),
          blocked: Number(r.s_blocked),
        },
        latest: r.latest ? new Date(String(r.latest)).toISOString() : null,
      };
    },

    /** Full newest-first list (dashboard compat until Stage-4 pagination). */
    async listAll(): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .orderBy(desc(transfers.createdAt), desc(transfers.id));
      return rows.map((r) => toDomain(r));
    },

    /** Reconciliation: webhook-driven transfers stuck in 'paid' too long. */
    async findStuckPaid(olderThanMinutes: number): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.status, 'paid'),
            sql`${transfers.paidAt} < now() - make_interval(mins => ${olderThanMinutes})`,
            // MONEY SAFETY: a 'paid' transfer that is being (or has been) refunded
            // must NOT be re-instructed for delivery by the stuck-paid sweep — that
            // would pay the recipient AND refund the sender (money moved twice).
            // Once a refund is in flight or done, the transfer is no longer "stuck",
            // it is being clawed back. refund_status defaults to 'none'.
            eq(transfers.refundStatus, 'none'),
          ),
        )
        .orderBy(transfers.paidAt);
      return rows.map((r) => toDomain(r));
    },
  };
}

export type TransferRepo = ReturnType<typeof createTransferRepo>;
