import { Redis } from '@upstash/redis';
import { env } from './env';
import { easternDate } from './dates';
import type { ChatMessage, Transfer } from './types';

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
      return raw ? (JSON.parse(raw) as Transfer) : null;
    },
    async saveTransfer(transfer: Transfer): Promise<void> {
      await redis.set(`transfer:${transfer.id}`, JSON.stringify(transfer));
      // 'transfers:ids' (a Redis set) — distinct from the legacy
      // 'transfers:index' string key used before the multi-user change.
      await redis.sadd('transfers:ids', transfer.id);
    },
    async listTransfers(): Promise<Transfer[]> {
      const ids = await redis.smembers('transfers:ids');
      const all = await Promise.all(ids.map((id) => this.getTransfer(id)));
      return all
        .filter((t): t is Transfer => t !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
      parsed.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
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
