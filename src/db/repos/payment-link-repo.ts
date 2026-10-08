import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { payees, paymentLinks, transfers } from '@/db/schema';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import type { LinkStatus } from '@/lib/payment-links';
import type { PartnerId, TransferPurpose, TransferStatus } from '@/lib/types';

// payment-link-repo — Batch B2. The ONE writer of `payment_links`.
//  • Partner reads and writes take partnerId in the WHERE (another tenant's id
//    reads as missing).
//  • The customer name is sealed (ctx.paymentLinkCustomerName); the phone is a
//    digits-only lookup key, like transfers.phone.
//  • A link moves open → used ONLY through claimOpen, called inside the payment's
//    claim transaction (payment-link-finalize.ts) together with the
//    `paylink:<id>` idempotency key; open → cancelled through cancel; open →
//    expired through expireDue. Each is ONE guarded UPDATE on `status = 'open'`,
//    so a payment and a cancel at the same moment cannot both win.

export interface PaymentLink {
  id: string;
  partnerId: PartnerId;
  payeeId: string;
  token: string;
  reference: string;
  customerName: string;
  customerPhone: string;
  amountInr: number;
  purpose: TransferPurpose;
  status: LinkStatus;
  transferId: string | null;
  expiresAt: Date;
  createdBy: string;
  usedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface PaymentLinkListRow extends PaymentLink {
  payeeName: string;
  transferStatus: TransferStatus | null;
}

export interface NewPaymentLink {
  id: string;
  partnerId: PartnerId;
  payeeId: string;
  token: string;
  reference: string;
  customerName: string;
  customerPhone: string;
  amountInr: number;
  purpose: TransferPurpose;
  expiresAt: Date;
  createdBy: string;
}

type Row = typeof paymentLinks.$inferSelect;

export function createPaymentLinkRepo(db: DbOrTx, provider: EncryptionKeyProvider = defaultProvider()) {
  const toLink = (r: Row): PaymentLink => ({
    id: r.id,
    partnerId: r.partnerId,
    payeeId: r.payeeId,
    token: r.token,
    reference: r.reference,
    customerName: decryptField(r.customerNameEnc, provider, ctx.paymentLinkCustomerName(r.partnerId, r.id)),
    customerPhone: r.customerPhone,
    amountInr: Number(r.amountInr),
    purpose: r.purpose as TransferPurpose,
    status: r.status as LinkStatus,
    transferId: r.transferId,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    usedAt: r.usedAt,
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
  });

  return {
    /**
     * Insert links; a reference this partner already used is skipped (the unique
     * (partner_id, reference) index), so the same file uploaded twice creates
     * nothing the second time. Returns the references actually created.
     */
    async insertLinks(rows: readonly NewPaymentLink[]): Promise<string[]> {
      if (rows.length === 0) return [];
      const inserted = await db
        .insert(paymentLinks)
        .values(
          rows.map((l) => ({
            id: l.id,
            partnerId: l.partnerId,
            payeeId: l.payeeId,
            token: l.token,
            reference: l.reference,
            customerNameEnc: encryptField(l.customerName, provider, ctx.paymentLinkCustomerName(l.partnerId, l.id)),
            customerPhone: l.customerPhone,
            amountInr: l.amountInr.toFixed(2),
            purpose: l.purpose,
            status: 'open',
            expiresAt: l.expiresAt,
            createdBy: l.createdBy,
          })),
        )
        .onConflictDoNothing({ target: [paymentLinks.partnerId, paymentLinks.reference] })
        .returning({ reference: paymentLinks.reference });
      return inserted.map((r) => r.reference);
    },

    /** Which of these references this partner already has a link for. */
    async existingReferences(partnerId: PartnerId, references: readonly string[]): Promise<Set<string>> {
      if (references.length === 0) return new Set();
      const rows = await db
        .select({ reference: paymentLinks.reference })
        .from(paymentLinks)
        .where(and(eq(paymentLinks.partnerId, partnerId), inArray(paymentLinks.reference, [...references])));
      return new Set(rows.map((r) => r.reference));
    },

    /**
     * This tenant's links, newest first, with the payee name and the paid
     * transfer's status (joined on the SAME tenant). `reference` filters by a
     * case-insensitive substring.
     */
    async listForPartner(
      partnerId: PartnerId,
      opts: { reference?: string; limit?: number } = {},
    ): Promise<PaymentLinkListRow[]> {
      const q = (opts.reference ?? '').trim().toLowerCase();
      const where = q
        ? and(eq(paymentLinks.partnerId, partnerId), sql`position(${q} in lower(${paymentLinks.reference})) > 0`)
        : eq(paymentLinks.partnerId, partnerId);
      const rows = await db
        .select({ link: paymentLinks, payeeName: payees.legalName, transferStatus: transfers.status })
        .from(paymentLinks)
        .innerJoin(payees, and(eq(payees.id, paymentLinks.payeeId), eq(payees.partnerId, paymentLinks.partnerId)))
        .leftJoin(transfers, and(eq(transfers.id, paymentLinks.transferId), eq(transfers.partnerId, paymentLinks.partnerId)))
        .where(where)
        .orderBy(desc(paymentLinks.createdAt), desc(paymentLinks.id))
        .limit(opts.limit ?? 500);
      return rows.map((r) => ({
        ...toLink(r.link),
        payeeName: r.payeeName,
        transferStatus: (r.transferStatus as TransferStatus | null) ?? null,
      }));
    },

    async getForPartner(partnerId: PartnerId, id: string): Promise<PaymentLink | null> {
      const rows = await db
        .select()
        .from(paymentLinks)
        .where(and(eq(paymentLinks.id, id), eq(paymentLinks.partnerId, partnerId)))
        .limit(1);
      return rows[0] ? toLink(rows[0]) : null;
    },

    /** The customer page's read by its capability token. */
    async getByToken(token: string): Promise<PaymentLink | null> {
      const rows = await db.select().from(paymentLinks).where(eq(paymentLinks.token, token)).limit(1);
      return rows[0] ? toLink(rows[0]) : null;
    },

    /** Cancel an OPEN link of this tenant. False when it is not open (paid, cancelled, expired) or not this tenant's. */
    async cancel(partnerId: PartnerId, id: string, actor: string): Promise<boolean> {
      const rows = await db
        .update(paymentLinks)
        .set({ status: 'cancelled', cancelledAt: sql`now()`, cancelledBy: actor })
        .where(and(eq(paymentLinks.id, id), eq(paymentLinks.partnerId, partnerId), eq(paymentLinks.status, 'open')))
        .returning({ id: paymentLinks.id });
      return rows.length > 0;
    },

    /**
     * open → used, binding the transfer id, while the link is still open and not
     * expired. Called ONLY inside the payment claim transaction. False ⇒ someone
     * else (a second tab, a cancel, the expiry) moved it first.
     */
    async claimOpen(partnerId: PartnerId, id: string, transferId: string, now: Date): Promise<boolean> {
      const rows = await db
        .update(paymentLinks)
        .set({ status: 'used', transferId, usedAt: now })
        .where(
          and(
            eq(paymentLinks.id, id),
            eq(paymentLinks.partnerId, partnerId),
            eq(paymentLinks.status, 'open'),
            sql`${paymentLinks.expiresAt} > ${now.toISOString()}`,
          ),
        )
        .returning({ id: paymentLinks.id });
      return rows.length > 0;
    },

    /** open → expired for every link past its expiry. Returns the expired rows' ids and tenants. */
    async expireDue(now: Date): Promise<Array<{ id: string; partnerId: PartnerId }>> {
      return db
        .update(paymentLinks)
        .set({ status: 'expired' })
        .where(and(eq(paymentLinks.status, 'open'), sql`${paymentLinks.expiresAt} <= ${now.toISOString()}`))
        .returning({ id: paymentLinks.id, partnerId: paymentLinks.partnerId });
    },
  };
}

export type PaymentLinkRepo = ReturnType<typeof createPaymentLinkRepo>;
