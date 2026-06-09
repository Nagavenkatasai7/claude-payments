import { asc, eq, sql } from 'drizzle-orm';
import { customers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { openOptional, sealOptional } from './mappers';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import { countryForPhone } from '@/lib/partner-currency';
import type {
  CountryCode,
  Customer,
  FundingMethod,
  GovIdType,
  KycReviewState,
  KycStatus,
  Occupation,
  SourceOfFunds,
} from '@/lib/types';

// customer-repo — mirrors customer-store's surface. PII at rest: fullName, DOB,
// residentialAddress, govIdNumber are envelope-encrypted into *_enc columns and
// DECRYPTED BY DEFAULT on read — the agent's hot path screens sanctions against
// customer.fullName, so masked reads here would break compliance. (`email` is
// special: the domain value is ALREADY a field-crypto blob written by
// customer-auth-store, so it passes through email_enc verbatim — no double
// encryption.)
//
// upsertOnFirstInbound keeps its exact semantics (grandfathering, opt-in
// backfill, WL2 follow-the-number) but the grandfather check is now an indexed
// MIN(created_at) lookup injected as `firstTransferAt` — the full-ledger scan
// is gone.

type CustomerRow = typeof customers.$inferSelect;

const isoOpt = (d: Date | null): string | undefined => (d ? d.toISOString() : undefined);

export function createCustomerRepo(
  db: DbOrTx,
  firstTransferAt: (phone: string) => Promise<string | null>,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  function rowToCustomer(row: CustomerRow): Customer {
    const c: Customer = {
      senderPhone: row.phone,
      firstSeenAt: row.firstSeenAt.toISOString(),
      kycStatus: row.kycStatus as KycStatus,
      senderCountry: row.senderCountry as CountryCode,
      partnerId: row.partnerId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    const set = <K extends keyof Customer>(k: K, v: Customer[K] | undefined | null) => {
      if (v !== undefined && v !== null && v !== '') (c[k] as Customer[K]) = v as Customer[K];
    };
    set('kycVerifiedAt', isoOpt(row.kycVerifiedAt));
    set('kycProviderRef', row.kycProviderRef);
    set('kycRejectedReason', row.kycRejectedReason);
    set('fullName', openOptional(row.fullNameEnc, provider));
    set('dateOfBirth', openOptional(row.dateOfBirthEnc, provider));
    set('residentialAddress', openOptional(row.residentialAddressEnc, provider));
    set('govIdType', (row.govIdType ?? undefined) as GovIdType | undefined);
    set('govIdNumber', openOptional(row.govIdNumberEnc, provider));
    set('nationality', (row.nationality ?? undefined) as CountryCode | undefined);
    set('pepDeclared', row.pepDeclared ?? undefined);
    set('sourceOfFunds', (row.sourceOfFunds ?? undefined) as SourceOfFunds | undefined);
    set('occupation', (row.occupation ?? undefined) as Occupation | undefined);
    set('eddCapturedAt', isoOpt(row.eddCapturedAt));
    set('lastFundingMethod', (row.lastFundingMethod ?? undefined) as FundingMethod | undefined);
    set('lastFundingMethodAt', isoOpt(row.lastFundingMethodAt));
    set('optInAt', isoOpt(row.optInAt));
    set('optedOutAt', isoOpt(row.optedOutAt));
    set('email', row.emailEnc); // already-a-blob passthrough (see header note)
    set('passwordHash', row.passwordHash);
    set('passwordUpdatedAt', isoOpt(row.passwordUpdatedAt));
    set('phoneVerifiedAt', isoOpt(row.phoneVerifiedAt));
    set('kycInquiryId', row.kycInquiryId);
    set('kycReviewState', (row.kycReviewState ?? undefined) as KycReviewState | undefined);
    set('idLast4', row.idLast4);
    set('idDocType', (row.idDocType ?? undefined) as GovIdType | undefined);
    set('watchlistHit', row.watchlistHit ?? undefined);
    set('pepHit', row.pepHit ?? undefined);
    set('kycSubmittedAt', isoOpt(row.kycSubmittedAt));
    set('kycApprovedBy', row.kycApprovedBy);
    set('kycApprovedAt', isoOpt(row.kycApprovedAt));
    set('kycRejectedAt', isoOpt(row.kycRejectedAt));
    return c;
  }

  function customerToRow(c: Customer): typeof customers.$inferInsert {
    const dateOpt = (s: string | undefined): Date | null => (s ? new Date(s) : null);
    return {
      phone: c.senderPhone,
      partnerId: c.partnerId ?? DEFAULT_PARTNER_ID,
      firstSeenAt: new Date(c.firstSeenAt),
      senderCountry: c.senderCountry,
      kycStatus: c.kycStatus,
      kycReviewState: c.kycReviewState ?? null,
      kycInquiryId: c.kycInquiryId ?? null,
      kycProviderRef: c.kycProviderRef ?? null,
      kycRejectedReason: c.kycRejectedReason ?? null,
      kycVerifiedAt: dateOpt(c.kycVerifiedAt),
      kycSubmittedAt: dateOpt(c.kycSubmittedAt),
      kycApprovedBy: c.kycApprovedBy ?? null,
      kycApprovedAt: dateOpt(c.kycApprovedAt),
      kycRejectedAt: dateOpt(c.kycRejectedAt),
      fullNameEnc: sealOptional(c.fullName, provider) ?? null,
      dateOfBirthEnc: sealOptional(c.dateOfBirth, provider) ?? null,
      residentialAddressEnc: sealOptional(c.residentialAddress, provider) ?? null,
      emailEnc: c.email ?? null, // already a field-crypto blob — stored verbatim
      govIdNumberEnc: sealOptional(c.govIdNumber, provider) ?? null,
      govIdType: c.govIdType ?? null,
      idLast4: c.idLast4 ?? null,
      idDocType: c.idDocType ?? null,
      nationality: c.nationality ?? null,
      pepDeclared: c.pepDeclared ?? null,
      watchlistHit: c.watchlistHit ?? null,
      pepHit: c.pepHit ?? null,
      sourceOfFunds: c.sourceOfFunds ?? null,
      occupation: c.occupation ?? null,
      eddCapturedAt: dateOpt(c.eddCapturedAt),
      lastFundingMethod: c.lastFundingMethod ?? null,
      lastFundingMethodAt: dateOpt(c.lastFundingMethodAt),
      passwordHash: c.passwordHash ?? null,
      passwordUpdatedAt: dateOpt(c.passwordUpdatedAt),
      phoneVerifiedAt: dateOpt(c.phoneVerifiedAt),
      optInAt: dateOpt(c.optInAt),
      optedOutAt: dateOpt(c.optedOutAt),
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt),
    };
  }

  return {
    async getCustomer(senderPhone: string): Promise<Customer | null> {
      const rows = await db.select().from(customers).where(eq(customers.phone, senderPhone)).limit(1);
      return rows[0] ? rowToCustomer(rows[0]) : null;
    },

    async saveCustomer(customer: Customer): Promise<void> {
      const row = customerToRow(customer);
      await db.insert(customers).values(row).onConflictDoUpdate({ target: customers.phone, set: row });
    },

    async upsertOnFirstInbound(
      senderPhone: string,
      routedPartnerId?: string,
    ): Promise<{ customer: Customer; wasCreated: boolean }> {
      const existing = await this.getCustomer(senderPhone);
      if (existing) {
        // Opt-in backfill (first-contact-wins) + WL2 follow-the-number: the
        // partner OWNS the channel — same semantics as the Redis store.
        const needsOptIn = !existing.optInAt;
        const needsRoute = Boolean(routedPartnerId) && existing.partnerId !== routedPartnerId;
        if (needsOptIn || needsRoute) {
          const nowIso = new Date().toISOString();
          const updated: Customer = {
            ...existing,
            ...(needsOptIn ? { optInAt: nowIso } : {}),
            ...(needsRoute ? { partnerId: routedPartnerId! } : {}),
            updatedAt: nowIso,
          };
          await this.saveCustomer(updated);
          return { customer: updated, wasCreated: false };
        }
        return { customer: existing, wasCreated: false };
      }

      const inferredCountry = countryForPhone(senderPhone) ?? DEFAULT_SENDER_COUNTRY;
      // Grandfathering check is an indexed MIN() lookup now — not a ledger scan.
      const minAt = await firstTransferAt(senderPhone);
      const nowIso = new Date().toISOString();
      const partnerId = routedPartnerId ?? DEFAULT_PARTNER_ID;
      const customer: Customer = minAt
        ? {
            senderPhone,
            firstSeenAt: minAt,
            kycStatus: 'grandfathered',
            kycVerifiedAt: nowIso,
            senderCountry: inferredCountry,
            partnerId,
            optInAt: nowIso,
            createdAt: minAt,
            updatedAt: nowIso,
          }
        : {
            senderPhone,
            firstSeenAt: nowIso,
            kycStatus: 'not_started',
            senderCountry: inferredCountry,
            partnerId,
            optInAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
      await this.saveCustomer(customer);
      return { customer, wasCreated: !minAt };
    },

    async setOptedIn(senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optInAt: sql`COALESCE(${customers.optInAt}, now())`, updatedAt: new Date() })
        .where(eq(customers.phone, senderPhone));
    },

    async setOptedOut(senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optedOutAt: new Date(), updatedAt: new Date() })
        .where(eq(customers.phone, senderPhone));
    },

    async clearOptedOut(senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optedOutAt: null, updatedAt: new Date() })
        .where(eq(customers.phone, senderPhone));
    },

    async recordFundingMethod(senderPhone: string, method: FundingMethod): Promise<void> {
      await db
        .update(customers)
        .set({ lastFundingMethod: method, lastFundingMethodAt: new Date(), updatedAt: new Date() })
        .where(eq(customers.phone, senderPhone));
    },

    async recordKycInquiry(senderPhone: string, inquiryId: string): Promise<void> {
      await db
        .update(customers)
        .set({
          kycInquiryId: inquiryId,
          kycProviderRef: inquiryId,
          kycSubmittedAt: sql`COALESCE(${customers.kycSubmittedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(eq(customers.phone, senderPhone));
    },

    async listCustomers(): Promise<Customer[]> {
      const rows = await db.select().from(customers).orderBy(asc(customers.createdAt));
      return rows.map(rowToCustomer);
    },
  };
}

export type CustomerRepo = ReturnType<typeof createCustomerRepo>;
