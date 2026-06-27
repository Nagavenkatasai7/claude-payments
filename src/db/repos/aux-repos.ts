import { desc, eq, sql } from 'drizzle-orm';
import {
  auditEvents,
  b2bInvoices,
  beneficiaries,
  corridorRequests,
  idempotencyKeys,
  partnerApplications,
  partnerRequests,
  recipients,
} from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { last4, openOptional } from './mappers';
import type {
  B2bInvoice,
  CorridorRequest,
  CurrencyCode,
  InvoiceLineItem,
  PartnerApplication,
  PartnerApplicationDetails,
  PartnerApplicationDocument,
  PartnerId,
  PartnerRequest,
  PayoutMethod,
  Recipient,
} from '@/lib/types';

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

// ── Partner-with-us leads (public landing form) ──────────────────────────────
type PartnerRequestRow = typeof partnerRequests.$inferSelect;
function rowToPartnerRequest(row: PartnerRequestRow): PartnerRequest {
  const r: PartnerRequest = {
    id: row.id,
    companyName: row.companyName,
    email: row.email,
    phone: row.phone,
    corridors: (row.corridors as string[]) ?? [],
    capturedAt: row.capturedAt.toISOString(),
    applicationStatus: row.applicationStatus,
  };
  if (row.comments) r.comments = row.comments;
  if (row.tokenExpiresAt) r.tokenExpiresAt = row.tokenExpiresAt.toISOString();
  return r;
}

export function createPartnerRequestRepo(db: DbOrTx) {
  return {
    async savePartnerRequest(req: PartnerRequest): Promise<void> {
      await db.insert(partnerRequests).values({
        id: req.id,
        companyName: req.companyName,
        email: req.email,
        phone: req.phone,
        corridors: req.corridors,
        comments: req.comments ?? null,
        capturedAt: new Date(req.capturedAt),
      });
    },

    async listPartnerRequests(): Promise<PartnerRequest[]> {
      const rows = await db.select().from(partnerRequests).orderBy(desc(partnerRequests.capturedAt));
      return rows.map(rowToPartnerRequest);
    },

    async getPartnerRequest(id: string): Promise<PartnerRequest | null> {
      const rows = await db.select().from(partnerRequests).where(eq(partnerRequests.id, id)).limit(1);
      return rows[0] ? rowToPartnerRequest(rows[0]) : null;
    },

    /** Stage 2: store the application link's token HASH + expiry; status stays 'invited'. */
    async setApplicationToken(id: string, tokenHash: string, expiresAt: string): Promise<void> {
      await db
        .update(partnerRequests)
        .set({ applicationTokenHash: tokenHash, tokenExpiresAt: new Date(expiresAt) })
        .where(eq(partnerRequests.id, id));
    },

    /** Resolve the partner_request a (hashed) application token points at, or null. */
    async getByTokenHash(tokenHash: string): Promise<PartnerRequest | null> {
      const rows = await db
        .select()
        .from(partnerRequests)
        .where(eq(partnerRequests.applicationTokenHash, tokenHash))
        .limit(1);
      return rows[0] ? rowToPartnerRequest(rows[0]) : null;
    },

    /** Single-use: flip to 'completed' so the link is dead. Idempotent. */
    async markApplicationCompleted(id: string): Promise<void> {
      await db
        .update(partnerRequests)
        .set({ applicationStatus: 'completed' })
        .where(eq(partnerRequests.id, id));
    },
  };
}
export type PartnerRequestRepo = ReturnType<typeof createPartnerRequestRepo>;

// ── Partner applications (the detailed Stage-2 form submissions) ─────────────
export function createPartnerApplicationRepo(db: DbOrTx) {
  const toApp = (row: typeof partnerApplications.$inferSelect): PartnerApplication => ({
    id: row.id,
    partnerRequestId: row.partnerRequestId,
    details: (row.details as PartnerApplicationDetails) ?? {},
    documents: (row.documents as PartnerApplicationDocument[]) ?? [],
    submittedAt: row.submittedAt.toISOString(),
  });
  return {
    async saveApplication(app: PartnerApplication): Promise<void> {
      await db.insert(partnerApplications).values({
        id: app.id,
        partnerRequestId: app.partnerRequestId,
        details: app.details,
        documents: app.documents,
        submittedAt: new Date(app.submittedAt),
      });
    },
    async getByRequestId(partnerRequestId: string): Promise<PartnerApplication | null> {
      const rows = await db
        .select()
        .from(partnerApplications)
        .where(eq(partnerApplications.partnerRequestId, partnerRequestId))
        .orderBy(desc(partnerApplications.submittedAt))
        .limit(1);
      return rows[0] ? toApp(rows[0]) : null;
    },
    async listApplications(): Promise<PartnerApplication[]> {
      const rows = await db
        .select()
        .from(partnerApplications)
        .orderBy(desc(partnerApplications.submittedAt));
      return rows.map(toApp);
    },
  };
}
export type PartnerApplicationRepo = ReturnType<typeof createPartnerApplicationRepo>;

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

