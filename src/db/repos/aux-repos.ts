import { desc, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  beneficiaries,
  corridorRequests,
  idempotencyKeys,
  recipients,
} from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { last4, openOptional } from './mappers';
import type { CorridorRequest, PartnerId, PayoutMethod, Recipient } from '@/lib/types';

// aux-repos — the smaller aggregates, one factory each, mirroring the surfaces
// call sites already use. Payout destinations (full bank accounts) are
// envelope-encrypted at rest everywhere they appear.

// ── Saved recipients (per-sender address book; was recipients:{phone} hash) ──
export function createRecipientRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  return {
    async upsertRecipient(senderPhone: string, r: Recipient): Promise<void> {
      const row = {
        senderPhone,
        recipientPhone: r.recipientPhone,
        name: r.name,
        payoutMethod: r.payoutMethod,
        payoutDestinationEnc: r.payoutDestination ? encryptField(r.payoutDestination, provider) : '',
        payoutDestinationLast4: last4(r.payoutDestination ?? ''),
        lastUsedAt: new Date(r.lastUsedAt),
      };
      await db
        .insert(recipients)
        .values(row)
        .onConflictDoUpdate({
          target: [recipients.senderPhone, recipients.recipientPhone],
          set: row,
        });
    },

    async listRecipients(senderPhone: string, limit: number): Promise<Recipient[]> {
      const rows = await db
        .select()
        .from(recipients)
        .where(eq(recipients.senderPhone, senderPhone))
        .orderBy(desc(recipients.lastUsedAt))
        .limit(limit);
      return rows.map((row) => ({
        name: row.name,
        recipientPhone: row.recipientPhone,
        payoutMethod: row.payoutMethod as PayoutMethod,
        payoutDestination: openOptional(row.payoutDestinationEnc, provider) ?? '',
        lastUsedAt: row.lastUsedAt.toISOString(),
      }));
    },
  };
}
export type RecipientRepo = ReturnType<typeof createRecipientRepo>;

// ── Partner beneficiaries (partner API; was partner:{id}:ben:* keys) ─────────
export interface BeneficiaryRecord {
  id: string;
  partnerId: PartnerId;
  name: string;
  country: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  recipientPhone?: string;
  createdAt: string;
}

export function createBeneficiaryRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  return {
    async createBeneficiary(b: BeneficiaryRecord): Promise<void> {
      await db.insert(beneficiaries).values({
        id: b.id,
        partnerId: b.partnerId,
        name: b.name,
        country: b.country,
        payoutMethod: b.payoutMethod,
        payoutDestinationEnc: b.payoutDestination ? encryptField(b.payoutDestination, provider) : '',
        payoutDestinationLast4: last4(b.payoutDestination ?? ''),
        recipientPhone: b.recipientPhone ?? null,
        createdAt: new Date(b.createdAt),
      });
    },

    /** Partner-scoped read (null for missing OR another partner's beneficiary). */
    async getOwnedBeneficiary(partnerId: PartnerId, id: string): Promise<BeneficiaryRecord | null> {
      const rows = await db
        .select()
        .from(beneficiaries)
        .where(sql`${beneficiaries.id} = ${id} AND ${beneficiaries.partnerId} = ${partnerId}`)
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        partnerId: row.partnerId,
        name: row.name,
        country: row.country,
        payoutMethod: row.payoutMethod as PayoutMethod,
        payoutDestination: openOptional(row.payoutDestinationEnc, provider) ?? '',
        recipientPhone: row.recipientPhone ?? undefined,
        createdAt: row.createdAt.toISOString(),
      };
    },
  };
}
export type BeneficiaryRepo = ReturnType<typeof createBeneficiaryRepo>;

// ── Corridor demand capture (was corridor_request:* keys) ────────────────────
export function createCorridorRequestRepo(db: DbOrTx) {
  return {
    async saveCorridorRequest(req: CorridorRequest): Promise<void> {
      await db.insert(corridorRequests).values({
        id: req.id,
        senderPhone: req.senderPhone,
        destinationCountry: req.destinationCountry,
        approxAmount: req.approxAmount !== undefined ? req.approxAmount.toFixed(2) : null,
        approxCurrency: req.approxCurrency ?? null,
        capturedAt: new Date(req.capturedAt),
      });
    },

    async listCorridorRequests(): Promise<CorridorRequest[]> {
      const rows = await db.select().from(corridorRequests).orderBy(desc(corridorRequests.capturedAt));
      return rows.map((row) => {
        const r: CorridorRequest = {
          id: row.id,
          senderPhone: row.senderPhone,
          destinationCountry: row.destinationCountry,
          capturedAt: row.capturedAt.toISOString(),
        };
        if (row.approxAmount !== null) r.approxAmount = Number(row.approxAmount);
        if (row.approxCurrency) r.approxCurrency = row.approxCurrency;
        return r;
      });
    },
  };
}
export type CorridorRequestRepo = ReturnType<typeof createCorridorRequestRepo>;

// ── Idempotency keys (PK (partner_id, key) — the duplicate-window killer) ────
export function createIdempotencyRepo(db: DbOrTx) {
  return {
    /** The transferId already bound to this key, or null. */
    async find(partnerId: PartnerId, key: string): Promise<string | null> {
      const rows = await db
        .select({ transferId: idempotencyKeys.transferId })
        .from(idempotencyKeys)
        .where(sql`${idempotencyKeys.partnerId} = ${partnerId} AND ${idempotencyKeys.key} = ${key}`)
        .limit(1);
      return rows[0]?.transferId ?? null;
    },

    /**
     * Claim the key for this transfer. Returns the WINNING transferId — the
     * caller's own id when the insert won, or the EXISTING transfer's id on a
     * replay (the crash-safe re-finalize contract).
     */
    async claim(partnerId: PartnerId, key: string, transferId: string): Promise<string> {
      const inserted = await db
        .insert(idempotencyKeys)
        .values({ partnerId, key, transferId })
        .onConflictDoNothing()
        .returning({ transferId: idempotencyKeys.transferId });
      if (inserted[0]) return inserted[0].transferId;
      const existing = await db
        .select({ transferId: idempotencyKeys.transferId })
        .from(idempotencyKeys)
        .where(sql`${idempotencyKeys.partnerId} = ${partnerId} AND ${idempotencyKeys.key} = ${key}`)
        .limit(1);
      return existing[0]!.transferId;
    },
  };
}
export type IdempotencyRepo = ReturnType<typeof createIdempotencyRepo>;

// ── Append-only audit events (staff actions + partner API + system) ──────────
export interface AuditEvent {
  partnerId?: PartnerId;
  actor: string;
  actorType: 'staff' | 'api_key' | 'system';
  action: string;
  subjectId?: string;
  meta?: Record<string, unknown>;
}

export function createAuditRepo(db: DbOrTx) {
  return {
    async record(e: AuditEvent): Promise<void> {
      await db.insert(auditEvents).values({
        partnerId: e.partnerId ?? null,
        actor: e.actor,
        actorType: e.actorType,
        action: e.action,
        subjectId: e.subjectId ?? null,
        meta: e.meta ?? null,
      });
    },

    async listByPartner(partnerId: PartnerId, limit = 50) {
      return db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.partnerId, partnerId))
        .orderBy(desc(auditEvents.at))
        .limit(limit);
    },

    async listRecent(limit = 50) {
      return db.select().from(auditEvents).orderBy(desc(auditEvents.at)).limit(limit);
    },
  };
}
export type AuditRepo = ReturnType<typeof createAuditRepo>;
