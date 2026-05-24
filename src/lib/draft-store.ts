import { Redis } from '@upstash/redis';
import { env } from './env';
import { newTransferId } from './id';
import type { RedisLike } from './store';
import type { Draft } from './types';

const DRAFT_TTL_SECONDS = 600; // 10 minutes

export function createDraftStore(redis: RedisLike) {
  return {
    async createDraft(input: Omit<Draft, 'createdAt'>): Promise<string> {
      const draftId = newTransferId();
      const draft: Draft = {
        ...input,
        createdAt: new Date().toISOString(),
      };
      await redis.set(`recipient_draft:${draftId}`, JSON.stringify(draft), {
        ex: DRAFT_TTL_SECONDS,
      });
      return draftId;
    },
    async getDraft(draftId: string): Promise<Draft | null> {
      const raw = await redis.get(`recipient_draft:${draftId}`);
      return raw ? (JSON.parse(raw) as Draft) : null;
    },
    async consumeDraft(draftId: string): Promise<Draft | null> {
      const raw = await redis.getdel(`recipient_draft:${draftId}`);
      return raw ? (JSON.parse(raw) as Draft) : null;
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

let cached: DraftStore | null = null;

export function getDraftStore(): DraftStore {
  if (!cached) {
    const redis = new Redis({
      url: env.kvUrl,
      token: env.kvToken,
      automaticDeserialization: false,
    });
    cached = createDraftStore(redis as unknown as RedisLike);
  }
  return cached;
}
