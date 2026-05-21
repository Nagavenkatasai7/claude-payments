import { Redis } from '@upstash/redis';
import { env } from './env';
import type { ChatMessage, Transfer, UserRecord } from './types';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<unknown>;
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
    },
    async getUser(phone: string): Promise<UserRecord> {
      const raw = await redis.get(`user:${phone}`);
      return raw ? (JSON.parse(raw) as UserRecord) : { transferCount: 0 };
    },
    async incrementTransferCount(phone: string): Promise<void> {
      const user = await this.getUser(phone);
      await redis.set(
        `user:${phone}`,
        JSON.stringify({ transferCount: user.transferCount + 1 }),
      );
    },
    async markMessageSeen(wamid: string): Promise<boolean> {
      const result = await redis.set(`msg:${wamid}`, '1', {
        ex: 600,
        nx: true,
      });
      return result !== null;
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
