import { sql } from 'drizzle-orm';
import { getRedis } from './redis';
import { easternDayStart, easternMonthStart } from './dates';
import { SendBusyError } from './send-limits';
import { getDb, type Db } from '@/db/client';
import { createTransferRepo, type SenderTotals } from '@/db/repos/transfer-repo';
import { createRecipientRepo, createCorridorRequestRepo, createPartnerRequestRepo, createPartnerApplicationRepo, createB2bInvoiceRepo, createSellerRepo, createAuditRepo, type AuditEvent } from '@/db/repos/aux-repos';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { legacyKeyAllowed, legacyTenantResolver } from './legacy-tenant';
import type { CapSubject } from './tier-rules';
import type { ChatMessage, CountryCode, KycStatus, PartnerId, SendLimitOverride, Transfer, TransferStatus } from './types';

/**
 * The ONLY operations a locked mint body may perform (Program fix 16). All of
 * them are bound to the lock's transaction; there is deliberately no store,
 * partner store or volume store in scope, so a root-handle call inside the
 * lock cannot compile.
 */
export interface SenderLedgerOps {
  totals(now?: Date): Promise<SenderTotals>;
  getTransfer(id: string): Promise<Transfer | null>;
  insertTransfer(t: Transfer): Promise<void>;
  /** Program-Fix 14: the sanctions.screen evidence row, in the SAME transaction as the insert. */
  recordAudit(e: AuditEvent): Promise<void>;
}

