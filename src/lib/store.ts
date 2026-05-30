import { Redis } from '@upstash/redis';
import { env } from './env';
import { easternDate } from './dates';
import type { ChatMessage, Transfer, TransferStatus } from './types';
import {
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
  DEFAULT_PARTNER_ID,
} from './defaults';

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
}

const MAX_HISTORY = 40;

// Forward-only rank; higher = further along. Side/terminal states are never regressed.
const STATUS_RANK: Record<TransferStatus, number> = {
  blocked: -1, cancelled: -1, awaiting_payment: 0, paid: 1, delivered: 2,
};

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let trimmed = messages.slice(messages.length - MAX_HISTORY);
  while (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

export function createStore(redis: RedisLike) {
  return {
    async getConversation(phone: string): Promise<ChatMessage[]> {
      const raw = await redis.get(`conv:${phone}`);
      return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    },
    async saveConversation(
      phone: string,
      messages: ChatMessage[],
    ): Promise<void> {
      await redis.set(`conv:${phone}`, JSON.stringify(trimHistory(messages)));
    },
    async getTransfer(id: string): Promise<Transfer | null> {
      const raw = await redis.get(`transfer:${id}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Transfer;
      // Lazy fill for pre-P1/P2 records (in-memory only; cron pass is the only writer)
      if (!parsed.sourceCountry) {
        parsed.sourceCountry = DEFAULT_SOURCE_COUNTRY;
        parsed.sourceCurrency = DEFAULT_SOURCE_CURRENCY;
        parsed.destinationCountry = DEFAULT_DESTINATION_COUNTRY;
        parsed.destinationCurrency = DEFAULT_DESTINATION_CURRENCY;
      }
      if (!parsed.partnerId) {
        parsed.partnerId = DEFAULT_PARTNER_ID;
      }
      if (parsed.amountSource === undefined) {
        // Pre-P4 records: source presentation equals the USD-equivalent.
        parsed.amountSource = parsed.amountUsd;
        parsed.feeSource = parsed.feeUsd;
        parsed.totalChargeSource = parsed.totalChargeUsd;
      }
      return parsed;
    },
    async saveTransfer(transfer: Transfer): Promise<void> {
      await redis.set(`transfer:${transfer.id}`, JSON.stringify(transfer));
      // 'transfers:ids' (a Redis set) — distinct from the legacy
      // 'transfers:index' string key used before the multi-user change.
      await redis.sadd('transfers:ids', transfer.id);
    },
    async updateTransferFromWebhook(
      transferId: string,
      status: TransferStatus,          // already mapped to our domain by handleWebhook
    ): Promise<Transfer | null> {
      const transfer = await this.getTransfer(transferId);
      if (!transfer) return null;                                   // unknown id → no-op (untrusted)
      if (transfer.status === 'cancelled' || transfer.status === 'blocked') return null; // terminal
      // Never regress: ignore anything not strictly forward of the current status.
      if (STATUS_RANK[status] <= STATUS_RANK[transfer.status]) return null; // dup / out-of-order / back
      const now = new Date().toISOString();
      const updated: Transfer = {
        ...transfer,
        status,
        paidAt: status === 'paid' || status === 'delivered' ? (transfer.paidAt ?? now) : transfer.paidAt,
        deliveredAt: status === 'delivered' ? now : transfer.deliveredAt,
      };
      await this.saveTransfer(updated);
      return updated;                                               // non-null ⇒ a real transition
    },
    async listTransfers(): Promise<Transfer[]> {
      const ids = await redis.smembers('transfers:ids');
      const all = await Promise.all(ids.map((id) => this.getTransfer(id)));
      return all
        .filter((t): t is Transfer => t !== null)
        // `?? ''` defends against legacy records whose `createdAt` was never
        // populated (a real prod artifact that crashed the analytics page on
        // 2026-05-27). Treating them as the earliest record is the right
        // ordering — they sort to the bottom of the newest-first list.
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    },
    async getTransferCount(phone: string): Promise<number> {
      const raw = await redis.get(`count:${phone}`);
      return raw ? Number(raw) : 0;
    },
    async incrementTransferCount(phone: string): Promise<void> {
      await redis.incr(`count:${phone}`);
    },
    async incrementTodayTransferCount(phone: string): Promise<void> {
      await redis.incr(`velocity:${phone}:${easternDate(Date.now())}`);
    },
    async getTodayTransferCount(phone: string): Promise<number> {
      const raw = await redis.get(`velocity:${phone}:${easternDate(Date.now())}`);
      return raw ? Number(raw) : 0;
    },
    async markMessageSeen(wamid: string): Promise<boolean> {
      const result = await redis.set(`msg:${wamid}`, '1', {
        ex: 600,
        nx: true,
      });
      return result !== null;
    },
    async claimMigrationFlag(key: string): Promise<boolean> {
      const result = await redis.set(`flag:${key}`, '1', { nx: true });
      return result !== null;
    },
    async upsertRecipient(
      senderPhone: string,
      recipient: import('./types').Recipient,
    ): Promise<void> {
      await redis.hset(`recipients:${senderPhone}`, {
        [recipient.recipientPhone]: JSON.stringify(recipient),
      });
    },
    async listRecipients(
      senderPhone: string,
      limit: number,
    ): Promise<import('./types').Recipient[]> {
      const all = (await redis.hgetall(`recipients:${senderPhone}`)) ?? {};
      const parsed: import('./types').Recipient[] = [];
      for (const value of Object.values(all)) {
        try {
          parsed.push(JSON.parse(value) as import('./types').Recipient);
        } catch {
          // skip malformed entries; never throw
        }
      }
      // `?? ''` defends against legacy recipients whose lastUsedAt was never
      // populated — mirrors the same guard on listTransfers.
      parsed.sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
      return parsed.slice(0, limit);
    },
    async getLastInboundAt(senderPhone: string): Promise<string | null> {
      return redis.get(`lastmsg:${senderPhone}`);
    },
    async recordInboundNow(senderPhone: string): Promise<void> {
      await redis.set(
        `lastmsg:${senderPhone}`,
        new Date().toISOString(),
        { ex: 86400 },
      );
    },
    async saveCorridorRequest(req: import('./types').CorridorRequest): Promise<void> {
      await redis.set(`corridor_request:${req.id}`, JSON.stringify(req));
      await redis.sadd('corridor_requests:ids', req.id);
    },
    async listCorridorRequests(): Promise<import('./types').CorridorRequest[]> {
      const ids = await redis.smembers('corridor_requests:ids');
      const all = await Promise.all(ids.map((id) => redis.get(`corridor_request:${id}`)));
      const parsed: import('./types').CorridorRequest[] = [];
      for (const raw of all) { if (raw) { try { parsed.push(JSON.parse(raw)); } catch { /* skip */ } } }
      return parsed.sort((a, b) => (b.capturedAt ?? '').localeCompare(a.capturedAt ?? ''));
    },
  };
}

export type Store = ReturnType<typeof createStore>;

let cached: Store | null = null;

export function getStore(): Store {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createStore(redis as unknown as RedisLike);
  }
  return cached;
}
