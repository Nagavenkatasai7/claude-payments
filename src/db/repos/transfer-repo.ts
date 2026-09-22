import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { auditEvents, idempotencyKeys, transfers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { last4, rowToTransfer, transferToRow, type TransferRow } from './mappers';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { CountryCode, PartnerId, PayoutMethod, RefundStatus, Transfer, TransferStatus } from '@/lib/types';

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

  // fix 6 (ctx-01): the pay page may write a transfer's payout ONLY while every
  // one of these holds — evaluated INSIDE the UPDATE, so a concurrent charge /
  // settle / hold (the OTP verify is get→compare→del, not atomic —
  // transaction-otp.ts:59-83 — so two POSTs can pass on one code) can never be
  // reverted or overwritten. Not minted through the partner API: a partner-API
  // mint binds its Idempotency-Key claim-first (partner-api-service.ts) and
  // records a transaction.create audit event by an api_key; pay-page drafts
  // claim 'draft:<id>' under the default tenant (pay-finalize.ts) — a prefix the
  // partner API refuses at its edge (createTransaction, fix 6), so a 'draft:'
  // key under default is never a partner claim. ('b2binvoice:<id>' claims need
  // no exemption: those mints are always transfer_type 'b2b',
  // b2b-pay-finalize.ts, and fail the b2c test below.) Either partner-API
  // marker locks the payout the partner supplied.
  const payoutEditable = (id: string, partnerId: PartnerId) =>
    and(
      eq(transfers.id, id),
      eq(transfers.partnerId, partnerId),
      eq(transfers.status, 'awaiting_payment'),
      isNull(transfers.fundingRef),
      eq(transfers.transferType, 'b2c'),
      sql`NOT EXISTS (SELECT 1 FROM ${idempotencyKeys} WHERE ${idempotencyKeys.transferId} = ${transfers.id} AND NOT (${idempotencyKeys.partnerId} = ${DEFAULT_PARTNER_ID} AND ${idempotencyKeys.key} LIKE 'draft:%'))`,
      sql`NOT EXISTS (SELECT 1 FROM ${auditEvents} WHERE ${auditEvents.subjectId} = ${transfers.id} AND ${auditEvents.action} = 'transaction.create' AND ${auditEvents.actorType} = 'api_key')`,
    );

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
      // A read-back transfer masks payout + business names TOGETHER (one
      // opts.decrypt), so any ****-prefixed field means "saved from a masked
      // read" — strip ALL encrypted columns on conflict-update so the real
      // ciphertext is never clobbered by a mask. (Payout can be empty on a B2B
      // send, so also check the business names.)
      const isMasked = (v: string | undefined) => /^\*{4}/.test(v ?? '');
      const masked =
        isMasked(t.payoutDestination) || isMasked(t.senderBusinessName) || isMasked(t.recipientBusinessName);
      let set: Partial<typeof row> = row;
      if (masked) {
        const {
          payoutDestinationEnc: _enc,
          payoutDestinationLast4: _l4,
          recipientLegalNameEnc: _legal,
          senderBusinessNameEnc: _sbEnc,
          senderBusinessNameLast4: _sbL4,
          recipientBusinessNameEnc: _rbEnc,
          recipientBusinessNameLast4: _rbL4,
          ...rest
        } = row;
        void _enc; void _l4; void _legal;
        void _sbEnc; void _sbL4; void _rbEnc; void _rbL4;
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
            // MONEY SAFETY: never let a paid-out callback flip a transfer to
            // 'delivered' while a refund is in progress — the money is being
            // returned to the sender, so the recipient must not be paid too. A
            // delivered-callback on a refunding transfer is a safe no-op (returns
            // null), exactly like a duplicate callback. Non-delivered targets and
            // non-refunding transfers are unaffected. refund_status defaults to
            // 'none'.
            sql`(${status} <> 'delivered' OR COALESCE(${transfers.refundStatus}, 'none') = 'none')`,
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
     * together. COMPLIANCE GATE (Phase 1 Task 3): only a 'cleared' row can ever
     * flip to paid — the predicate lives IN the UPDATE so the ledger, not the
     * caller's possibly-stale Transfer object, decides. Null ⇒ either already
     * past awaiting_payment (double submit / replay) OR not cleared; the caller
     * re-reads inside the same transaction to tell the two apart.
     */
    async markPaidIfAwaiting(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'paid', paidAt: sql`COALESCE(${transfers.paidAt}, now())` })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.status, 'awaiting_payment'),
          eq(transfers.complianceStatus, 'cleared'),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * Atomically claim the awaiting_payment → in_review transition — the
     * COMPLIANCE HOLD. Mirrors markPaidIfAwaiting: one guarded UPDATE inside
     * the hold transaction (settlement.beginHold), so the status flip and the
     * held stage-1 outbox row commit together. paid_at marks WHEN THE HOLD
     * BEGAN (COALESCE): for a card/bank_transfer hold the customer was charged
     * at that moment; for a partner-pulled (ach_pull / bank_pull) hold nothing
     * has been pulled yet, but findInReviewOlderThan selects on paid_at, so a
     * NULL here would silently disable the >24h stale-review ops alert for
     * every held transfer. BLOCKED is excluded structurally: a sanctions hit
     * always lands as status 'blocked' today, but beginHold is directly
     * callable (partner-API confirmTransaction, reconcile fundhold) and the
     * predicate belongs in the UPDATE, not in the caller. Null ⇒ not
     * awaiting_payment anymore (already held / paid / cancelled) or blocked —
     * an idempotent no-op that never resurrects a terminal row.
     */
    async markInReviewIfAwaiting(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'in_review', paidAt: sql`COALESCE(${transfers.paidAt}, now())` })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.status, 'awaiting_payment'),
          ne(transfers.complianceStatus, 'blocked'),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * Atomically claim the in_review → paid transition — the STAFF RELEASE.
     * Deliberately NO 'cleared' predicate: a released transfer keeps
     * compliance_status = 'flagged' forever (the evidence is never rewritten),
     * and the admin-gated, audited release action IS the compliance decision.
     * BLOCKED is still excluded: the release path is reachable by a
     * PARTNER-scoped admin (releaseTransferAction = requireAdmin + canSee), so
     * sanctions-blocked money must be unreleasable in the UPDATE itself, even
     * if a future writer ever puts a blocked row in in_review. Used only
     * inside settlement.releaseHold, which enqueues the rail effect in the
     * same transaction — a release is a settlement, never a bare flip. Null ⇒
     * not in_review (never held / already released / rejected) or blocked —
     * an idempotent no-op that never resurrects a cancelled row.
     *
     * paid_at is RESET to now(): for a released hold paid_at means "released —
     * settlement started", not "charged" (beginHold stamped the hold start).
     * findStuckPaid keys its 15-minute clock on paid_at, so keeping the
     * hold-time value would make the first sweep after releasing any hold
     * older than 15 min enqueue reinstruct:<id> next to instruct:<id> and raise
     * a false recon: alert. No migration: transfers has no updated_at column.
     */
    async markPaidIfInReview(id: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'paid', paidAt: sql`now()` })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.status, 'in_review'),
          ne(transfers.complianceStatus, 'blocked'),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * Status-GUARDED staff edit: ONE `UPDATE … WHERE id = $1 AND status =
     * $expected RETURNING`. Staff actions read the row first (to validate and
     * to decide), and a full-row saveTransfer of that read would silently
     * overwrite anything that moved in between — e.g. a concurrent release
     * that already flipped in_review → paid and instructed the rail. Only the
     * named columns are written. Null ⇒ the row is missing or no longer in
     * `expected`; the caller must throw and enqueue nothing.
     */
    async updateIfStatus(
      id: string,
      expected: TransferStatus,
      patch: { status?: TransferStatus; adminNote?: string; assignedTo?: string },
    ): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set(patch)
        .where(and(eq(transfers.id, id), eq(transfers.status, expected)))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /** fix 6: may the pay page write this transfer's payout? (the same guard setPayoutIfEditable applies) */
    async isPayoutEditable(id: string, partnerId: PartnerId): Promise<boolean> {
      const rows = await db.select({ id: transfers.id }).from(transfers).where(payoutEditable(id, partnerId)).limit(1);
      return rows.length > 0;
    },

    /**
     * fix 6: the pay page's ONLY payout write on an existing transfer. Sets
     * payout_method, payout_destination_enc and payout_destination_last4 and
     * NOTHING else — never a whole-row upsert from a masked read (transferToRow
     * would write recipient_legal_name_enc = NULL and rewrite status/funding
     * columns from a stale read). Returns the updated (masked) row, or null
     * when any guard failed — the caller reports current truth.
     */
    async setPayoutIfEditable(
      id: string,
      partnerId: PartnerId,
      payout: { payoutMethod: PayoutMethod; payoutDestination: string },
    ): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({
          payoutMethod: payout.payoutMethod,
          payoutDestinationEnc: payout.payoutDestination ? encryptField(payout.payoutDestination, provider) : '',
          payoutDestinationLast4: last4(payout.payoutDestination),
        })
        .where(payoutEditable(id, partnerId))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * fix 6: the pay route's ONLY ACH-mandate write. Sets ach_token_ref and
     * NOTHING else, only while the row is this tenant's awaiting_payment B2B
     * transfer with no token yet — replacing the route's whole-row
     * saveTransfer of a masked read, which wrote recipient_legal_name_enc =
     * NULL and rewrote status from a stale read (a concurrent POST's paid flip
     * reverted → settled twice). Null ⇒ a guard failed; the caller re-reads
     * and reports current truth.
     */
    async setAchTokenIfAbsent(id: string, partnerId: PartnerId, token: string): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ achTokenRef: token })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.partnerId, partnerId),
          eq(transfers.status, 'awaiting_payment'),
          eq(transfers.transferType, 'b2b'),
          or(isNull(transfers.achTokenRef), eq(transfers.achTokenRef, '')),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /** fix 6: does this sender have ANY B2B transfer to this number? (tenant-scoped, one probe) */
    async hasB2bTransferTo(partnerId: PartnerId, phone: string, recipientPhone: string): Promise<boolean> {
      const rows = await db
        .select({ id: transfers.id })
        .from(transfers)
        .where(and(
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, phone),
          eq(transfers.recipientPhone, recipientPhone),
          eq(transfers.transferType, 'b2b'),
        ))
        .limit(1);
      return rows.length > 0;
    },

    /** fix 6: the sender's newest SETTLED consumer transfer to this number in this country — DECRYPTED (rehydration only). */
    async latestSettledConsumerTo(
      partnerId: PartnerId,
      phone: string,
      recipientPhone: string,
      destinationCountry: CountryCode,
    ): Promise<Transfer | null> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, phone),
          eq(transfers.recipientPhone, recipientPhone),
          eq(transfers.transferType, 'b2c'),
          inArray(transfers.status, ['paid', 'delivered']),
          eq(transfers.destinationCountry, destinationCountry),
        ))
        .orderBy(desc(transfers.createdAt))
        .limit(1);
      return rows[0] ? toDomain(rows[0], true) : null;
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

    /** Indexed per-(tenant, customer) page — a phone alone is not an identity (fix 1). */
    listByPhone(partnerId: PartnerId, phone: string, req: PageReq): Promise<Page<Transfer>> {
      return page(and(eq(transfers.partnerId, partnerId), eq(transfers.phone, phone)), req);
    },

    /** Staff-only unscoped list (server actions behind requireStaff). */
    adminList(req: PageReq & { partnerId?: PartnerId; status?: TransferStatus }): Promise<Page<Transfer>> {
      const conds = [
        req.partnerId ? eq(transfers.partnerId, req.partnerId) : undefined,
        req.status ? eq(transfers.status, req.status) : undefined,
      ].filter((c): c is NonNullable<typeof c> => Boolean(c));
      return page(conds.length ? and(...conds) : and(sql`true`), req);
    },

    /** Replaces the full-ledger scan in upsertOnFirstInbound (grandfathering, per tenant). */
    async firstTransferAt(partnerId: PartnerId, phone: string): Promise<string | null> {
      const rows = await db
        .select({ min: sql<string | null>`min(${transfers.createdAt})` })
        .from(transfers)
        .where(and(eq(transfers.partnerId, partnerId), eq(transfers.phone, phone)));
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
    async countByPhone(partnerId: PartnerId, phone: string): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(transfers)
        .where(
          and(
            eq(transfers.partnerId, partnerId),
            eq(transfers.phone, phone),
            sql`${transfers.status} != 'blocked'`,
          ),
        );
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

    /** cancelled + funding_ref set + refund_status 'none' — the capture↔cancel race; alert-only. */
    async findCancelledCharged(limit = 100): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(eq(transfers.status, 'cancelled'), isNotNull(transfers.fundingRef), eq(transfers.refundStatus, 'none')))
        .orderBy(transfers.createdAt)
        .limit(limit);
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
