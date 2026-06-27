import { getRedis } from './redis';
import { easternDate } from './dates';
import { getDb, type DbOrTx } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createRecipientRepo, createCorridorRequestRepo, createPartnerRequestRepo, createPartnerApplicationRepo, createB2bInvoiceRepo } from '@/db/repos/aux-repos';
import type { ChatMessage, Transfer, TransferStatus } from './types';

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

  return {
    // ── Conversations (Redis — hot, trimmed, ephemeral) ──────────────────
    async getConversation(phone: string): Promise<ChatMessage[]> {
      const raw = await redis.get(`conv:${phone}`);
      return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    },
    async saveConversation(phone: string, messages: ChatMessage[]): Promise<void> {
      // 30-day TTL (Stage 4): a conversation untouched for a month is dead
      // weight — every save renews the clock, so active chats never expire.
      await redis.set(`conv:${phone}`, JSON.stringify(trimHistory(messages)), {
        ex: 30 * 24 * 3600,
      });
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
    /** Indexed per-customer list (Stage 4) — replaces filter-the-whole-ledger. */
    async listTransfersByPhone(phone: string, limit = 50): Promise<Transfer[]> {
      return (await transfersRepo.listByPhone(phone, { limit })).items;
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
    async getTransferCount(phone: string): Promise<number> {
      // Derived (blocked rows excluded) — the count:{phone} counter is gone.
      return transfersRepo.countByPhone(phone);
    },
    /** MIN(created_at) for grandfathering — indexed, not a ledger scan. */
    async firstTransferAt(phone: string): Promise<string | null> {
      return transfersRepo.firstTransferAt(phone);
    },

    // ── Today-velocity (Redis counters — date-bucketed, self-expiring use) ─
    async incrementTodayTransferCount(phone: string): Promise<void> {
      await redis.incr(`velocity:${phone}:${easternDate(Date.now())}`);
    },
    async getTodayTransferCount(phone: string): Promise<number> {
      const raw = await redis.get(`velocity:${phone}:${easternDate(Date.now())}`);
      return raw ? Number(raw) : 0;
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
    async getLastInboundAt(senderPhone: string): Promise<string | null> {
      return redis.get(`lastmsg:${senderPhone}`);
    },
    async recordInboundNow(senderPhone: string): Promise<void> {
      await redis.set(`lastmsg:${senderPhone}`, new Date().toISOString(), { ex: 86400 });
    },

    // ── Saved recipients (Postgres, encrypted payout destinations) ───────
    async upsertRecipient(
      senderPhone: string,
      recipient: import('./types').Recipient,
    ): Promise<void> {
      await recipientsRepo.upsertRecipient(senderPhone, recipient);
    },
    async listRecipients(
      senderPhone: string,
      limit: number,
    ): Promise<import('./types').Recipient[]> {
      return recipientsRepo.listRecipients(senderPhone, limit);
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
