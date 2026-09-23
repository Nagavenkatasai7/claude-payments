import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { auditEvents, idempotencyKeys, transfers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { last4, rowToTransfer, transferToRow, type TransferRow } from './mappers';
import { ctx } from '@/lib/crypto-context';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';
import type { CountryCode, PartnerId, PayoutMethod, RefundStatus, Transfer, TransferEnvironment, TransferStatus } from '@/lib/types';
import {
  encodeStatementCursor,
  type SettledTransfer,
  type StatementCursor,
} from '@/lib/settlement-statement';

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

/** Program fix 16: one sender's ledger totals for the cap, velocity and EDD checks. */
export interface SenderTotals {
  todayUsdCents: number;
  todayCount: number;
  monthUsdCents: number;
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

/**
 * Program-Fix 44 P2: every aggregate that feeds a live decision — send caps,
 * velocity, the EDD month, the fee tier, the T0 clock, AML history, the AML
 * sweep feed, the velocity leaderboard and the partner's settlements
 * statement — reads LIVE rows only, so a sandbox (test-key) transfer never
 * spends, ages or flags a live customer. Test mints are checked against the
 * same live totals (conservative: the sandbox cannot exceed what the real
 * sender could do) and add nothing to them.
 */
const LIVE_ONLY = eq(transfers.environment, 'live');

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
  // b2b-pay-finalize.ts, and fail the b2c test below.) Program-Fix 32: a
  // recurring-schedule mint claims 'sched:<scheduleId>:<easternDay>' under the
  // schedule's partner (cron-run.ts) and is exempt too — a scheduled link is
  // often minted with an EMPTY destination the customer enters on this page.
  // The partner API refuses the 'sched:' prefix at its edge as well
  // (createTransaction), so a 'sched:' key is never a partner claim. Either
  // partner-API marker locks the payout the partner supplied.
  const payoutEditable = (id: string, partnerId: PartnerId) =>
    and(
      eq(transfers.id, id),
      eq(transfers.partnerId, partnerId),
      eq(transfers.status, 'awaiting_payment'),
      isNull(transfers.fundingRef),
      eq(transfers.transferType, 'b2c'),
      sql`NOT EXISTS (SELECT 1 FROM ${idempotencyKeys} WHERE ${idempotencyKeys.transferId} = ${transfers.id} AND NOT (${idempotencyKeys.partnerId} = ${DEFAULT_PARTNER_ID} AND ${idempotencyKeys.key} LIKE 'draft:%') AND ${idempotencyKeys.key} NOT LIKE 'sched:%')`,
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
      // Program-Fix 44 P2: environment is WRITE-ONCE — the insert sets it, the
      // conflict-update never does, so a read-modify-write can never flip a
      // sandbox row to live (or back).
      const { environment: _env, ...updatable } = row;
      void _env;
      let set: Partial<typeof row> = updatable;
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
        } = updatable;
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
     * in_review) never move; equal-or-backward ranks no-op; an awaiting_payment
     * row that is not compliance-cleared never moves (Program-Fix 14). Non-null return ⇒
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
            // COMPLIANCE HOLDS (Program-Fix 14): a status update advances a row
            // out of awaiting_payment ONLY when the ledger says 'cleared' — the
            // same predicate as markPaidIfAwaiting, IN the UPDATE so a stale
            // read can never decide. A paid row already passed a gate (the
            // cleared claim, or the audited staff release — which keeps
            // compliance_status 'flagged' as evidence), so paid → delivered is
            // not re-gated on 'cleared'. Blocked never advances. Null ⇒ the
            // caller's alertCallbackOnHold (rail-failure.ts) raises the signal.
            sql`(${transfers.status} <> 'awaiting_payment' OR ${transfers.complianceStatus} = 'cleared')`,
            ne(transfers.complianceStatus, 'blocked'),
          ),
        )
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * fix 8 (money-02 / rail-02): the rail-failure CLAIM. Runs in the caller's
     * transaction: `SELECT … FOR UPDATE` (the row lock — a concurrent paid_out,
     * staff refund or sweep waits) and then ONE guarded UPDATE that moves only
     * a `paid` row: status → 'cancelled' (the existing terminal state, no new
     * status value), admin_note ← `note` (appended after any staff note), and
     * refund_status by the PRIOR value:
     *   none / requested + refundable → pending   (the caller enqueues refund:<id>)
     *   none / requested, NOT refundable → unchanged (partner-funded: no charge here)
     *   pending / completed / failed → unchanged   (a staff refund owns it)
     * "Refundable" = funding_ref IS NOT NULL (SmartRemit captured funds) OR a
     * partner-pulled leg (ach_pull / bank_pull — the worker posts the signed
     * REVERSE). Not a CTE: the caller branches on the prior refund status,
     * which a single UPDATE … RETURNING cannot show. Returns the locked prior
     * row (null when missing) and the updated row (null when not `paid`).
     * Drizzle 0.45.2: select().…().for('update') —
     * node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:586.
     */
    async failPaidFromRail(
      id: string,
      note: string,
    ): Promise<{ prior: Transfer | null; updated: Transfer | null }> {
      const locked = await db.select().from(transfers).where(eq(transfers.id, id)).limit(1).for('update');
      const prior = locked[0] ? toDomain(locked[0]) : null;
      if (!prior || prior.status !== 'paid') return { prior, updated: null };
      const rows = await db
        .update(transfers)
        .set({
          status: 'cancelled',
          // APPENDED, never clobbered: a rail must not erase a staff note.
          adminNote: sql`CASE WHEN COALESCE(${transfers.adminNote}, '') = '' THEN ${note} ELSE ${transfers.adminNote} || ' | ' || ${note} END`,
          refundStatus: sql`CASE
            WHEN ${transfers.refundStatus} IN ('none', 'requested')
              AND (${transfers.fundingRef} IS NOT NULL OR ${transfers.fundingMethod} IN ('ach_pull', 'bank_pull'))
              THEN 'pending'
            ELSE ${transfers.refundStatus}
          END`,
        })
        .where(and(eq(transfers.id, id), eq(transfers.status, 'paid')))
        .returning();
      return { prior, updated: rows[0] ? toDomain(rows[0]) : null };
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
     * Program-Fix 32 (neon-09): the unpaid-link expiry read — UNFUNDED
     * (funding_ref IS NULL) awaiting_payment rows created before `cutoff`,
     * oldest first, bounded. The same shape as listAwaitingWithFunding with the
     * funding predicate inverted: a charged row belongs to the funding-resume
     * sweep and is never listed here, and neither is a B2B invoice row. Served by transfers_status_paid (leading
     * `status`, schema.ts). Cross-tenant by design (a system sweep); every
     * write the caller makes is tenant-scoped (cancelIfCancellable).
     */
    async listStaleUnfunded(cutoff: Date, limit = 100): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(
          eq(transfers.status, 'awaiting_payment'),
          isNull(transfers.fundingRef),
          lt(transfers.createdAt, cutoff),
          // Review S1: consumer rows only. A B2B invoice row is owned by its
          // bill: b2b-pay-finalize replays a bound-and-minted row as ok, so an
          // expired invoice transfer would leave a bill that reads "done" but
          // can never be paid.
          eq(transfers.transferType, 'b2c'),
        ))
        .orderBy(transfers.createdAt)
        .limit(limit);
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
     * Program-Fix 14 follow-up: record a pay-time RE-SCREEN verdict on a row
     * that is still this tenant's awaiting_payment transfer. ONE guarded,
     * column-targeted UPDATE (compliance_status, compliance_reasons and, for a
     * block, status) — never a whole-row re-save.
     *  • 'blocked' always wins. An UNCHARGED row becomes status 'blocked' (the
     *    same shape a mint-time hit lands in). A CHARGED row (funding_ref set:
     *    a crash between capture and settlement) keeps status awaiting_payment
     *    so the funding-resume sweep still reaches settleOrHold → refused and
     *    raises its fundblocked:<id> alert for a refund.
     *  • 'flagged' never downgrades a blocked row.
     * `reasons` is the caller's merged list (existing + new, de-duplicated).
     * Null ⇒ a guard failed (moved, cancelled, blocked, another tenant); the
     * caller re-reads and reports current truth.
     * Drizzle 0.45.2: update().set().where().returning() —
     * node_modules/drizzle-orm/pg-core/query-builders/update.d.ts:43,143,166.
     */
    async applyRescreenIfAwaiting(
      id: string,
      partnerId: PartnerId,
      verdict: 'blocked' | 'flagged',
      reasons: string[],
    ): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set(verdict === 'blocked'
          ? {
              complianceStatus: 'blocked',
              complianceReasons: reasons,
              status: sql`CASE WHEN ${transfers.fundingRef} IS NULL THEN 'blocked' ELSE ${transfers.status} END`,
            }
          : { complianceStatus: 'flagged', complianceReasons: reasons })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.partnerId, partnerId),
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

    /**
     * Atomically VOID an UNFUNDED draft: the ONLY cancel write, used by staff
     * Cancel (dashboard-ops.cancelTransfer) and the customer chat cancel_bill
     * (tools.ts), both via store.cancelTransferIfUnfunded (Phase 1 Task 5 /
     * Program-Fix 9 / money-05; ruling 22's "awaiting_payment only"). ONE
     * guarded UPDATE:
     *   WHERE id = $1 AND partner_id = $2
     *     AND status = 'awaiting_payment' AND funding_ref IS NULL
     * • partner_id = $2 is the tenant scope: another tenant's id is a no-op
     *   (null, row untouched), so a caller can never void outside its tenant.
     * • funding_ref IS NULL means "never charged". The capture seam writes it
     *   (write-once, setFundingRef) BEFORE any settlement claim. A charged
     *   awaiting_payment row is still resumed by listAwaitingWithFunding.
     * • in_review NEVER matches, charged or not. Ending a compliance hold is
     *   the compliance decision, so it leaves in_review only via Release or
     *   Reject (both requireAdmin). This predicate enforces that for every
     *   Cancel path (Wave 2 review).
     * • paid / delivered / blocked / cancelled never match. Cancel commits NO
     *   refund or reversal effect, so it may never touch a row with money
     *   behind it.
     * Column-targeted (status only): encrypted columns are never rewritten.
     * Null ⇒ not voidable NOW (a concurrent paid flip, hold or capture won).
     * The caller re-reads and refuses; it must NEVER fall back to saveTransfer.
     * Residual (alerted, not closed here): a PSP capture that has charged but
     * not yet written funding_ref is invisible to this predicate. reconcile's
     * cancelcharged:<id> alert (findCancelledCharged) is the net for it.
     * Drizzle 0.45.2: update().set().where().returning() —
     * node_modules/drizzle-orm/pg-core/query-builders/update.d.ts:43,143,166;
     * isNull — node_modules/drizzle-orm/sql/expressions/conditions.d.ts:206.
     */
    async cancelIfCancellable(id: string, partnerId: PartnerId): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ status: 'cancelled' })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.partnerId, partnerId),
          eq(transfers.status, 'awaiting_payment'),
          isNull(transfers.fundingRef),
        ))
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },

    /**
     * The customer's update_recipient_phone edit: ONE UPDATE that sets only
     * recipient_phone (a plain, unencrypted column), scoped to the tenant AND
     * the owning sender in the WHERE. Every other column stays as the ledger
     * has it at write time. Null ⇒ no such row for this owner/tenant now; the
     * caller refuses and never falls back to saveTransfer.
     * Unpaid only: the WHERE also requires status awaiting_payment with no
     * paid_at, no captured funding (funding_ref) and no settlement instruction
     * acknowledged (payment_provider_ref), so the check and the write are one
     * atomic statement. Null also covers "money already involved"; the caller
     * re-reads to tell that apart from a missing row.
     */
    async updateRecipientPhone(
      id: string,
      partnerId: PartnerId,
      ownerPhone: string,
      recipientPhone: string,
    ): Promise<Transfer | null> {
      const rows = await db
        .update(transfers)
        .set({ recipientPhone })
        .where(and(
          eq(transfers.id, id),
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, ownerPhone),
          eq(transfers.status, 'awaiting_payment'),
          isNull(transfers.paidAt),
          isNull(transfers.fundingRef),
          isNull(transfers.paymentProviderRef),
        ))
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
     * NOTHING else — never a whole-row upsert of a stale read: it rewrites the
     * status / funding columns from that read, and when the re-saved row
     * carries a REAL destination (no mask, so saveTransfer's mask guard does
     * not engage) it writes recipient_legal_name_enc = NULL, which the default
     * read omits. Returns the updated (masked) row, or null when any guard
     * failed — the caller reports current truth.
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
          payoutDestinationEnc: payout.payoutDestination
            ? encryptField(payout.payoutDestination, provider, ctx.transfer(id, 'payout_destination_enc')) // row id = the WHERE's id
            : '',
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
     * saveTransfer of a stale read, which rewrote status and ach_token_ref from
     * that read (a concurrent POST's paid flip reverted → settled twice) and,
     * when the read carried no mask, wrote recipient_legal_name_enc = NULL.
     * Null ⇒ a guard failed; the caller re-reads and reports current truth.
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

    /**
     * fix 6: does this sender have ANY B2B transfer to this number? (tenant-scoped, one probe)
     * The stored recipient_phone is compared by its DIGITS — the same rule as
     * phone.normalizePhone, which the address-book match applies in
     * resolveStoredPayout — so a B2B row stored with a formatted number still
     * blocks rehydration (a wider match here is the SAFE direction).
     * `recipientPhone` must already be normalized (digits only).
     */
    async hasB2bTransferTo(partnerId: PartnerId, phone: string, recipientPhone: string): Promise<boolean> {
      const rows = await db
        .select({ id: transfers.id })
        .from(transfers)
        .where(and(
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, phone),
          sql`regexp_replace(${transfers.recipientPhone}, '[^0-9]', '', 'g') = ${recipientPhone}`,
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
          // Program-Fix 44 P2: a sandbox row can NEVER become a live customer's
          // rehydrated payout (a test key must not plant a destination).
          LIVE_ONLY,
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
        ? sql`WHERE (created_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date AND partner_id = ${partnerId} AND environment = 'live'`
        : sql`WHERE (created_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date AND environment = 'live'`;
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

    /**
     * Program-Fix 31 PR A (rail-11): the partner settlements statement page.
     * partnerId is REQUIRED and first (like getOwnedTransfer) — there is no
     * unscoped variant. Rows:
     *   partner_id = $p AND paid_at IS NOT NULL AND from <= paid_at < to
     *   AND (status IN ('paid','delivered')
     *        OR (status = 'cancelled' AND payment_provider_ref IS NOT NULL))
     * never in_review (markInReviewIfAwaiting stamps paid_at at the HOLD, not
     * at an instruction), and a cancelled row only when a rail was instructed
     * (a staff-rejected hold keeps its hold-time paid_at but has no ref). A
     * released hold appears at its release time (markPaidIfInReview resets
     * paid_at). Keyset ascending on (paid_at, id). The cursor compares the
     * Postgres TEXT of paid_at IN SQL — never a JS Date (ms), which would
     * repeat/skip rows sharing a millisecond — and the cursor is validated by
     * the caller (settlement-statement.decodeStatementCursor) before this cast.
     * Selects ONLY the statement columns: no settlement_partner_id, payout
     * destination, recipient or sender identity is ever read here.
     * Drizzle 0.45.2: select(fields) partial selection —
     * node_modules/drizzle-orm/pg-core/db.d.ts:146; sql`…`.as(alias) —
     * node_modules/drizzle-orm/sql/sql.d.ts:84; gte/lt —
     * node_modules/drizzle-orm/sql/expressions/conditions.d.ts:124,139; asc —
     * node_modules/drizzle-orm/sql/expressions/select.d.ts:21.
     */
    async listSettledPage(
      partnerId: PartnerId,
      from: Date,
      to: Date,
      req: { limit: number; cursor: StatementCursor | null },
    ): Promise<{ items: SettledTransfer[]; nextCursor: string | null }> {
      const conds = [
        eq(transfers.partnerId, partnerId),
        isNotNull(transfers.paidAt),
        gte(transfers.paidAt, from),
        lt(transfers.paidAt, to),
        sql`(${transfers.status} IN ('paid','delivered') OR (${transfers.status} = 'cancelled' AND ${transfers.paymentProviderRef} IS NOT NULL))`,
        LIVE_ONLY, // Program-Fix 44 P2: a sandbox row was never instructed — not a settlement
      ];
      if (req.cursor) {
        conds.push(
          sql`(${transfers.paidAt}, ${transfers.id}) > (${req.cursor.paidAtText}::timestamptz, ${req.cursor.id})`,
        );
      }
      const rows = await db
        .select({
          id: transfers.id,
          status: transfers.status,
          complianceStatus: transfers.complianceStatus,
          refundStatus: transfers.refundStatus,
          amountSource: transfers.amountSource,
          sourceCurrency: transfers.sourceCurrency,
          feeSource: transfers.feeSource,
          totalChargeSource: transfers.totalChargeSource,
          fxRate: transfers.fxRate,
          amountDest: transfers.amountDest,
          destinationCurrency: transfers.destinationCurrency,
          destinationCountry: transfers.destinationCountry,
          payoutMethod: transfers.payoutMethod,
          paymentProviderRef: transfers.paymentProviderRef,
          fundingRef: transfers.fundingRef,
          refundRef: transfers.refundRef,
          createdAt: transfers.createdAt,
          paidAt: transfers.paidAt,
          deliveredAt: transfers.deliveredAt,
          refundedAt: transfers.refundedAt,
          // Fixed-format UTC text (6 µs digits, '+00') — independent of the
          // session TimeZone and DateStyle, so the cursor always validates.
          paidAtText: sql<string>`to_char(${transfers.paidAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`.as('paid_at_text'),
        })
        .from(transfers)
        .where(and(...conds))
        .orderBy(asc(transfers.paidAt), asc(transfers.id))
        .limit(req.limit + 1);
      const pageRows = rows.slice(0, req.limit);
      const items: SettledTransfer[] = pageRows.map((r) => ({
        id: r.id,
        status: r.status as TransferStatus,
        complianceStatus: r.complianceStatus as SettledTransfer['complianceStatus'],
        refundStatus: (r.refundStatus ?? 'none') as RefundStatus,
        amountSource: Number(r.amountSource),
        sourceCurrency: r.sourceCurrency as SettledTransfer['sourceCurrency'],
        feeSource: Number(r.feeSource),
        totalChargeSource: Number(r.totalChargeSource),
        fxRate: Number(r.fxRate),
        amountInr: Number(r.amountDest),
        destinationCurrency: (r.destinationCurrency ?? undefined) as SettledTransfer['destinationCurrency'],
        destinationCountry: r.destinationCountry as CountryCode,
        payoutMethod: r.payoutMethod as PayoutMethod,
        paymentProviderRef: r.paymentProviderRef ?? undefined,
        fundingRef: r.fundingRef ?? undefined,
        refundRef: r.refundRef ?? undefined,
        createdAt: r.createdAt.toISOString(),
        paidAt: r.paidAt ? r.paidAt.toISOString() : undefined,
        deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : undefined,
        refundedAt: r.refundedAt ? r.refundedAt.toISOString() : undefined,
      }));
      const last = pageRows[pageRows.length - 1];
      return {
        items,
        nextCursor: rows.length > req.limit && last ? encodeStatementCursor(last.paidAtText, last.id) : null,
      };
    },

    /**
     * Indexed per-(tenant, customer) page — a phone alone is not an identity (fix 1).
     * Program-Fix 44 P2: LIVE rows only — this is the customer's own history (chat
     * tools, /account portal, support, staff customer page); a partner's sandbox
     * mint on the same number never appears in it.
     */
    listByPhone(partnerId: PartnerId, phone: string, req: PageReq): Promise<Page<Transfer>> {
      return page(and(eq(transfers.partnerId, partnerId), eq(transfers.phone, phone), LIVE_ONLY), req);
    },

    /** Staff-only unscoped list (server actions behind requireStaff). */
    adminList(
      req: PageReq & { partnerId?: PartnerId; status?: TransferStatus; environment?: TransferEnvironment },
    ): Promise<Page<Transfer>> {
      const conds = [
        req.partnerId ? eq(transfers.partnerId, req.partnerId) : undefined,
        req.status ? eq(transfers.status, req.status) : undefined,
        // Program-Fix 44 P2: the Partner API lists one environment; staff lists pass none.
        req.environment ? eq(transfers.environment, req.environment) : undefined,
      ].filter((c): c is NonNullable<typeof c> => Boolean(c));
      return page(conds.length ? and(...conds) : and(sql`true`), req);
    },

    /** Replaces the full-ledger scan in upsertOnFirstInbound (grandfathering, per tenant). */
    async firstTransferAt(partnerId: PartnerId, phone: string): Promise<string | null> {
      const rows = await db
        .select({ min: sql<string | null>`min(${transfers.createdAt})` })
        .from(transfers)
        // Program-Fix 44 P2: live rows only — a sandbox mint never starts (or
        // ages) a live customer's T0 window.
        .where(and(eq(transfers.partnerId, partnerId), eq(transfers.phone, phone), LIVE_ONLY));
      const v = rows[0]?.min;
      return v ? new Date(v).toISOString() : null;
    },

    /**
     * Program fix 16 (Task 10): the send-cap, velocity and EDD totals in ONE
     * indexed query (transfers_phone_created) over a plain created_at range —
     * no Redis counter decides a cap or a flag any more. Tenant-scoped.
     *   todayUsdCents  = Σ amount_usd (cents) since dayStart, excluding blocked
     *                    and cancelled (a cancelled row moved no money: fix 9's
     *                    void, fix 8's rail failure) — the daily cap;
     *   todayCount     = rows since dayStart excluding only blocked (awaiting
     *                    rows count, like countByPhone) — the velocity flag;
     *   monthUsdCents  = Σ amount_usd since monthStart with the same exclusions
     *                    — the rolling-month EDD total.
     * The bounds are passed in (dates.ts easternDayStart/easternMonthStart)
     * so fake timers work and the query is a plain range. Under the sender
     * lock (store.mintUnderSenderLock, READ COMMITTED) this sees the previous
     * holder's committed insert.
     */
    async senderTotalsSince(
      partnerId: PartnerId,
      phone: string,
      dayStart: Date,
      monthStart: Date,
    ): Promise<SenderTotals> {
      const rows = await db
        .select({
          todayUsdCents: sql<number>`coalesce(sum(round(${transfers.amountUsd} * 100)) filter (where ${transfers.createdAt} >= ${dayStart} and ${transfers.status} not in ('blocked', 'cancelled')), 0)::bigint`,
          todayCount: sql<number>`count(*) filter (where ${transfers.createdAt} >= ${dayStart} and ${transfers.status} != 'blocked')::int`,
          monthUsdCents: sql<number>`coalesce(sum(round(${transfers.amountUsd} * 100)) filter (where ${transfers.status} not in ('blocked', 'cancelled')), 0)::bigint`,
        })
        .from(transfers)
        .where(
          and(
            eq(transfers.partnerId, partnerId),
            eq(transfers.phone, phone),
            sql`${transfers.createdAt} >= ${monthStart}`,
            LIVE_ONLY, // Program-Fix 44 P2: a sandbox row never spends live headroom
          ),
        );
      const r = rows[0];
      // bigint sums arrive as strings from pg; cents fit a JS number.
      return {
        todayUsdCents: Number(r?.todayUsdCents ?? 0),
        todayCount: Number(r?.todayCount ?? 0),
        monthUsdCents: Number(r?.monthUsdCents ?? 0),
      };
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
            LIVE_ONLY, // Program-Fix 44 P2: a sandbox mint never burns the free first transfer
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

    // ── Program-Fix 43: behavioural AML sweep reads (aml-sweep.ts) ──────────

    /**
     * The sweep's keyset scan: rows strictly after `after` in (created_at, id)
     * order and created strictly before `before` (the commit-lag guard, so a
     * slow mint transaction is never skipped), ascending, bounded. MASKED rows;
     * the sweep decrypts one row at a time with getTransfer. Cross-tenant by
     * design (a system sweep). No leading created_at index exists, so this is a
     * sequential scan of transfers — acceptable at the current size; PR C's
     * migration slice can add one.
     */
    async listCreatedSince(after: { at: Date; id: string }, before: Date, limit: number): Promise<Transfer[]> {
      const rows = await db
        .select()
        .from(transfers)
        .where(and(
          or(
            sql`${transfers.createdAt} > ${after.at}`,
            and(sql`${transfers.createdAt} = ${after.at}`, sql`${transfers.id} > ${after.id}`),
          ),
          lt(transfers.createdAt, before),
          LIVE_ONLY, // Program-Fix 44 P2: the AML sweep never scans sandbox rows
        ))
        .orderBy(asc(transfers.createdAt), asc(transfers.id))
        .limit(limit);
      return rows.map((r) => toDomain(r));
    },

    /**
     * One sender's AML aggregates over rows STRICTLY BEFORE `anchor` in
     * (created_at, id) order, tenant-keyed (partner_id, phone), excluding
     * blocked and cancelled rows (a cancelled row moved no money — fix 16):
     *   bandCount7d     — amount_usd in [band·T, T) within 7 days before;
     *   subTSumCents30d — Σ amount_usd (cents) of rows < T within 30 days before;
   *   subTCount30d    — how many rows < T within 30 days before;
     *   priorCount      — all-time earlier rows.
     * Anchored on the transfer, not the sweep clock, so a re-scan is deterministic.
     * Served by transfers_phone_created.
     */
    async senderAmlStats(
      partnerId: PartnerId,
      phone: string,
      anchor: { at: Date; id: string },
      largeAmountUsd: number,
      band: number,
    ): Promise<{ bandCount7d: number; subTSumCents30d: number; subTCount30d: number; priorCount: number }> {
      const d7 = new Date(anchor.at.getTime() - 7 * 86_400_000);
      const d30 = new Date(anchor.at.getTime() - 30 * 86_400_000);
      const lower = band * largeAmountUsd;
      const rows = await db
        .select({
          bandCount7d: sql<number>`count(*) filter (where ${transfers.createdAt} >= ${d7} and ${transfers.amountUsd} >= ${lower} and ${transfers.amountUsd} < ${largeAmountUsd})::int`,
          subTSumCents30d: sql<number>`coalesce(sum(round(${transfers.amountUsd} * 100)) filter (where ${transfers.createdAt} >= ${d30} and ${transfers.amountUsd} < ${largeAmountUsd}), 0)::bigint`,
          subTCount30d: sql<number>`count(*) filter (where ${transfers.createdAt} >= ${d30} and ${transfers.amountUsd} < ${largeAmountUsd})::int`,
          priorCount: sql<number>`count(*)::int`,
        })
        .from(transfers)
        .where(and(
          eq(transfers.partnerId, partnerId),
          eq(transfers.phone, phone),
          sql`${transfers.status} not in ('blocked', 'cancelled')`,
          LIVE_ONLY, // Program-Fix 44 P2: sandbox rows are never AML history
          or(
            sql`${transfers.createdAt} < ${anchor.at}`,
            and(sql`${transfers.createdAt} = ${anchor.at}`, sql`${transfers.id} < ${anchor.id}`),
          ),
        ));
      const r = rows[0];
      return {
        bandCount7d: Number(r?.bandCount7d ?? 0),
        subTSumCents30d: Number(r?.subTSumCents30d ?? 0),
        subTCount30d: Number(r?.subTCount30d ?? 0),
        priorCount: Number(r?.priorCount ?? 0),
      };
    },

    /** Masked rows by id, pinned to `partnerId` when given (the compliance alerts card). */
    async listByIdsScoped(ids: string[], partnerId?: PartnerId): Promise<Transfer[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select()
        .from(transfers)
        .where(and(inArray(transfers.id, ids), partnerId ? eq(transfers.partnerId, partnerId) : undefined));
      return rows.map((r) => toDomain(r));
    },
  };
}

export type TransferRepo = ReturnType<typeof createTransferRepo>;
