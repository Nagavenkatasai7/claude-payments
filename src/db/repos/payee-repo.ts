import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { payees } from '@/db/schema';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import type { PayeeScreenVerdict, PayeeStatus } from '@/lib/payees';
import type { PartnerId } from '@/lib/types';

// payee-repo — Batch B2. The ONE writer of `payees`. Bank details (account holder,
// composed IFSC + account) are sealed under ctx.payee(partner, id, column) and
// never updated: a change is a new payee. Default reads are MASKED (last 4 only);
// getBankDetails is the explicit decrypted read (the payment mint and the audited
// admin reveal). Partner-facing reads take partnerId in the WHERE; the platform
// admin page and the payment path read by id.

export interface Payee {
  id: string;
  partnerId: PartnerId;
  legalName: string;
  payoutLast4: string;
  country: string;
  status: PayeeStatus;
  screening: Exclude<PayeeScreenVerdict, 'match'>;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface PayeeBankDetails {
  accountHolder: string;
  /** "<IFSC> <account>" */
  payoutDestination: string;
}

type Row = typeof payees.$inferSelect;

const toPayee = (r: Row): Payee => ({
  id: r.id,
  partnerId: r.partnerId,
  legalName: r.legalName,
  payoutLast4: r.payoutLast4,
  country: r.country,
  status: r.status as PayeeStatus,
  screening: r.screening as Payee['screening'],
  createdBy: r.createdBy,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt,
  createdAt: r.createdAt,
});

export function createPayeeRepo(db: DbOrTx, provider: EncryptionKeyProvider = defaultProvider()) {
  return {
    async insert(p: {
      id: string;
      partnerId: PartnerId;
      legalName: string;
      accountHolder: string;
      payoutDestination: string;
      last4: string;
      screening: Payee['screening'];
      createdBy: string;
    }): Promise<void> {
      await db.insert(payees).values({
        id: p.id,
        partnerId: p.partnerId,
        legalName: p.legalName,
        accountHolderEnc: encryptField(p.accountHolder, provider, ctx.payee(p.partnerId, p.id, 'account_holder_enc')),
        payoutDestinationEnc: encryptField(
          p.payoutDestination,
          provider,
          ctx.payee(p.partnerId, p.id, 'payout_destination_enc'),
        ),
        payoutLast4: p.last4,
        country: 'IN',
        status: 'pending',
        screening: p.screening,
        createdBy: p.createdBy,
      });
    },

    /** This tenant's payees, newest first (masked). */
    async listForPartner(partnerId: PartnerId, opts: { status?: PayeeStatus } = {}): Promise<Payee[]> {
      const rows = await db
        .select()
        .from(payees)
        .where(opts.status ? and(eq(payees.partnerId, partnerId), eq(payees.status, opts.status)) : eq(payees.partnerId, partnerId))
        .orderBy(desc(payees.createdAt))
        .limit(500);
      return rows.map(toPayee);
    },

    /** One payee of this tenant (masked); null for another tenant's id (404-never-403). */
    async getForPartner(partnerId: PartnerId, id: string): Promise<Payee | null> {
      const rows = await db.select().from(payees).where(and(eq(payees.id, id), eq(payees.partnerId, partnerId))).limit(1);
      return rows[0] ? toPayee(rows[0]) : null;
    },

    /** Platform-admin and payment-path read by id (masked). */
    async getById(id: string): Promise<Payee | null> {
      const rows = await db.select().from(payees).where(eq(payees.id, id)).limit(1);
      return rows[0] ? toPayee(rows[0]) : null;
    },

    /** Every payee (the platform admin queue), optionally by status, newest first (masked). */
    async listAll(opts: { statuses?: PayeeStatus[]; limit?: number } = {}): Promise<Payee[]> {
      const q = db.select().from(payees);
      const rows = await (opts.statuses && opts.statuses.length > 0 ? q.where(inArray(payees.status, opts.statuses)) : q)
        .orderBy(desc(payees.createdAt))
        .limit(opts.limit ?? 200);
      return rows.map(toPayee);
    },

    /**
     * The DECRYPTED bank details. Explicit on purpose: only the payment mint
     * (payment-link-finalize.ts) and the audited admin reveal call it. The
     * context is built from the FETCHED row's own keys.
     */
    async getBankDetails(id: string): Promise<(PayeeBankDetails & { partnerId: PartnerId }) | null> {
      const rows = await db.select().from(payees).where(eq(payees.id, id)).limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        partnerId: r.partnerId,
        accountHolder: decryptField(r.accountHolderEnc, provider, ctx.payee(r.partnerId, r.id, 'account_holder_enc')),
        payoutDestination: decryptField(
          r.payoutDestinationEnc,
          provider,
          ctx.payee(r.partnerId, r.id, 'payout_destination_enc'),
        ),
      };
    },

    /**
     * An admin decision through ONE guarded UPDATE: the row moves only while it is
     * still in one of `from` (a concurrent decision makes this match nothing).
     * Returns the updated payee, or null when the guard failed.
     */
    async decide(
      id: string,
      from: readonly PayeeStatus[],
      to: PayeeStatus,
      actor: string,
      screening?: Payee['screening'],
    ): Promise<Payee | null> {
      const rows = await db
        .update(payees)
        .set({
          status: to,
          decidedBy: actor,
          decidedAt: sql`now()`,
          updatedAt: sql`now()`,
          ...(screening ? { screening } : {}),
        })
        .where(and(eq(payees.id, id), inArray(payees.status, [...from])))
        .returning();
      return rows[0] ? toPayee(rows[0]) : null;
    },

    /** Record a fresh screen verdict without a status change (pay-time / approve-time 'review'). */
    async setScreening(id: string, screening: Payee['screening']): Promise<void> {
      await db.update(payees).set({ screening, updatedAt: sql`now()` }).where(eq(payees.id, id));
    },
  };
}

export type PayeeRepo = ReturnType<typeof createPayeeRepo>;