/** SQLSTATE 55P03 lock_not_available — from `SET LOCAL lock_timeout` — direct or wrapped. */
function isLockTimeout(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth++) {
    if ((e as { code?: unknown }).code === '55P03') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// store — CUT OVER to a COMPOSITE (Stage 2a). Same module path + surface; the
// engine split follows the locked disposition:
//   • LEDGER → Postgres repos: transfers (atomic rank-guarded webhook machine,
//     keyset queries), saved recipients, corridor requests, derived transfer
//     counts. Encrypted payout destinations ride along (mappers).
//   • HOT/EPHEMERAL → Redis: conversations, inbound msg dedup, lastmsg
//     recency, migration sentinels. (The today-velocity / daily / monthly
//     counters were deleted in Program fix 16 — every cap figure is a ledger
//     aggregate now, see senderTotals below.)
// Fresh start: the legacy Redis ledger keys (transfer:*, transfers:ids,
// count:*, recipients:*, corridor_request:*) are abandoned, and the pre-P1/P2
// lazy-fill shims are gone with them.

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  /** Program-Fix 17: the staff-login success refund (staff-login-guard.refundStaffAttempt). */
  decr(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  hdel(key: string, field: string): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  exists(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

const MAX_HISTORY = 40;

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let trimmed = messages.slice(messages.length - MAX_HISTORY);
  while (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

// `db` is the ROOT handle (never a tx): mintUnderSenderLock opens its own
// transaction with an isolation level, which only PgDatabase.transaction takes.
export function createStore(redis: RedisLike, db: Db) {
  const transfersRepo = createTransferRepo(db);
  const recipientsRepo = createRecipientRepo(db);
  const corridorRepo = createCorridorRequestRepo(db);
  const partnerReqRepo = createPartnerRequestRepo(db);
  const partnerAppRepo = createPartnerApplicationRepo(db);
  const b2bInvoiceRepo = createB2bInvoiceRepo(db);
  const sellerRepo = createSellerRepo(db);
  // D9/D10/D12 (fix 1): which tenant may read a pre-fix phone-only Redis key —
  // the phone's OLDEST customers row (see legacy-tenant.ts). Built once.
  const customersRepo = createCustomerRepo(db, (p, ph) => transfersRepo.firstTransferAt(p, ph));
  const legacyTenantOf = legacyTenantResolver(customersRepo);

  return {
    /** The D9 legacy-tenant resolver, shared with the volume + KYC-audit stores. */
    legacyTenantOf,

    // ── Conversations (Redis — hot, trimmed, ephemeral; keyed by TENANT + phone, fix 1 D12) ──
    // TRANSITIONAL (one 30-day window): a tenant key that does not exist reads
    // through to the pre-fix `conv:{phone}` ONLY for the phone's pre-fix tenant,
    // so a customer mid-conversation at deploy time keeps their thread and a
    // post-fix sibling tenant never sees another tenant's history. Saves always
    // write the tenant key, so the legacy key is read at most once per thread.
    async getConversation(partnerId: PartnerId, phone: string): Promise<ChatMessage[]> {
      const raw = await redis.get(`conv:${partnerId}:${phone}`);
      if (raw !== null) return JSON.parse(raw) as ChatMessage[];
      if (!(await legacyKeyAllowed(partnerId, phone, legacyTenantOf))) return [];
      const legacy = await redis.get(`conv:${phone}`);
      return legacy ? (JSON.parse(legacy) as ChatMessage[]) : [];
    },
    async saveConversation(partnerId: PartnerId, phone: string, messages: ChatMessage[]): Promise<void> {
      await redis.set(`conv:${partnerId}:${phone}`, JSON.stringify(trimHistory(messages)), { ex: 30 * 24 * 3600 });
    },

    // ── Transfer ledger (Postgres) ───────────────────────────────────────
    async getTransfer(id: string): Promise<Transfer | null> {
      return transfersRepo.getTransfer(id);
    },
    /** Decrypted read for the few sites that genuinely need the full payout
     *  destination (settlement instruction build, receipt). */
    async getTransferDecrypted(id: string): Promise<Transfer | null> {
      return transfersRepo.getTransfer(id, { decrypt: true });
    },
    async saveTransfer(transfer: Transfer): Promise<void> {
      await transfersRepo.saveTransfer(transfer);
    },
    /**
     * Program-Fix 14 (step 5): the quote-time blocked row and its
     * sanctions.screen evidence row in ONE transaction — both land or neither
     * does. recordBlockedAttempt uses it whenever it has evidence.
     */
    async recordBlockedWithEvidence(transfer: Transfer, audit: AuditEvent): Promise<void> {
      await db.transaction(async (tx) => {
        await createTransferRepo(tx).saveTransfer(transfer);
        await createAuditRepo(tx).record(audit);
      });
    },
    /**
     * Program-Fix 14 (step 6): a standalone audit_events row on the root handle
     * (register_seller's sanctions.screen evidence, written after the seller
     * row). Callers treat it as best-effort.
     */
    async recordAudit(e: AuditEvent): Promise<void> {
      await createAuditRepo(db).record(e);
    },
    /** Status-guarded staff edit (assign) — see transfer-repo.updateIfStatus. Cancel
     *  uses cancelTransferIfUnfunded; reject claims inside its own transaction. */
    async updateTransferIfStatus(
      id: string,
      expected: TransferStatus,
      patch: { status?: TransferStatus; adminNote?: string; assignedTo?: string },
    ): Promise<Transfer | null> {
      return transfersRepo.updateIfStatus(id, expected, patch);
    },
    /** Atomic VOID of an unfunded draft (awaiting_payment with no fundingRef;
     *  never an in_review hold) → cancelled: transfer-repo.cancelIfCancellable,
     *  tenant-scoped by partnerId in the WHERE. Callers: dashboard-ops.cancelTransfer
     *  (staff) and tools.ts cancel_bill (customer chat). Null ⇒ not voidable now
     *  (or not this tenant's row); the caller refuses and never falls back to
     *  saveTransfer. */
    async cancelTransferIfUnfunded(id: string, partnerId: PartnerId): Promise<Transfer | null> {
      return transfersRepo.cancelIfCancellable(id, partnerId);
    },
    async updateTransferFromWebhook(
      transferId: string,
      status: TransferStatus,
    ): Promise<Transfer | null> {
      // Single rank-guarded UPDATE — atomic under concurrent callbacks.
      return transfersRepo.updateTransferFromWebhook(transferId, status);
    },
    async listTransfers(): Promise<Transfer[]> {
      return transfersRepo.listAll();
    },
    /** Indexed per-(tenant, customer) list (Stage 4 + fix 1). */
    async listTransfersByPhone(partnerId: PartnerId, phone: string, limit = 50): Promise<Transfer[]> {
      return (await transfersRepo.listByPhone(partnerId, phone, { limit })).items;
    },
    /** Keyset page for staff views (Stage 4). Scope via partnerId. */
    async listTransfersPage(req: {
      limit: number;
      cursor?: string;
      partnerId?: import('./types').PartnerId;
      status?: TransferStatus;
    }): Promise<import('@/db/repos/transfer-repo').Page<Transfer>> {
      return transfersRepo.adminList(req);
    },
    /** One-query SQL aggregates for the dashboard (Stage 4). */
    async transfersSummary(partnerId?: import('./types').PartnerId) {
      return transfersRepo.summary(partnerId);
    },
    /** Compliance views by compliance_status (Stage 5e scan fixes). */
    async listTransfersByCompliance(
      complianceStatus: 'flagged' | 'blocked',
      opts: { partnerId?: import('./types').PartnerId; limit?: number } = {},
    ): Promise<Transfer[]> {
      return transfersRepo.listByCompliance(complianceStatus, opts);
    },
    /** Today's velocity leaderboard — one GROUP BY, not a ledger scan. */
    async topVelocityToday(limit: number, partnerId?: import('./types').PartnerId) {
      return transfersRepo.topVelocityToday(limit, partnerId);
    },
    async getTransferCount(partnerId: PartnerId, phone: string): Promise<number> {
      // Derived (blocked rows excluded) — the count:{phone} counter is gone.
      return transfersRepo.countByPhone(partnerId, phone);
    },
    /** MIN(created_at) for grandfathering — indexed, per tenant. */
    async firstTransferAt(partnerId: PartnerId, phone: string): Promise<string | null> {
      return transfersRepo.firstTransferAt(partnerId, phone);
    },
    /** fix 6: EXISTS a B2B transfer from this sender to this number (tenant-scoped). */
    async hasB2bTransferTo(partnerId: PartnerId, phone: string, recipientPhone: string): Promise<boolean> {
      return transfersRepo.hasB2bTransferTo(partnerId, phone, recipientPhone);
    },
    /** fix 6: DECRYPTED newest settled consumer transfer to this number in this country (rehydration only). */
    async latestSettledConsumerTransferTo(
      partnerId: PartnerId,
      phone: string,
      recipientPhone: string,
      destinationCountry: CountryCode,
    ): Promise<Transfer | null> {
      return transfersRepo.latestSettledConsumerTo(partnerId, phone, recipientPhone, destinationCountry);
    },

    // ── Sender totals + the locked mint (Program fix 16 / Task 10) ────────
    // The Redis velocity / daily / monthly counters are GONE (ruling 30): every
    // figure a cap or a flag reads is an aggregate over `transfers`, computed
    // by transfer-repo.senderTotalsSince over ET bounds. The pre-fix legacy
    // dual-read for these counters is gone with them; legacyTenantOf stays for
    // the conv: and kyc_audit: fallbacks only.
    /** Today's transfer count for the velocity flag — a ledger count (blocked excluded). */
    async getTodayTransferCount(partnerId: PartnerId, phone: string): Promise<number> {
      const now = new Date();
      return (await transfersRepo.senderTotalsSince(partnerId, phone, easternDayStart(now), easternMonthStart(now))).todayCount;
    },
    /** Unlocked read (display, the pre-claim cap check, the tools' check_send_limit). */
    async senderTotals(partnerId: PartnerId, phone: string, now: Date = new Date()): Promise<SenderTotals> {
      return transfersRepo.senderTotalsSince(partnerId, phone, easternDayStart(now), easternMonthStart(now));
    },
    /**
     * The tier subject createTransfer evaluates INSIDE the lock, read before
     * it: firstSeenAt from the tenant's customers row, else the tenant's first
     * transfer, else now (a brand-new sender is T0). kycStatus is the caller's
     * attestation (input.senderKycStatus) — the same value the KYC backstop
     * already trusts. Tenant-scoped on both reads.
     */
    async capSubject(
      partnerId: PartnerId,
      phone: string,
      kycStatus: KycStatus,
      now: Date = new Date(),
    ): Promise<CapSubject & { sendLimitOverride?: SendLimitOverride }> {
      const row = await customersRepo.getCustomer(partnerId, phone);
      const firstSeenAt =
        row?.firstSeenAt ?? (await transfersRepo.firstTransferAt(partnerId, phone)) ?? now.toISOString();
      // Program fix 16b: the customer's raise rides along (same row, no extra
      // query on the hot path) so createTransfer resolves the effective limits.
      return { firstSeenAt, kycStatus, sendLimitOverride: row?.sendLimitOverride };
    },
    /**
     * ONE locked mint per (partner, phone). Opens a READ COMMITTED transaction
     * (each statement after the lock sees the previous holder's committed
     * insert — under REPEATABLE READ the snapshot would predate the wait),
     * bounds the wait with `SET LOCAL lock_timeout = '5s'`, takes
     * `pg_advisory_xact_lock(hashtext('<partnerId>:<phone>'))` BEFORE any other
     * statement, and hands `fn` tx-bound operations ONLY (no root handle can
     * reach in: a root-handle call would deadlock PGlite's single connection and
     * hold a second Neon pool connection per mint). A throw inside `fn` rolls
     * everything back. A lock wait past 5 s (SQLSTATE 55P03) surfaces as the
     * retryable SendBusyError with nothing written.
     */
    async mintUnderSenderLock<T>(
      partnerId: PartnerId,
      phone: string,
      fn: (ops: SenderLedgerOps) => Promise<T>,
    ): Promise<T> {
      try {
        return await db.transaction(
          async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${partnerId}:${phone}`}))`);
            const repo = createTransferRepo(tx);
            const audit = createAuditRepo(tx);
            return fn({
              totals: (now: Date = new Date()) =>
                repo.senderTotalsSince(partnerId, phone, easternDayStart(now), easternMonthStart(now)),
              getTransfer: (id) => repo.getTransfer(id),
              insertTransfer: (t) => repo.saveTransfer(t),
              recordAudit: (e) => audit.record(e),
            });
          },
          { isolationLevel: 'read committed' },
        );
      } catch (err) {
        if (isLockTimeout(err)) throw new SendBusyError();
        throw err;
      }
    },

    // ── Inbound plumbing (Redis) ─────────────────────────────────────────
    async markMessageSeen(wamid: string): Promise<boolean> {
      const result = await redis.set(`msg:${wamid}`, '1', { ex: 600, nx: true });
      return result !== null;
    },
    // Idempotency for the inline "Approve & Pay" card. The agent.turn outbox row
    // is at-least-once, and the model can call send_approve_picker twice in one
    // turn — both would emit a SECOND card + a NEW pay link. Returns true the
    // FIRST time a given (sender+content) card is sent within the TTL, false on a
    // duplicate. The 120s TTL covers the realistic transient retry (the early
    // backoff attempts land within seconds); it deliberately does NOT span the
    // full 8-attempt window (~254s to the last retry) so that a genuinely new
    // identical send a couple of minutes later still goes through — losing the
    // dedupe on a turn that fails for >2min is far better than suppressing a
    // legitimate re-send. Worst case past the TTL is ONE extra card, not the
    // every-retry duplication this replaces.
    async markApproveCardSent(key: string): Promise<boolean> {
      const result = await redis.set(`approvecard:${key}`, '1', { ex: 120, nx: true });
      return result !== null;
    },
    // Release a claimed card key when the send itself FAILED, so the at-least-once
    // retry can re-deliver. Without this, a thrown sendCtaUrl (network reject)
    // would leave the key claimed and every retry would skip the card — the
    // customer would get NO link. The common case (a LATER step in the turn
    // throwing AFTER the card sent) keeps the key, so that retry stays deduped.
    async clearApproveCardSent(key: string): Promise<void> {
      await redis.del(`approvecard:${key}`);
    },
    // Program-Fix 34A: at most ONE agent.turn runs per (tenant, phone) at a
    // time — two concurrent drains would otherwise interleave the last-writer-
    // wins conversation history. SET NX EX 90 (the web chat's lock shape): a
    // holder killed mid-turn self-heals after 90 s. `token` is the outbox row
    // id, so only the row that took the lock releases it. Throws on a Redis
    // error; the worker treats a throw as "no lock" and FAILS OPEN.
    async tryTurnLock(partnerId: PartnerId, phone: string, token: string): Promise<boolean> {
      const result = await redis.set(`turnlock:${partnerId}:${phone}`, token, { ex: 90, nx: true });
      return result !== null;
    },
    // Release only a lock we still hold. GET-compare-DEL is not atomic (the
    // same trade-off as the web chat's lock): a holder that outlived the 90 s
    // TTL could, in a narrow window, delete a successor's lock. RedisLike has
    // no eval, so no Lua compare-and-delete; the FIFO guard in the worker keeps
    // replies in order even then.
    async releaseTurnLock(partnerId: PartnerId, phone: string, token: string): Promise<void> {
      const key = `turnlock:${partnerId}:${phone}`;
      if ((await redis.get(key)) === token) await redis.del(key);
    },
    // Replay-safe bill creation (create_invoice). The agent.turn outbox row is
    // at-least-once — a transient reply-send 5xx re-runs the WHOLE turn (and the
    // model can emit two calls in one turn) — so binding a content key → invoiceId
    // BEFORE the insert makes a duplicate a no-op (claim-first, the minting spine).
    // Returns the EXISTING id when the key was already claimed (so a replay returns
    // the SAME bill + link), else the candidate id. Same 120s TTL rationale as the
    // approve card: a true "same seller, same buyer, same amount, right now"
    // duplicate collides; a genuinely new bill (different amount/buyer, or after
    // the TTL) gets its own id.
    async claimBillInvoiceId(key: string, candidateId: string): Promise<string> {
      const claimed = await redis.set(`billclaim:${key}`, candidateId, { ex: 120, nx: true });
      if (claimed !== null) return candidateId;
      const existing = await redis.get(`billclaim:${key}`);
      return typeof existing === 'string' && existing ? existing : candidateId;
    },
    // Release a bill claim when the insert itself FAILED, so the at-least-once
    // retry can actually create the bill (mirrors clearApproveCardSent). A failure
    // in a LATER step (after the insert) keeps the claim, so that retry stays deduped.
    async clearBillInvoiceClaim(key: string): Promise<void> {
      await redis.del(`billclaim:${key}`);
    },
    async getLastInboundAt(partnerId: PartnerId, senderPhone: string): Promise<string | null> {
      return redis.get(`lastmsg:${partnerId}:${senderPhone}`); // no legacy read: a stale null only means "treat as a new conversation" once
    },
    async recordInboundNow(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await redis.set(`lastmsg:${partnerId}:${senderPhone}`, new Date().toISOString(), { ex: 86400 });
    },

    // ── Saved recipients (Postgres, encrypted, per (tenant, sender)) ─────
    async upsertRecipient(
      partnerId: PartnerId,
      senderPhone: string,
      recipient: import('./types').Recipient,
    ): Promise<void> {
      await recipientsRepo.upsertRecipient(partnerId, senderPhone, recipient);
    },
    async listRecipients(
      partnerId: PartnerId,
      senderPhone: string,
      limit: number,
    ): Promise<import('./types').Recipient[]> {
      return recipientsRepo.listRecipients(partnerId, senderPhone, limit);
    },

    // ── Corridor demand capture (Postgres) ───────────────────────────────
    async saveCorridorRequest(req: import('./types').CorridorRequest): Promise<void> {
      await corridorRepo.saveCorridorRequest(req);
    },
    async listCorridorRequests(): Promise<import('./types').CorridorRequest[]> {
      return corridorRepo.listCorridorRequests();
    },

    // ── Partner-with-us leads (Postgres) ──────────────────────────────────
    async savePartnerRequest(req: import('./types').PartnerRequest): Promise<void> {
      await partnerReqRepo.savePartnerRequest(req);
    },
    async listPartnerRequests(): Promise<import('./types').PartnerRequest[]> {
      return partnerReqRepo.listPartnerRequests();
    },
    async getPartnerRequest(id: string): Promise<import('./types').PartnerRequest | null> {
      return partnerReqRepo.getPartnerRequest(id);
    },
    async getPartnerRequestByTokenHash(hash: string): Promise<import('./types').PartnerRequest | null> {
      return partnerReqRepo.getByTokenHash(hash);
    },
    async markPartnerApplicationCompleted(id: string): Promise<void> {
      await partnerReqRepo.markApplicationCompleted(id);
    },
    // ── Partner applications (the detailed Stage-2 form) ──────────────────
    async savePartnerApplication(app: import('./types').PartnerApplication): Promise<void> {
      await partnerAppRepo.saveApplication(app);
    },
    async getPartnerApplicationByRequestId(id: string): Promise<import('./types').PartnerApplication | null> {
      return partnerAppRepo.getByRequestId(id);
    },
    async listPartnerApplications(): Promise<import('./types').PartnerApplication[]> {
      return partnerAppRepo.listApplications();
    },
    // ── B2B mock invoices (the "ERP" stand-in) ────────────────────────────
    async saveB2bInvoice(inv: import('./types').B2bInvoice): Promise<void> {
      await b2bInvoiceRepo.saveInvoice(inv);
    },
    async getUnpaidInvoiceByBuyer(
      buyerPhone: string,
      partnerId: import('./types').PartnerId,
    ): Promise<import('./types').B2bInvoice | null> {
      return b2bInvoiceRepo.getUnpaidByBuyer(buyerPhone, partnerId);
    },
    async getB2bInvoice(id: string): Promise<import('./types').B2bInvoice | null> {
      return b2bInvoiceRepo.getInvoice(id);
    },
    async listB2bInvoices(partnerId: import('./types').PartnerId): Promise<import('./types').B2bInvoice[]> {
      return b2bInvoiceRepo.listInvoices(partnerId);
    },
    async markB2bInvoicePaid(id: string, paidAt: string): Promise<void> {
      await b2bInvoiceRepo.markPaid(id, paidAt);
    },
    async getB2bInvoiceScoped(
      id: string,
      partnerId: import('./types').PartnerId,
    ): Promise<import('./types').B2bInvoice | null> {
      return b2bInvoiceRepo.getInvoiceByIdScoped(id, partnerId);
    },
    async voidB2bInvoice(
      id: string,
      partnerId: import('./types').PartnerId,
    ): Promise<import('./types').B2bInvoice | null> {
      return b2bInvoiceRepo.voidInvoice(id, partnerId);
    },
    async markB2bInvoiceDisputed(
      id: string,
      partnerId: import('./types').PartnerId,
    ): Promise<import('./types').B2bInvoice | null> {
      return b2bInvoiceRepo.markDisputed(id, partnerId);
    },
    async reissueB2bInvoice(
      sourceId: string,
      partnerId: import('./types').PartnerId,
      newId: string,
    ): Promise<import('./types').B2bInvoice | null> {
      return b2bInvoiceRepo.reissueInvoice(sourceId, partnerId, newId);
    },

    // ── Registered cross-border B2B sellers (Postgres, encrypted payout) ──
    async createSeller(input: {
      id: string;
      partnerId: import('./types').PartnerId;
      phone: string;
      businessName: string;
      country: import('./types').CountryCode;
      currency: import('./types').CurrencyCode;
      kycReviewState?: import('./types').KycReviewState;
    }): Promise<import('./types').Seller> {
      return sellerRepo.createSeller(input);
    },
    async getSeller(
      phone: string,
      partnerId: import('./types').PartnerId,
    ): Promise<import('./types').Seller | null> {
      return sellerRepo.getSeller(phone, partnerId);
    },
    /** By-id capability read (the hosted onboarding link carries the unguessable id). */
    async getSellerById(id: string): Promise<import('./types').Seller | null> {
      return sellerRepo.getSellerById(id);
    },
    /** Decrypted read for the few sites that genuinely need the full payout (settlement). */
    async getSellerDecrypted(
      phone: string,
      partnerId: import('./types').PartnerId,
    ): Promise<(import('./types').Seller & { payoutDestination: string }) | null> {
      return sellerRepo.getSellerDecrypted(phone, partnerId);
    },
    async setSellerPayout(
      phone: string,
      partnerId: import('./types').PartnerId,
      payoutDestination: string,
    ): Promise<import('./types').Seller | null> {
      return sellerRepo.setPayoutDestination(phone, partnerId, payoutDestination);
    },
    async setSellerStatus(
      phone: string,
      partnerId: import('./types').PartnerId,
      status: import('./types').SellerStatus,
    ): Promise<import('./types').Seller | null> {
      return sellerRepo.setStatus(phone, partnerId, status);
    },
    async setSellerReviewState(
      phone: string,
      partnerId: import('./types').PartnerId,
      kycReviewState: import('./types').KycReviewState,
    ): Promise<import('./types').Seller | null> {
      return sellerRepo.setReviewState(phone, partnerId, kycReviewState);
    },
    /** Atomic guarded onboarding completion: encrypt payout + persist the chosen
     *  payout method ('bank' default | 'usdc') + flip ACTIVE in one UPDATE
     *  (guarded on pending + not-needs_review). Null when not eligible. */
    async completeSellerOnboarding(
      phone: string,
      partnerId: import('./types').PartnerId,
      payoutDestination: string,
      payoutMethod: import('./types').SellerPayoutMethod = 'bank',
    ): Promise<import('./types').Seller | null> {
      return sellerRepo.activateOnboarding(phone, partnerId, payoutDestination, payoutMethod);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

let cached: Store | null = null;

export function getStore(): Store {
  if (!cached) {
    cached = createStore(getRedis(), getDb());
  }
  return cached;
}
