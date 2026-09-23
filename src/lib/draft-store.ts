import { getRedis } from './redis';
import { newTransferId } from './id';
import type { RedisLike } from './store';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { Draft, PartnerId } from './types';

import { DRAFT_TTL_SECONDS } from './draft-ttl';

// Program-Fix 49B: the value lives in ./draft-ttl (dependency-free) so the legal
// drafts can state the same lock; re-exported here for existing importers.
export { DRAFT_TTL_SECONDS };

export function createDraftStore(redis: RedisLike) {
  return {
    // D12 (fix 1): the active-draft pointer is keyed (tenant, phone); a new
    // draft MUST carry its tenant.
    async createDraft(input: Omit<Draft, 'createdAt'> & { partnerId: PartnerId }): Promise<string> {
      const draftId = newTransferId();
      const draft: Draft = {
        ...input,
        createdAt: new Date().toISOString(),
      };
      await redis.set(`recipient_draft:${draftId}`, JSON.stringify(draft), {
        ex: DRAFT_TTL_SECONDS,
      });
      await redis.set(`active_draft:${input.partnerId}:${input.senderPhone}`, draftId, {
        ex: DRAFT_TTL_SECONDS,
      });
      return draftId;
    },
    async getDraft(draftId: string): Promise<Draft | null> {
      const raw = await redis.get(`recipient_draft:${draftId}`);
      return raw ? (JSON.parse(raw) as Draft) : null;
    },
    async getActiveDraftId(partnerId: PartnerId, phone: string): Promise<string | null> {
      return redis.get(`active_draft:${partnerId}:${phone}`);
    },
    async consumeDraft(draftId: string): Promise<Draft | null> {
      const raw = await redis.getdel(`recipient_draft:${draftId}`);
      if (!raw) return null;
      const draft = JSON.parse(raw) as Draft;
      // A legacy in-flight draft (no partnerId) had a phone-only pointer; it
      // simply expires with its TTL — nothing reads the old key after fix 1.
      const ptrKey = `active_draft:${draft.partnerId ?? DEFAULT_PARTNER_ID}:${draft.senderPhone}`;
      const ptr = await redis.get(ptrKey);
      if (ptr === draftId) await redis.del(ptrKey);
      return draft;
    },
    /**
     * Put a consumed draft back (row + pointer under ITS OWN tenant) — used when
     * a tap is refused on a tenant mismatch, so the legitimate tenant's draft is
     * never destroyed by someone else's turn (fix 1, D12).
     */
    async restoreDraft(draft: Draft, draftId: string): Promise<void> {
      await redis.set(`recipient_draft:${draftId}`, JSON.stringify(draft), { ex: DRAFT_TTL_SECONDS });
      await redis.set(`active_draft:${draft.partnerId ?? DEFAULT_PARTNER_ID}:${draft.senderPhone}`, draftId, {
        ex: DRAFT_TTL_SECONDS,
      });
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

let cached: DraftStore | null = null;

export function getDraftStore(): DraftStore {
  if (!cached) {
    cached = createDraftStore(getRedis());
  }
  return cached;
}
