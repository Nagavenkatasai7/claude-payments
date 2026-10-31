import { getRedis } from './redis';
import { newTransferId } from './id';
import type { RedisLike } from './store';
import { DEFAULT_PARTNER_ID } from './defaults';
import type { Draft, PartnerId } from './types';

import { DRAFT_TTL_SECONDS } from './draft-ttl';
import { draftSealCtx, isSealed, openJson, sealedDraftPointerKey } from './redis-seal';
import { logWarn } from './log';

// Program-Fix 49B: the value lives in ./draft-ttl (dependency-free) so the legal
// drafts can state the same lock; re-exported here for existing importers.
export { DRAFT_TTL_SECONDS };

/**
 * Which active-draft pointer a draft sits under (UI redesign M2-4). 'bot' is
 * the WhatsApp pointer, `active_draft:<pid>:<phone>`, unchanged. 'web' is its
 * own namespace, `active_draft:web:<pid>:<phone>`, so the bot's typed
 * cancel_draft (which falls back to the bot pointer) can never consume a web
 * draft, and a web draft never replaces the draft a WhatsApp card points at.
 * A phone is digits only, so the two key shapes cannot collide.
 */
export type DraftPointer = 'bot' | 'web';

function activeDraftKey(partnerId: PartnerId, phone: string, pointer: DraftPointer): string {
  return pointer === 'web' ? `active_draft:web:${partnerId}:${phone}` : `active_draft:${partnerId}:${phone}`;
}

/** The pointer a stored draft belongs to: only a draft marked channel 'web' is a web draft. */
function pointerOf(draft: Draft): DraftPointer {
  return draft.channel === 'web' ? 'web' : 'bot';
}

const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');

/**
 * R49 part 1 (reader): a stored draft in either format. PR9 seals the JSON
 * under ctx.redisDraft(draftId) (redis-seal.ts); this build still writes
 * plaintext. A sealed value that does not open (copied from another draft id,
 * tampered) reads as missing, logging the error name only. Plaintext parses
 * exactly as before.
 */
function readDraft(raw: string, draftId: string): Draft | null {
  if (!isSealed(raw)) return JSON.parse(raw) as Draft;
  try {
    return openJson<Draft>(raw, draftSealCtx(draftId));
  } catch (err) {
    logWarn('draft.store', 'sealed draft did not open: read as missing', { error: errName(err) });
    return null;
  }
}

/** R49: PR9's HMAC pointer key, or null when the key cannot be derived. */
function sealedPointerKey(partnerId: PartnerId, phone: string, pointer: DraftPointer): string | null {
  try {
    return sealedDraftPointerKey(partnerId, phone, pointer);
  } catch (err) {
    logWarn('draft.store', 'sealed draft pointer key unavailable', { error: errName(err) });
    return null;
  }
}

export function createDraftStore(redis: RedisLike) {
  return {
    // D12 (fix 1): the active-draft pointer is keyed (tenant, phone); a new
    // draft MUST carry its tenant. M2-4: `pointer: 'web'` marks the draft
    // channel 'web' and uses the web pointer; the default ('bot') writes
    // exactly the draft and keys it wrote before (no channel field).
    async createDraft(
      input: Omit<Draft, 'createdAt' | 'channel'> & { partnerId: PartnerId },
      opts: { pointer?: DraftPointer } = {},
    ): Promise<string> {
      const pointer: DraftPointer = opts.pointer ?? 'bot';
      const draftId = newTransferId();
      const draft: Draft = {
        ...input,
        createdAt: new Date().toISOString(),
        ...(pointer === 'web' ? { channel: 'web' as const } : {}),
      };
      await redis.set(`recipient_draft:${draftId}`, JSON.stringify(draft), {
        ex: DRAFT_TTL_SECONDS,
      });
      await redis.set(activeDraftKey(input.partnerId, input.senderPhone, pointer), draftId, {
        ex: DRAFT_TTL_SECONDS,
      });
      return draftId;
    },
    async getDraft(draftId: string): Promise<Draft | null> {
      const raw = await redis.get(`recipient_draft:${draftId}`);
      return raw ? readDraft(raw, draftId) : null;
    },
    // R49: this build's own (phone) pointer first, then PR9's HMAC pointer.
    async getActiveDraftId(partnerId: PartnerId, phone: string, pointer: DraftPointer = 'bot'): Promise<string | null> {
      const own = await redis.get(activeDraftKey(partnerId, phone, pointer));
      if (own !== null) return own;
      const sealedKey = sealedPointerKey(partnerId, phone, pointer);
      return sealedKey ? redis.get(sealedKey) : null;
    },
    async consumeDraft(draftId: string): Promise<Draft | null> {
      const raw = await redis.getdel(`recipient_draft:${draftId}`);
      if (!raw) return null;
      const draft = readDraft(raw, draftId);
      if (!draft) return null;
      // A legacy in-flight draft (no partnerId) had a phone-only pointer; it
      // simply expires with its TTL — nothing reads the old key after fix 1.
      // M2-4: a web draft clears the web pointer only; every other draft the bot pointer.
      const tenant = draft.partnerId ?? DEFAULT_PARTNER_ID;
      const ptrKey = activeDraftKey(tenant, draft.senderPhone, pointerOf(draft));
      const ptr = await redis.get(ptrKey);
      if (ptr === draftId) await redis.del(ptrKey);
      // R49: PR9's HMAC pointer too. Best effort: the draft is already consumed,
      // so a failure here must never lose it (the pointer expires with its TTL).
      try {
        const sealedKey = sealedPointerKey(tenant, draft.senderPhone, pointerOf(draft));
        if (sealedKey && (await redis.get(sealedKey)) === draftId) await redis.del(sealedKey);
      } catch (err) {
        logWarn('draft.store', 'sealed draft pointer not cleared', { error: errName(err) });
      }
      return draft;
    },
    /**
     * Put a consumed draft back (row + pointer under ITS OWN tenant) — used when
     * a tap is refused on a tenant mismatch, so the legitimate tenant's draft is
     * never destroyed by someone else's turn (fix 1, D12).
     */
    async restoreDraft(draft: Draft, draftId: string): Promise<void> {
      await redis.set(`recipient_draft:${draftId}`, JSON.stringify(draft), { ex: DRAFT_TTL_SECONDS });
      await redis.set(activeDraftKey(draft.partnerId ?? DEFAULT_PARTNER_ID, draft.senderPhone, pointerOf(draft)), draftId, {
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
