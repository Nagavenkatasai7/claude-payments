import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  auditEvents,
  b2bInvoices,
  beneficiaries,
  corridorRequests,
  idempotencyKeys,
  outbox,
  partnerApplications,
  partnerRequests,
  recipients,
  sellers,
} from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { isPartnerType } from '@/lib/partner-type';
import { deriveInviteEmailStatus, inviteDedupeKey, type InviteEmailStatus } from '@/lib/partner-invite-email';
import { normalizePhone, isValidPhone } from '@/lib/phone';
import { last4, openOptional } from './mappers';
import { ctx, recipientRowCtx, sellerRowCtx } from '@/lib/crypto-context';
import type {
  B2bInvoice,
  CorridorRequest,
  CountryCode,
  CurrencyCode,
  InvoiceLineItem,
  PartnerApplication,
  PartnerApplicationDetails,
  PartnerApplicationDocument,
  PartnerId,
  PartnerApplicationStatus,
  PartnerRequest,
  PayoutMethod,
  Recipient,
  Seller,
  SellerStatus,
} from '@/lib/types';

// aux-repos — the smaller aggregates, one factory each, mirroring the surfaces
// call sites already use. Payout destinations (full bank accounts) are
// envelope-encrypted at rest everywhere they appear.

// ── Saved recipients (per-TENANT, per-sender address book) ──────────────────
export function createRecipientRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  return {
    async upsertRecipient(partnerId: PartnerId, senderPhone: string, r: Recipient): Promise<void> {
      // The row key AS WRITTEN (the conflict target) — the sealed destination binds to it.
      const key = { partnerId, senderPhone, recipientPhone: r.recipientPhone };
      const row = {
        ...key,
        name: r.name,
        payoutMethod: r.payoutMethod,
        payoutDestinationEnc: r.payoutDestination
          ? encryptField(r.payoutDestination, provider, recipientRowCtx(key))
          : '',
        payoutDestinationLast4: last4(r.payoutDestination ?? ''),
        lastUsedAt: new Date(r.lastUsedAt),
      };
      await db
        .insert(recipients)
        .values(row)
        .onConflictDoUpdate({
          target: [recipients.partnerId, recipients.senderPhone, recipients.recipientPhone],
          set: row,
        });
    },

    async listRecipients(partnerId: PartnerId, senderPhone: string, limit: number): Promise<Recipient[]> {
      const rows = await db
        .select()
        .from(recipients)
        .where(and(eq(recipients.partnerId, partnerId), eq(recipients.senderPhone, senderPhone)))
        .orderBy(desc(recipients.lastUsedAt))
        .limit(limit);
      return rows.map((row) => ({
        name: row.name,
        recipientPhone: row.recipientPhone,
        payoutMethod: row.payoutMethod as PayoutMethod,
        payoutDestination: openOptional(row.payoutDestinationEnc, provider, recipientRowCtx(row)) ?? '',
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
        payoutDestinationEnc: b.payoutDestination
          ? encryptField(b.payoutDestination, provider, ctx.beneficiary(b.id))
          : '',
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
        payoutDestination: openOptional(row.payoutDestinationEnc, provider, ctx.beneficiary(row.id)) ?? '',
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
    // The raw stored value, never coerced: an unknown value must not read as 'invited' (open).
    applicationStatus: row.applicationStatus as PartnerApplicationStatus,
  };
  if (row.comments) r.comments = row.comments;
  if (row.tokenExpiresAt) r.tokenExpiresAt = row.tokenExpiresAt.toISOString();
  if (isPartnerType(row.partnerType)) r.partnerType = row.partnerType;
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
        partnerType: req.partnerType ?? null,
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

    /**
     * Single-use: flip invited → 'completed' so the link is dead. Conditional on
     * 'invited' (Program-Fix 49C): a submit that raced a staff decision can never
     * turn 'approved'/'rejected' back into 'completed'. Returns whether it flipped.
     */
    async markApplicationCompleted(id: string): Promise<boolean> {
      const rows = await db
        .update(partnerRequests)
        .set({ applicationStatus: 'completed' })
        .where(and(eq(partnerRequests.id, id), eq(partnerRequests.applicationStatus, 'invited')))
        .returning({ id: partnerRequests.id });
      return rows.length > 0;
    },

    /**
     * Program-Fix 49C: the staff decision, atomically. completed → approved|rejected
     * AND the link's token hash is cleared (a decided application's link can never
     * resolve again). The WHERE is the guard: a second decision, or a decision on
     * an application that was never submitted, updates nothing and returns false.
     */
    async decideApplication(id: string, decision: 'approved' | 'rejected'): Promise<boolean> {
      const rows = await db
        .update(partnerRequests)
        .set({ applicationStatus: decision, applicationTokenHash: null })
        .where(and(eq(partnerRequests.id, id), eq(partnerRequests.applicationStatus, 'completed')))
        .returning({ id: partnerRequests.id });
      return rows.length > 0;
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
    ...createAuditCaseQueries(db), // Program-Fix 43 (defined below, own region)
    ...createEmailAuditQueries(db), // Program-Fix 39 (defined below, own region)
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

    /**
     * Program-Fix 17a: the newest rows whose `action` is one of `actions`,
     * filtered IN SQL (`action IN (…)`), optionally also by `actor_type`. The
     * Team feed uses it so high-volume auth.* rows can never push the five team
     * actions off a LIMITed read. Ties on `at` break on id (insert order).
     * An empty `actions` list returns [] without a query (no `IN ()`).
     */
    async listRecentByActions(
      actions: readonly string[],
      limit = 50,
      opts: { actorType?: AuditEvent['actorType'] } = {},
    ) {
      if (actions.length === 0) return [];
      const byAction = inArray(auditEvents.action, [...actions]);
      return db
        .select()
        .from(auditEvents)
        .where(opts.actorType ? and(byAction, eq(auditEvents.actorType, opts.actorType)) : byAction)
        .orderBy(desc(auditEvents.at), desc(auditEvents.id))
        .limit(limit);
    },

    /**
     * Program-Fix 28: the durable KYC decision trail for ONE customer —
     * tenant-keyed (partner_id) AND subject-keyed (the keyed auditSubjectId,
     * never a phone), `kyc.*` slugs only, newest first. Feeds the customer
     * page's "KYC audit trail".
     */
    async listKycForSubject(partnerId: PartnerId, subjectId: string, limit = 50): Promise<KycAuditRow[]> {
      const rows = await db
        .select({ actor: auditEvents.actor, action: auditEvents.action, meta: auditEvents.meta, at: auditEvents.at })
        .from(auditEvents)
        .where(
          sql`${auditEvents.partnerId} = ${partnerId}
            AND ${auditEvents.subjectId} = ${subjectId}
            AND ${auditEvents.action} LIKE 'kyc.%'`,
        )
        .orderBy(desc(auditEvents.at), desc(auditEvents.id))
        .limit(limit);
      return rows.map((r) => ({
        actor: r.actor,
        action: r.action,
        meta: (r.meta ?? {}) as Record<string, unknown>,
        at: r.at.toISOString(),
      }));
    },

    /**
     * Program fix 16b: the newest send_limits.set / send_limits.clear row for
     * ONE subject — tenant-keyed, and keyed on the meta scope too so a partner
     * id and a phone can never read each other's history. Feeds the admin
     * "Send limits" card ("last change: actor, when, reason").
     */
    async lastSendLimitChange(
      partnerId: PartnerId,
      scope: 'customer' | 'partner',
      subjectId: string,
    ): Promise<SendLimitChange | null> {
      const rows = await db
        .select({ actor: auditEvents.actor, action: auditEvents.action, meta: auditEvents.meta, at: auditEvents.at })
        .from(auditEvents)
        .where(
          sql`${auditEvents.partnerId} = ${partnerId}
            AND ${auditEvents.subjectId} = ${subjectId}
            AND ${auditEvents.action} IN ('send_limits.set', 'send_limits.clear')
            AND ${auditEvents.meta}->>'scope' = ${scope}`,
        )
        .orderBy(desc(auditEvents.at), desc(auditEvents.id))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        actor: r.actor,
        action: r.action as SendLimitChange['action'],
        meta: (r.meta ?? {}) as Record<string, unknown>,
        at: r.at.toISOString(),
      };
    },
  };
}
export type AuditRepo = ReturnType<typeof createAuditRepo>;

/** One durable KYC decision row, as the customer page renders it (Program-Fix 28). */
export interface KycAuditRow {
  actor: string;
  action: string;
  meta: Record<string, unknown>;
  at: string;
}

/** One send-limit audit row, as the admin card renders it (fix 16b). */
export interface SendLimitChange {
  actor: string;
  action: 'send_limits.set' | 'send_limits.clear';
  meta: Record<string, unknown>;
  at: string;
}

// ── Program-Fix 43: AML / case-surface audit reads (compliance-09, partial) ──
// Kept in their own function (spread into createAuditRepo) so this region
// never overlaps another change to createAuditRepo's body.

/** One audit row as the AML review surfaces use it. */
export interface AuditRow {
  id: number;
  partnerId: PartnerId | null;
  actor: string;
  actorType: string;
  action: string;
  subjectId: string | null;
  meta: Record<string, unknown>;
  at: string;
}

function toAuditRow(r: typeof auditEvents.$inferSelect): AuditRow {
  return {
    id: r.id,
    partnerId: r.partnerId,
    actor: r.actor,
    actorType: r.actorType,
    action: r.action,
    subjectId: r.subjectId,
    meta: (r.meta ?? {}) as Record<string, unknown>,
    at: r.at.toISOString(),
  };
}

/** `partnerId` null ⇒ no tenant filter (platform staff); a string pins the WHERE. */
function tenantCond(partnerId: PartnerId | null | undefined) {
  return partnerId ? eq(auditEvents.partnerId, partnerId) : undefined;
}

function createAuditCaseQueries(db: DbOrTx) {
  return {
    /** One audit row by id, pinned to `partnerId` when given (404-never-403 for the caller). */
    async getById(partnerId: PartnerId | null, id: number): Promise<AuditRow | null> {
      if (!Number.isSafeInteger(id) || id < 1) return null;
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.id, id), tenantCond(partnerId)))
        .limit(1);
      return rows[0] ? toAuditRow(rows[0]) : null;
    },

    /** Every audit row about one subject (a transfer id) in [from, to), tenant-keyed, oldest first. */
    async listBySubject(partnerId: PartnerId | null, subjectId: string, from: Date, to: Date, limit = 200): Promise<AuditRow[]> {
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(
          eq(auditEvents.subjectId, subjectId),
          tenantCond(partnerId),
          gte(auditEvents.at, from),
          lt(auditEvents.at, to),
        ))
        .orderBy(asc(auditEvents.at), asc(auditEvents.id))
        .limit(limit);
      return rows.map(toAuditRow);
    },

    /** Rows of one action in [from, to), optionally tenant-pinned, newest first. */
    async listByAction(
      action: string,
      opts: { partnerId?: PartnerId | null; from: Date; to: Date; limit: number },
    ): Promise<AuditRow[]> {
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(
          eq(auditEvents.action, action),
          tenantCond(opts.partnerId),
          gte(auditEvents.at, opts.from),
          lt(auditEvents.at, opts.to),
        ))
        .orderBy(desc(auditEvents.at), desc(auditEvents.id))
        .limit(opts.limit);
      return rows.map(toAuditRow);
    },

    /**
     * Open AML review items: `aml.alert` rows with no `aml.reviewed` row
     * naming them (meta.alertId) under the same tenant. Newest first, bounded.
     */
    async listOpenAmlAlerts(partnerId: PartnerId | null, limit = 100): Promise<AuditRow[]> {
      const rows = await db
        .select()
        .from(auditEvents)
        .where(and(
          eq(auditEvents.action, 'aml.alert'),
          tenantCond(partnerId),
          sql`NOT EXISTS (SELECT 1 FROM audit_events r
                WHERE r.action = 'aml.reviewed'
                  AND r.partner_id IS NOT DISTINCT FROM ${auditEvents.partnerId}
                  AND r.meta->>'alertId' = ${auditEvents.id}::text)`,
        ))
        .orderBy(desc(auditEvents.at), desc(auditEvents.id))
        .limit(limit);
      return rows.map(toAuditRow);
    },
  };
}

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
    // Cross-border fields (Plan 3) — present only on a cross-border bill; a row
    // with all three null behaves exactly as a back-compat US-domestic invoice.
    if (row.sellerId) inv.sellerId = row.sellerId;
    if (row.invoicedAmount !== null && row.invoicedAmount !== undefined) {
      inv.invoicedAmount = Number(row.invoicedAmount);
    }
    if (row.invoicedCurrency) inv.invoicedCurrency = row.invoicedCurrency as CurrencyCode;
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
        // Cross-border (Plan 3) — persisted only when present; null ⇒ US-domestic.
        sellerId: inv.sellerId ?? null,
        invoicedAmount: inv.invoicedAmount !== undefined ? inv.invoicedAmount.toFixed(2) : null,
        invoicedCurrency: inv.invoicedCurrency ?? null,
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
    async getUnpaidByBuyer(
      buyerPhone: string,
      partnerId: PartnerId,
      // Program-Fix 44: the oldest live created_at (inclusive). Omitted ⇒ no
      // age filter (the store always passes the bill-TTL cutoff).
      createdNotBefore?: Date,
    ): Promise<B2bInvoice | null> {
      const phone = normalizePhone(buyerPhone);
      const ageFilter = createdNotBefore
        ? sql` AND ${b2bInvoices.createdAt} >= ${createdNotBefore.toISOString()}`
        : sql``;
      const rows = await db
        .select()
        .from(b2bInvoices)
        .where(
          sql`${b2bInvoices.partnerId} = ${partnerId} AND ${b2bInvoices.buyerPhone} = ${phone} AND ${b2bInvoices.status} = 'unpaid'${ageFilter}`,
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
    /**
     * Program-Fix 44 — the DURABLE duplicate-bill check: an open (unpaid, not
     * older than `createdNotBefore`) bill from the SAME seller to the SAME buyer
     * for the SAME obligation, tenant-scoped. create_invoice runs it before its
     * 120 s Redis claim, so a duplicate is caught after the claim's TTL too. The
     * amount compares as NUMERIC against the 2-dp string the write stored.
     */
    async findOpenTwin(q: {
      partnerId: PartnerId;
      sellerId: string;
      buyerPhone: string;
      invoicedAmount: number;
      invoicedCurrency: CurrencyCode;
      createdNotBefore: Date;
    }): Promise<B2bInvoice | null> {
      const phone = normalizePhone(q.buyerPhone);
      const rows = await db
        .select()
        .from(b2bInvoices)
        .where(
          sql`${b2bInvoices.partnerId} = ${q.partnerId} AND ${b2bInvoices.sellerId} = ${q.sellerId} AND ${b2bInvoices.buyerPhone} = ${phone} AND ${b2bInvoices.invoicedAmount} = ${q.invoicedAmount.toFixed(2)}::numeric AND ${b2bInvoices.invoicedCurrency} = ${q.invoicedCurrency} AND ${b2bInvoices.status} = 'unpaid' AND ${b2bInvoices.createdAt} >= ${q.createdNotBefore.toISOString()}`,
        )
        .orderBy(desc(b2bInvoices.createdAt), desc(b2bInvoices.id))
        .limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },
    /** Program-Fix 44 — every tenant's invoices, newest first (PLATFORM staff only; the caller gates). */
    async listAllInvoices(limit = 500): Promise<B2bInvoice[]> {
      const rows = await db
        .select()
        .from(b2bInvoices)
        .orderBy(desc(b2bInvoices.createdAt), desc(b2bInvoices.id))
        .limit(limit);
      return rows.map(toDomain);
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
      // A reissued cross-border bill stays cross-border (same fixed obligation).
      if (src.sellerId) fresh.sellerId = src.sellerId;
      if (src.invoicedAmount !== undefined) fresh.invoicedAmount = src.invoicedAmount;
      if (src.invoicedCurrency) fresh.invoicedCurrency = src.invoicedCurrency;
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
          sellerId: fresh.sellerId ?? null,
          invoicedAmount: fresh.invoicedAmount !== undefined ? fresh.invoicedAmount.toFixed(2) : null,
          invoicedCurrency: fresh.invoicedCurrency ?? null,
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

// ── Registered cross-border B2B sellers ─────────────────────────────────────
export function createSellerRepo(db: DbOrTx) {
  const toDomain = (row: typeof sellers.$inferSelect): Seller => {
    const s: Seller = {
      id: row.id,
      partnerId: row.partnerId,
      phone: row.phone,
      businessName: row.businessName,
      country: row.country as CountryCode,
      currency: row.currency as CurrencyCode,
      payoutMethod: row.payoutMethod === 'usdc' ? 'usdc' : 'bank',
      status: row.status as SellerStatus,
      kycReviewState: row.kycReviewState as Seller['kycReviewState'],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    if (row.payoutLast4) s.payoutLast4 = row.payoutLast4;
    return s;
  };

  const requireValidPhone = (raw: string): string => {
    const phone = normalizePhone(raw);
    if (!isValidPhone(phone)) {
      throw new Error('Seller phone must be a valid phone (country code + number, digits only).');
    }
    return phone;
  };

  const fetchRow = async (phone: string, partnerId: PartnerId) => {
    const rows = await db
      .select()
      .from(sellers)
      .where(sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalizePhone(phone)}`)
      .limit(1);
    return rows[0] ?? null;
  };

  return {
    async createSeller(input: {
      id: string; partnerId: PartnerId; phone: string; businessName: string;
      country: CountryCode; currency: CurrencyCode;
      // The INITIAL review state, set atomically at insert. The onboarding tool
      // screens sanctions BEFORE creating the row and passes 'needs_review' on a
      // hit OR a screener error (fail-closed) — so a 'none' row provably means a
      // CLEAN screen completed. A pending+'none' row is the ONLY shape that ever
      // earns an onboarding link, so a never-cleared business can't look clean.
      kycReviewState?: Seller['kycReviewState'];
    }): Promise<Seller> {
      const phone = requireValidPhone(input.phone);
      await db.insert(sellers).values({
        id: input.id,
        partnerId: input.partnerId,
        phone,
        businessName: input.businessName,
        country: input.country,
        currency: input.currency,
        status: 'pending',
        kycReviewState: input.kycReviewState ?? 'none',
      });
      const row = await fetchRow(phone, input.partnerId);
      return toDomain(row!);
    },

    async getSeller(phone: string, partnerId: PartnerId): Promise<Seller | null> {
      const row = await fetchRow(phone, partnerId);
      return row ? toDomain(row) : null;
    },

    /**
     * Masked read by the seller's own id — the unguessable capability the hosted
     * onboarding link (`/onboard/seller/<id>`) carries, mirroring how the pay page
     * loads a transfer by id. Returns the masked Seller (phone + partnerId ride
     * along so the onboarding action can re-scope its writes), or null when no row
     * matches (404-never-403: a missing id is indistinguishable from a stranger's).
     */
    async getSellerById(id: string): Promise<Seller | null> {
      const rows = await db.select().from(sellers).where(eq(sellers.id, id)).limit(1);
      return rows[0] ? toDomain(rows[0]) : null;
    },

    async getSellerDecrypted(
      phone: string, partnerId: PartnerId,
    ): Promise<(Seller & { payoutDestination: string }) | null> {
      const row = await fetchRow(phone, partnerId);
      if (!row) return null;
      const payoutDestination = row.payoutDestinationEnc
        ? decryptField(row.payoutDestinationEnc, undefined, sellerRowCtx(row))
        : '';
      return { ...toDomain(row), payoutDestination };
    },

    async setPayoutDestination(
      phone: string, partnerId: PartnerId, payoutDestination: string,
    ): Promise<Seller | null> {
      const normalized = normalizePhone(phone);
      // The UPDATE's WHERE key (partner_id, normalized phone) IS the row's key.
      const enc = encryptField(payoutDestination, undefined, sellerRowCtx({ partnerId, phone: normalized }));
      const tail = payoutDestination.replace(/\s+/g, '').slice(-4);
      const updated = await db
        .update(sellers)
        .set({ payoutDestinationEnc: enc, payoutLast4: tail, updatedAt: new Date() })
        .where(sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalized}`)
        .returning();
      return updated[0] ? toDomain(updated[0]) : null;
    },

    async setStatus(
      phone: string, partnerId: PartnerId, status: SellerStatus,
    ): Promise<Seller | null> {
      const normalized = normalizePhone(phone);
      const updated = await db
        .update(sellers)
        .set({ status, updatedAt: new Date() })
        .where(sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalized}`)
        .returning();
      return updated[0] ? toDomain(updated[0]) : null;
    },

    /**
     * Drive the seller's KYC/compliance review state (partner-scoped). The
     * onboarding tool sets 'needs_review' when the business name hits the
     * sanctions screen — the seller stays 'pending' (never silently passes) and
     * no onboarding link is issued until staff clear it. Returns the updated row
     * or null when no scoped seller matches.
     */
    async setReviewState(
      phone: string, partnerId: PartnerId, kycReviewState: Seller['kycReviewState'],
    ): Promise<Seller | null> {
      const normalized = normalizePhone(phone);
      const updated = await db
        .update(sellers)
        .set({ kycReviewState, updatedAt: new Date() })
        .where(sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalized}`)
        .returning();
      return updated[0] ? toDomain(updated[0]) : null;
    },

    /**
     * Complete onboarding ATOMICALLY: encrypt + store the payout, persist the
     * chosen payout METHOD ('bank' default | 'usdc' wallet), AND flip status
     * to 'active' in ONE guarded UPDATE. The WHERE GUARDS on `status = 'pending'
     * AND kycReviewState <> 'needs_review'`, so:
     *   • a TOCTOU race (staff flag 'needs_review' between the seller's page load
     *     and submit) can NEVER activate a held seller — the guard matches 0 rows;
     *   • there is no payout-stored-but-still-pending half-state a two-write path
     *     would leave on a mid-sequence failure;
     *   • a no-op (already active / suspended / under review / gone) returns null,
     *     so the caller can refuse instead of falsely reporting success.
     * Returns the activated row, or null when the guard matched nothing.
     */
    async activateOnboarding(
      phone: string, partnerId: PartnerId, payoutDestination: string,
      payoutMethod: Seller['payoutMethod'] = 'bank',
    ): Promise<Seller | null> {
      const normalized = normalizePhone(phone);
      // The UPDATE's WHERE key (partner_id, normalized phone) IS the row's key.
      const enc = encryptField(payoutDestination, undefined, sellerRowCtx({ partnerId, phone: normalized }));
      const tail = payoutDestination.replace(/\s+/g, '').slice(-4);
      const updated = await db
        .update(sellers)
        .set({ payoutDestinationEnc: enc, payoutLast4: tail, payoutMethod, status: 'active', updatedAt: new Date() })
        .where(
          sql`${sellers.partnerId} = ${partnerId} AND ${sellers.phone} = ${normalized} AND ${sellers.status} = 'pending' AND ${sellers.kycReviewState} <> 'needs_review'`,
        )
        .returning();
      return updated[0] ? toDomain(updated[0]) : null;
    },
  };
}
export type SellerRepo = ReturnType<typeof createSellerRepo>;

// ── Program-Fix 39: honest-email audit reads (domain-11) ─────────────────────
// Own region (spread into createAuditRepo) so it never overlaps another change.

function createEmailAuditQueries(db: DbOrTx) {
  return {
    /** How many `action` rows were written in the last `sinceDays` days (exact match). */
    async countByAction(action: string, sinceDays: number): Promise<number> {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(
          sql`${auditEvents.action} = ${action}
            AND ${auditEvents.at} >= now() - make_interval(days => ${Math.max(0, Math.floor(sinceDays))})`,
        );
      return Number(rows[0]?.n ?? 0);
    },
  };
}

/**
 * The newest partner-invite email's status for ONE partner request: the newest
 * 'email.send' row keyed `partner_app_invite:<id>` or `partner_app_invite:<id>:r…`
 * (exact / starts_with — never LIKE, whose `_` wildcard both prefixes contain),
 * plus the `email.skipped` audit rows naming that request. Platform staff only
 * (the caller's page gate); reads no address.
 */
export async function getInviteEmailStatus(db: DbOrTx, requestId: string): Promise<InviteEmailStatus> {
  const key = inviteDedupeKey(requestId);
  const rows = await db
    .select({ id: outbox.id, status: outbox.status })
    .from(outbox)
    .where(
      sql`${outbox.kind} = 'email.send'
        AND (${outbox.dedupeKey} = ${key} OR starts_with(${outbox.dedupeKey}, ${`${key}:r`}))`,
    )
    .orderBy(desc(outbox.id))
    .limit(1);
  const newest = rows[0] ? { id: Number(rows[0].id), status: rows[0].status } : null;
  if (!newest || newest.status !== 'done') return deriveInviteEmailStatus(newest, []);
  const skips = await db
    .select({ meta: auditEvents.meta })
    .from(auditEvents)
    .where(sql`${auditEvents.action} = 'email.skipped' AND ${auditEvents.subjectId} = ${requestId}`)
    .orderBy(desc(auditEvents.id))
    .limit(50);
  return deriveInviteEmailStatus(
    newest,
    skips.map((r) => {
      const id = Number((r.meta as Record<string, unknown> | null)?.outboxId);
      return { outboxId: Number.isSafeInteger(id) ? id : null };
    }),
  );
}
