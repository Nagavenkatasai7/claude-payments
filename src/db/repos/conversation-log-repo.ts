import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { conversationMessages } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { conversationRowCtx } from '@/lib/crypto-context';
import { threadKeyFor } from '@/lib/customer-ref';
import { logWarn } from '@/lib/log';
import type { PartnerId } from '@/lib/types';

// conversation-log-repo (Partner-Demo R3b) — the sealed, permanent log of
// customer-visible chat messages (table 0025). One row per message: the
// customer's text in, the customer-visible reply out. Never tool traffic, OTPs
// or system templates.
//
//  • SEAL BEFORE INSERT: the body is sealed under the row's final context
//    (conversationRowCtx: tenant, id, thread, channel, direction) and inserted
//    once — no empty-row-then-update (no dead tuple, no plaintext window).
//  • IDEMPOTENT: callers on retrying paths (the outbox worker) pass a
//    deterministic id (conversationMessageId) and the insert is ON CONFLICT
//    DO NOTHING, so a re-run turn never duplicates a message.
//  • TENANT-SCOPED READS: listThread always has partner_id AND thread_key in
//    its WHERE, and opens each body under the context built from the FETCHED
//    row. A foreign or missing thread is simply [].
//  • No plaintext phone is stored: thread_key is the raw auditSubjectId HMAC.

export type ConversationChannel = 'wa' | 'web';
export type ConversationDirection = 'in' | 'out';

const CHANNEL_CODE: Record<ConversationChannel, number> = { wa: 1, web: 2 };
const DIRECTION_CODE: Record<ConversationDirection, number> = { in: 1, out: 2 };
const CHANNEL_OF: Record<number, ConversationChannel> = { 1: 'wa', 2: 'web' };
const DIRECTION_OF: Record<number, ConversationDirection> = { 1: 'in', 2: 'out' };

/** Shown in place of a body that does not open (tampered or moved row). */
export const UNREADABLE_BODY = '[unreadable]';
/** Logged in place of a reply that was a card / picker (the agent returned ''). */
export const CARD_MARKER = '[card]';

/**
 * Deterministic row id for a WhatsApp message, from the agent.turn outbox row
 * id (globally unique): a name-based (version 5 shaped) UUID over
 * sha256('conv:wa:<in|out>:<rowId>'). A retried turn re-derives the same id.
 */
export function conversationMessageId(direction: ConversationDirection, outboxRowId: number | string): string {
  const b = createHash('sha256').update(`conv:wa:${direction}:${outboxRowId}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface AppendInput {
  /** Deterministic for retrying writers (conversationMessageId); random when omitted. */
  id?: string;
  partnerId: PartnerId;
  phone: string;
  channel: ConversationChannel;
  direction: ConversationDirection;
  text: string;
}

export interface ConversationEntry {
  id: string;
  channel: ConversationChannel;
  direction: ConversationDirection;
  /** The opened body, or UNREADABLE_BODY when it does not open. */
  text: string;
  unreadable: boolean;
  createdAt: string;
}

export function createConversationLogRepo(db: DbOrTx, provider: EncryptionKeyProvider = defaultProvider()) {
  return {
    /** Seal and insert one message. Returns false when the id already exists (a retry). */
    async append(m: AppendInput): Promise<boolean> {
      const row = {
        id: m.id ?? randomUUID(),
        partnerId: m.partnerId,
        threadKey: threadKeyFor(m.partnerId, m.phone),
        channel: CHANNEL_CODE[m.channel],
        direction: DIRECTION_CODE[m.direction],
      };
      const bodyEnc = encryptField(m.text, provider, conversationRowCtx(row));
      const inserted = await db
        .insert(conversationMessages)
        .values({ ...row, bodyEnc })
        .onConflictDoNothing({ target: conversationMessages.id })
        .returning({ id: conversationMessages.id });
      return inserted.length > 0;
    },

    /**
     * The newest `limit` messages of one (tenant, phone) thread, oldest first.
     * Ties on created_at (one transaction) put the inbound before the reply.
     */
    async listThread(
      partnerId: PartnerId,
      phone: string,
      opts: { limit?: number; channel?: ConversationChannel } = {},
    ): Promise<ConversationEntry[]> {
      const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 500);
      const where = [
        eq(conversationMessages.partnerId, partnerId),
        eq(conversationMessages.threadKey, threadKeyFor(partnerId, phone)),
      ];
      if (opts.channel) where.push(eq(conversationMessages.channel, CHANNEL_CODE[opts.channel]));
      const fetched = await db
        .select()
        .from(conversationMessages)
        .where(and(...where))
        .orderBy(desc(conversationMessages.createdAt), desc(conversationMessages.direction), desc(conversationMessages.id))
        .limit(limit);
      return fetched.reverse().map((r) => {
        let text: string;
        let unreadable = false;
        try {
          // The context comes from the FETCHED row's own columns.
          text = decryptField(r.bodyEnc, provider, conversationRowCtx(r));
        } catch {
          text = UNREADABLE_BODY;
          unreadable = true;
          logWarn('conversation_log.unreadable', 'a conversation body did not open under its row context', { id: r.id });
        }
        return {
          id: r.id,
          channel: CHANNEL_OF[r.channel] ?? 'wa',
          direction: DIRECTION_OF[r.direction] ?? 'in',
          text,
          unreadable,
          createdAt: r.createdAt.toISOString(),
        };
      });
    },
  };
}
export type ConversationLogRepo = ReturnType<typeof createConversationLogRepo>;
