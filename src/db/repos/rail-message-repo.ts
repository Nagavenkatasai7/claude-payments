import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, max, sql } from 'drizzle-orm';
import { railMessages } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { ctx, type RailMessageDirection, type RailMessageKind } from '@/lib/crypto-context';
import type { PartnerId } from '@/lib/types';

// rail-message-repo (fix pack 5, R40; contracts P3, P4) — the sealed,
// append-only record of every signed rail message (table 0039): each
// instruction or reverse we POST (direction 1) and each callback we verified
// (direction 2), with the exact body, its sha256 and the signature header.
//
//  • SEAL BEFORE INSERT: the body is sealed under its row's final context
//    (ctx.railMessage: id, direction, kind) and inserted once.
//  • APPEND-ONLY: the database trigger rail_messages_append_only rejects every
//    UPDATE (except a body_enc-only key-rotation re-seal, scripts/) and every
//    DELETE. This module has no update and no delete (tests/rail-messages-append-only.test.ts).
//  • THROWS: append has no try/catch. A caller that must not send without a
//    record (the worker, T9) wraps the throw as RailRecordError.
//  • IDEMPOTENT INBOUND: a callback's id is derived from (rail partner, body
//    hash, signature header), so a replayed delivery is ON CONFLICT DO NOTHING.
//    An outbound id is random: one row per POSTed attempt.
//  • NEVER LOGGED: no body, header or name leaves this module in a log.
//  • READERS, METADATA ONLY: listForTransfer is tenant-scoped and returns no
//    body, no signature and no rail partner id (only `routed`), so an owner
//    never learns which tenant's rail settled a routed row. lastSettleOutAt
//    (review round 1 RC2, the refund path) returns one time, nothing else.

export const RAIL_OUT = 1 as const;
export const RAIL_IN = 2 as const;
export type { RailMessageDirection, RailMessageKind } from '@/lib/crypto-context';

/** Lowercase hex sha256 of the UTF-8 encoding of `body`. */
export function railBodySha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Deterministic id of an inbound callback: a name-based (version 5 shaped) UUID
 * over sha256('rail:in:callback:<railPartnerId>:<bodySha256>:<signatureHeader>'),
 * shaped exactly as conversationMessageId (conversation-log-repo.ts).
 */
export function inboundRailMessageId(i: {
  railPartnerId: string | null;
  bodySha256: string;
  signatureHeader: string | null;
}): string {
  const b = createHash('sha256')
    .update(`rail:in:callback:${i.railPartnerId ?? ''}:${i.bodySha256}:${i.signatureHeader ?? ''}`)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface RailMessageInput {
  /** The transfer OWNER; null for an unresolved callback. */
  partnerId: PartnerId | null;
  /** The rail that sent or received the message. */
  railPartnerId: PartnerId | null;
  transferId: string | null;
  direction: RailMessageDirection;
  kind: RailMessageKind;
  /** The exact body text POSTed or verified. */
  body: string;
  /** The x-smartremit-signature value sent or received. */
  signatureHeader: string | null;
}

export interface RailMessageMeta {
  id: string;
  direction: RailMessageDirection;
  kind: RailMessageKind;
  bodySha256: string;
  createdAt: string;
  /** rail_partner_id IS DISTINCT FROM partner_id; never the rail partner's id. */
  routed: boolean;
}

export function createRailMessageRepo(db: DbOrTx, provider: EncryptionKeyProvider = defaultProvider()) {
  return {
    /** Seal and insert one message. THROWS on any failure. `inserted` is false for an inbound replay. */
    async append(i: RailMessageInput & { id?: string }): Promise<{ id: string; bodySha256: string; inserted: boolean }> {
      const bodySha256 = railBodySha256(i.body);
      const id =
        i.id ??
        (i.direction === RAIL_IN
          ? inboundRailMessageId({ railPartnerId: i.railPartnerId, bodySha256, signatureHeader: i.signatureHeader })
          : randomUUID());
      const bodyEnc = encryptField(i.body, provider, ctx.railMessage(id, i.direction, i.kind));
      const rows = await db
        .insert(railMessages)
        .values({
          id,
          partnerId: i.partnerId,
          railPartnerId: i.railPartnerId,
          transferId: i.transferId,
          direction: i.direction,
          kind: i.kind,
          bodyEnc,
          bodySha256,
          signatureHeader: i.signatureHeader,
        })
        .onConflictDoNothing({ target: railMessages.id })
        .returning({ id: railMessages.id });
      return { id, bodySha256, inserted: rows.length > 0 };
    },

    /** The owner's record of one transfer, oldest first. Metadata only: no body, no signature, no rail partner id. */
    async listForTransfer(partnerId: PartnerId, transferId: string): Promise<RailMessageMeta[]> {
      const fetched = await db
        .select({
          id: railMessages.id,
          direction: railMessages.direction,
          kind: railMessages.kind,
          bodySha256: railMessages.bodySha256,
          createdAt: railMessages.createdAt,
          routed: sql<boolean>`${railMessages.railPartnerId} IS DISTINCT FROM ${railMessages.partnerId}`,
        })
        .from(railMessages)
        .where(and(eq(railMessages.partnerId, partnerId), eq(railMessages.transferId, transferId)))
        .orderBy(asc(railMessages.createdAt), asc(railMessages.id));
      return fetched.map((r) => ({
        id: r.id,
        direction: r.direction as RailMessageDirection,
        kind: r.kind as RailMessageKind,
        bodySha256: r.bodySha256,
        createdAt: new Date(r.createdAt).toISOString(),
        routed: r.routed === true,
      }));
    },

    /**
     * Review round 1 RC2: when this transfer's newest outbound 'settle' was
     * recorded for THIS rail partner; null when none. Tenant-scoped (owner id
     * in the WHERE), ids in, one time out: no body read, no decrypt. THROWS on
     * a failed read.
     */
    async lastSettleOutAt(partnerId: PartnerId, transferId: string, railPartnerId: PartnerId): Promise<Date | null> {
      const rows = await db
        .select({ last: max(railMessages.createdAt) })
        .from(railMessages)
        .where(
          and(
            eq(railMessages.partnerId, partnerId),
            eq(railMessages.transferId, transferId),
            eq(railMessages.railPartnerId, railPartnerId),
            eq(railMessages.direction, RAIL_OUT),
            eq(railMessages.kind, 'settle'),
          ),
        );
      const last = rows[0]?.last;
      return last === null || last === undefined ? null : new Date(last);
    },
  };
}