// ── B2B mock invoices (the "ERP" stand-in for the test case) ─────────────────
export function createB2bInvoiceRepo(db: DbOrTx) {
  const toDomain = (row: typeof b2bInvoices.$inferSelect): B2bInvoice => {
    const inv: B2bInvoice = {
      id: row.id,
      partnerId: row.partnerId,
      businessName: row.businessName,
      buyerPhone: row.buyerPhone,
      lineItems: (row.lineItems as InvoiceLineItem[]) ?? [],
      amountUsd: Number(row.amountUsd),
      currency: row.currency as CurrencyCode,
      status: row.status as B2bInvoice['status'],
      createdAt: row.createdAt.toISOString(),
    };
    if (row.paidAt) inv.paidAt = row.paidAt.toISOString();
    return inv;
  };
  return {
    async saveInvoice(inv: B2bInvoice): Promise<void> {
      // The repo OWNS the digits-only invariant: the bot resolves the bill by
      // ctx.phone (Meta's wa_id, already digits-only), so a buyerPhone stored
      // with a '+' or spaces would never match. Normalize AND validate on write
      // here so every writer (seed action today, agent create-flow tomorrow) is
      // safe — an unreachable buyer phone (empty/too-short after normalize) is
      // rejected at the write boundary rather than silently never-matching later.
      const buyerPhone = normalizePhone(inv.buyerPhone);
      if (!isValidPhone(buyerPhone)) {
        throw new Error('B2B invoice buyerPhone must be a valid phone (country code + number, digits only).');
      }
      await db.insert(b2bInvoices).values({
        id: inv.id,
        partnerId: inv.partnerId,
        businessName: inv.businessName,
        buyerPhone,
        lineItems: inv.lineItems,
        amountUsd: inv.amountUsd.toFixed(2),
        currency: inv.currency,
        status: inv.status,
        createdAt: new Date(inv.createdAt),
        paidAt: inv.paidAt ? new Date(inv.paidAt) : null,
      });
    },
    /**
     * The buyer's most recent UNPAID invoice (what the bot presents in Phase 1),
     * scoped to ONE partner. Tenant isolation is app-level (CLAUDE.md): the bill
     * the bot surfaces must belong to the partner whose branded bot the buyer is
     * talking to, never another tenant's seller — so `partnerId` is in the WHERE.
     * `buyerPhone` is normalized on read too (defense-in-depth): match the
     * digits-only form we store, regardless of how the caller formatted it.
     */
    async getUnpaidByBuyer(buyerPhone: string, partnerId: PartnerId): Promise<B2bInvoice | null> {
      const phone = normalizePhone(buyerPhone);
      const rows = await db
        .select()
        .from(b2bInvoices)
        .where(
          sql`${b2bInvoices.partnerId} = ${partnerId} AND ${b2bInvoices.buyerPhone} = ${phone} AND ${b2bInvoices.status} = 'unpaid'`,
        )
        // id is the deterministic tiebreak when two invoices share a created_at.
        .orderBy(desc(b2bInvoices.createdAt), desc(b2bInvoices.id))
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },
    async getInvoice(id: string): Promise<B2bInvoice | null> {
      const rows = await db.select().from(b2bInvoices).where(eq(b2bInvoices.id, id)).limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },
    async listInvoices(partnerId: PartnerId): Promise<B2bInvoice[]> {
      const rows = await db
        .select()
        .from(b2bInvoices)
        .where(eq(b2bInvoices.partnerId, partnerId))
        .orderBy(desc(b2bInvoices.createdAt));
      return rows.map(toDomain);
    },
    /**
     * Phase 4 "update accounting": flip to paid when the transfer is delivered.
     * Guarded to ONLY unpaid → paid so a late delivery webhook can never resurrect
     * a bill staff voided or a buyer disputed (those are terminal, not re-payable);
     * idempotent on a re-delivered transfer (already-paid is a no-op).
     */
    async markPaid(id: string, paidAt: string): Promise<void> {
      await db
        .update(b2bInvoices)
        .set({ status: 'paid', paidAt: new Date(paidAt) })
        .where(sql`${b2bInvoices.id} = ${id} AND ${b2bInvoices.status} = 'unpaid'`);
    },
    /** Partner-scoped fetch (tenant isolation) for admin lifecycle actions. */
    async getInvoiceByIdScoped(id: string, partnerId: PartnerId): Promise<B2bInvoice | null> {
      const rows = await db
        .select()
        .from(b2bInvoices)
        .where(sql`${b2bInvoices.id} = ${id} AND ${b2bInvoices.partnerId} = ${partnerId}`)
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },
    /** Staff void of an UNPAID bill (kills it). Guarded + partner-scoped: only
     *  unpaid → voided. Returns the voided invoice, or null if not eligible
     *  (already paid/voided/disputed, or wrong tenant) — never un-pays a paid bill. */
    async voidInvoice(id: string, partnerId: PartnerId): Promise<B2bInvoice | null> {
      const rows = await db
        .update(b2bInvoices)
        .set({ status: 'voided' })
        .where(
          sql`${b2bInvoices.id} = ${id} AND ${b2bInvoices.partnerId} = ${partnerId} AND ${b2bInvoices.status} = 'unpaid'`,
        )
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },
    /** Buyer dispute of an UNPAID bill. Guarded + partner-scoped: only unpaid →
     *  disputed (the reason rides a support ticket). Null if not eligible. */
    async markDisputed(id: string, partnerId: PartnerId): Promise<B2bInvoice | null> {
      const rows = await db
        .update(b2bInvoices)
        .set({ status: 'disputed' })
        .where(
          sql`${b2bInvoices.id} = ${id} AND ${b2bInvoices.partnerId} = ${partnerId} AND ${b2bInvoices.status} = 'unpaid'`,
        )
        .returning();
      return rows[0] ? toDomain(rows[0]) : null;
    },
    /** Reissue a voided/disputed bill as a fresh UNPAID invoice (new id, cloned
     *  line items). Guarded + partner-scoped: source must be voided or disputed.
     *  Null if not eligible. `newId` is supplied by the caller (deterministic). */
    async reissueInvoice(sourceId: string, partnerId: PartnerId, newId: string): Promise<B2bInvoice | null> {
      const rows = await db
        .select()
        .from(b2bInvoices)
        .where(sql`${b2bInvoices.id} = ${sourceId} AND ${b2bInvoices.partnerId} = ${partnerId}`)
        .limit(1);
      const src = rows[0] ? toDomain(rows[0]) : null;
      if (!src || (src.status !== 'voided' && src.status !== 'disputed')) return null;
      const fresh: B2bInvoice = {
        id: newId,
        partnerId: src.partnerId,
        businessName: src.businessName,
        buyerPhone: src.buyerPhone, // already normalized on the original save
        lineItems: src.lineItems,
        amountUsd: src.amountUsd,
        currency: src.currency,
        status: 'unpaid',
        createdAt: new Date().toISOString(),
      };
      // Idempotent on newId: a replayed/double-submitted reissue with the same
      // deterministic id is a clean no-op (return the existing row), never a PK
      // 500. (A genuinely distinct newId double-reissue is an admin-UX concern the
      // L2 action guards; this closes the same-id replay foot-gun.)
      const inserted = await db
        .insert(b2bInvoices)
        .values({
          id: fresh.id,
          partnerId: fresh.partnerId,
          businessName: fresh.businessName,
          buyerPhone: normalizePhone(fresh.buyerPhone),
          lineItems: fresh.lineItems,
          amountUsd: fresh.amountUsd.toFixed(2),
          currency: fresh.currency,
          status: fresh.status,
          createdAt: new Date(fresh.createdAt),
          paidAt: null,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return toDomain(inserted[0]);
      const existing = await db.select().from(b2bInvoices).where(eq(b2bInvoices.id, newId)).limit(1);
      return existing[0] ? toDomain(existing[0]) : null;
    },
  };
}
export type B2bInvoiceRepo = ReturnType<typeof createB2bInvoiceRepo>;
