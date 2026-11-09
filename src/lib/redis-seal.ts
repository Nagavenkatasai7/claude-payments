import { decryptField, defaultProvider, type CryptoContext, type EncryptionKeyProvider } from './field-crypto';
import { ctx } from './crypto-context';
import { threadKeyFor } from './customer-ref';
import type { PartnerId } from './types';

/**
 * redis-seal (R49) — the sealed format of the Redis chat history and pay-link
 * drafts, and the READERS for it. PR1 ships only the readers; every writer
 * still writes today's plaintext format. PR9 switches the writers (sealed
 * value, HMAC key), and because every build from PR1 on reads both formats,
 * that needs no flag day and an Instant Rollback to PR1 keeps reading what PR9
 * wrote. Never roll production back below PR1 once PR9 is live.
 *
 * The format:
 *  - KEYS hold the keyed thread HMAC, never the phone (the portal-chat
 *    precedent: customer-ref threadKeyFor, an HKDF of FIELD_ENCRYPTION_KEY):
 *      chat history  conv:<partnerId>:h:<64 hex>      (web: the HMAC of 'web:<phone>')
 *      draft pointer active_draft:<partnerId>:h:<64 hex>, active_draft:web:<partnerId>:h:<64 hex>
 *    The draft itself stays at recipient_draft:<draft id> (the id holds no phone).
 *  - VALUES are the field-crypto v2 envelope (`v2.k0.…`) over the JSON text,
 *    bound to ctx.redisConversation(partnerId, thread hex) or
 *    ctx.redisDraft(draftId), so a blob moved to another tenant, thread or
 *    draft does not open. Plaintext JSON starts with '[' or '{', never 'v2.'.
 *
 * Like the conversation log's thread_key, the HMAC is keyed by an HKDF of k0
 * (set-once): retiring k0 would orphan every live thread. Pure apart from the
 * key read; openJson throws and the caller decides (the stores log the error
 * NAME and treat the value as missing).
 */

export type DraftPointerKind = 'bot' | 'web';

const SEALED_PREFIX = 'v2.';

/** Lowercase hex of the thread HMAC for (tenant, thread phone). Throws when the key is unavailable. */
function threadHex(partnerId: PartnerId, threadPhone: string, key?: Buffer): string {
  return (key ? threadKeyFor(partnerId, threadPhone, key) : threadKeyFor(partnerId, threadPhone)).toString('hex');
}

/** The sealed chat-history key for one tenant thread (`threadPhone` is 'web:<phone>' for web chat). */
export function sealedConversationKey(partnerId: PartnerId, threadPhone: string, key?: Buffer): string {
  return `conv:${partnerId}:h:${threadHex(partnerId, threadPhone, key)}`;
}

/** The sealed active-draft pointer key ('web' keeps its own namespace, as today). */
export function sealedDraftPointerKey(partnerId: PartnerId, phone: string, pointer: DraftPointerKind, key?: Buffer): string {
  const h = threadHex(partnerId, phone, key);
  return pointer === 'web' ? `active_draft:web:${partnerId}:h:${h}` : `active_draft:${partnerId}:h:${h}`;
}

/** The crypto context a sealed chat history is bound to. */
export function conversationSealCtx(partnerId: PartnerId, threadPhone: string, key?: Buffer): CryptoContext {
  return ctx.redisConversation(partnerId, threadHex(partnerId, threadPhone, key));
}

/** The crypto context a sealed draft is bound to. */
export function draftSealCtx(draftId: string): CryptoContext {
  return ctx.redisDraft(draftId);
}

/** Whether a stored value is the sealed format (anything else is today's plaintext JSON). */
export function isSealed(raw: unknown): boolean {
  return typeof raw === 'string' && raw.startsWith(SEALED_PREFIX);
}

/**
 * Read one stored value in either format: a sealed value is opened under
 * `cryptoCtx` and parsed; plaintext JSON is parsed as it is. Throws on a value
 * that does not open (moved, tampered, another key) or does not parse; the
 * error text never carries the context.
 */
export function openJson<T>(raw: string, cryptoCtx: CryptoContext, provider: EncryptionKeyProvider = defaultProvider()): T {
  const text = isSealed(raw) ? decryptField(raw, provider, cryptoCtx) : raw;
  return JSON.parse(text) as T;
}
