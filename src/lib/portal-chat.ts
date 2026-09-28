import { threadKeyFor } from './customer-ref';
import type { PartnerId } from './types';

/**
 * portal-chat — the limits and keys of the customer portal's chat endpoint (UI redesign M2-12,
 * Task 12.3; the route is src/app/api/portal/chat/route.ts). The turn itself is the existing web-chat
 * channel (runWebChatTurn), unchanged.
 *
 * Every per-customer key is `<partnerId>|<keyed HMAC of (partner, phone)>`: the same phone under two
 * partners has two budgets and two locks, and the raw phone never lands in a Redis key. The HMAC is
 * the audit-subject key (customer-ref threadKeyFor), so no new secret is introduced.
 */

/** Per-IP requests per minute (the outer ring). */
export const PORTAL_CHAT_IP_LIMIT = 30;
/** Per-customer turns per 24 h window (an LLM-cost cap; legacy parity). */
export const PORTAL_CHAT_DAILY_CAP = 100;
/** The longest message, in characters (legacy parity). */
export const PORTAL_CHAT_MAX_MESSAGE_CHARS = 1000;
/** The largest request body read, in bytes: a 1000-character message in JSON fits with room to spare. */
export const PORTAL_CHAT_MAX_BODY_BYTES = 8 * 1024;
/** The in-flight lock's TTL (a crashed holder frees it); the route's maxDuration is 60 s. */
export const PORTAL_CHAT_LOCK_TTL_S = 90;
/** The daily cap's limiter scope (never shared with the legacy `webchat-turns` budget). */
export const PORTAL_CHAT_TURNS_SCOPE = 'portalchat-turns';

/** The per-(partner, customer) subject used by the daily cap. */
export function portalChatSubject(partnerId: PartnerId, phone: string): string {
  return `${partnerId}|${threadKeyFor(partnerId, phone).toString('hex')}`;
}

/** The per-(partner, customer) in-flight lock key: one turn at a time per tenant thread. */
export function portalChatLockKey(partnerId: PartnerId, phone: string): string {
  return `portalchat:lock:${portalChatSubject(partnerId, phone)}`;
}

/**
 * Read a request body as text, at most `maxBytes`. Returns null as soon as the body is larger (the
 * stream is cancelled, so an oversized body is never buffered whole).
 */
export async function readCappedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}
