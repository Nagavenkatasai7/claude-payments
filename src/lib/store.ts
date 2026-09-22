import { getRedis } from './redis';
import { easternDate } from './dates';
import { getDb, type DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createRecipientRepo, createCorridorRequestRepo, createPartnerRequestRepo, createPartnerApplicationRepo, createB2bInvoiceRepo, createSellerRepo } from '@/db/repos/aux-repos';
import { createCustomerRepo } from '@/db/repos/customer-repo';
import { legacyKeyAllowed, legacyTenantResolver } from './legacy-tenant';
import type { ChatMessage, PartnerId, Transfer, TransferStatus } from './types';

// store — CUT OVER to a COMPOSITE (Stage 2a). Same module path + surface; the
// engine split follows the locked disposition:
//   • LEDGER → Postgres repos: transfers (atomic rank-guarded webhook machine,
//     keyset queries), saved recipients, corridor requests, derived transfer
//     counts. Encrypted payout destinations ride along (mappers).
//   • HOT/EPHEMERAL → Redis: conversations, today-velocity counters, inbound
//     msg dedup, lastmsg recency, migration sentinels.
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

export function createStore(redis: RedisLike, db: DbOrTx) {
  const transfersRepo = createTransferRepo(db);
  const recipientsRepo = createRecipientRepo(db);
  const corridorRepo = createCorridorRequestRepo(db);
  const partnerReqRepo = createPartnerRequestRepo(db);
  const partnerAppRepo = createPartnerApplicationRepo(db);
  const b2bInvoiceRepo = createB2bInvoiceRepo(db);
  const sellerRepo = createSellerRepo(db);
  // D9/D10/D12 (fix 1): which tenant may read a pre-fix phone-only Redis key —
  // the phone's OLDEST customers row (see legacy-tenant.ts). Built once.
  const legacyTenantOf = legacyTenantResolver(
    createCustomerRepo(db, (p, ph) => transfersRepo.firstTransferAt(p, ph)),
  );

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
     *  never an in_review hold) → cancelled: transfer-repo.cancelIfCancellable. Callers:
     *  dashboard-ops.cancelTransfer (staff) and tools.ts cancel_bill (customer
     *  chat). Null ⇒ not voidable now; the caller refuses and never falls back
     *  to saveTransfer. */
    async cancelTransferIfUnfunded(id: string): Promise<Transfer | null> {
      return transfersRepo.cancelIfCancellable(id);
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

    // ── Today-velocity (Redis counters — date-bucketed, tenant-scoped) ────
    // Key shape is OWNED HERE (fix 1) and consumed by fix 10; never rename again.
    // TRANSITIONAL (delete in fix 10): a tenant key that does not exist yet reads
    // through to the pre-fix phone-only key ONLY for the phone's pre-fix tenant
    // (legacyKeyAllowed — the oldest customers row), and the first increment
    // absorbs it, so an in-flight day's count is never reset to zero by the
    // rename and a post-fix sibling tenant never inherits another tenant's count.
    async incrementTodayTransferCount(partnerId: PartnerId, phone: string): Promise<void> {
      const k = `velocity:${partnerId}:${phone}:${easternDate(Date.now())}`;
      if ((await redis.exists(k)) === 0 && (await legacyKeyAllowed(partnerId, phone, legacyTenantOf))) {
        const legacy = Number((await redis.get(`velocity:${phone}:${easternDate(Date.now())}`)) ?? '0');
        if (legacy > 0) await redis.set(k, String(legacy), { ex: 48 * 3600 });
      }
      const n = await redis.incr(k);
      if (n === 1) await redis.expire(k, 48 * 3600);
    },
    async getTodayTransferCount(partnerId: PartnerId, phone: string): Promise<number> {
      const raw = await redis.get(`velocity:${partnerId}:${phone}:${easternDate(Date.now())}`);
      if (raw !== null) return Number(raw);
      if (!(await legacyKeyAllowed(partnerId, phone, legacyTenantOf))) return 0;
      const legacy = await redis.get(`velocity:${phone}:${easternDate(Date.now())}`);
      return legacy ? Number(legacy) : 0;
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
