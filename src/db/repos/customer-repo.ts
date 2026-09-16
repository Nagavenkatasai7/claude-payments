import { and, asc, eq, sql } from 'drizzle-orm';
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
  PartnerId,
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
// TENANT IDENTITY (fix 1 / F44): the key is (partner_id, phone). Every read and
// write takes partnerId FIRST and carries it in the WHERE; a phone alone never
// selects a row. The one cross-tenant read is findByPhone, used by portal auth,
// the platform-staff detail page and the Persona webhook only. upsertOnFirstInbound
// NEVER moves a row between tenants — a partner-signed inbound for a phone that
// exists under another partner creates that partner's OWN sibling row. The
// grandfather check is the indexed MIN(created_at) for (partner, phone).

type CustomerRow = typeof customers.$inferSelect;

const isoOpt = (d: Date | null): string | undefined => (d ? d.toISOString() : undefined);

export function createCustomerRepo(
  db: DbOrTx,
  firstTransferAt: (partnerId: PartnerId, phone: string) => Promise<string | null>,
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

  // The tenant key — the WHERE of every scoped read/write below.
  const tenantKey = (partnerId: PartnerId, phone: string) =>
    and(eq(customers.partnerId, partnerId), eq(customers.phone, phone));

  function freshCustomer(
    partnerId: PartnerId,
    senderPhone: string,
    nowIso: string,
    minAt: string | null,
    optIn: boolean,
  ): Customer {
    const inferredCountry = countryForPhone(senderPhone) ?? DEFAULT_SENDER_COUNTRY;
    // createdAt is NEVER backdated (D9 invariant): the grandfather branch keeps
    // firstSeenAt = minAt (the tenant's earliest transfer) but stamps
    // createdAt = nowIso, so every row created after fix 1 sorts strictly AFTER
    // every pre-fix row in findByPhone — legacy-tenant.ts's "oldest row is the
    // pre-fix owner" rule depends on it. (Pre-fix the partner API minted without
    // a customers row, so a sibling backdated to its first transfer could sort
    // before — or tie with — the real pre-fix owner and inherit its legacy
    // kyc_audit / conv / counters.) Safe: tier-rules, kyc-gate, compliance and
    // customer-summary never read createdAt, and no test asserts a grandfathered
    // row's createdAt.
    const base: Customer = minAt
      ? {
          senderPhone,
          firstSeenAt: minAt,
          kycStatus: 'grandfathered',
          kycVerifiedAt: nowIso,
          senderCountry: inferredCountry,
          partnerId,
          createdAt: nowIso,
          updatedAt: nowIso,
        }
      : {
          senderPhone,
          firstSeenAt: nowIso,
          kycStatus: 'not_started',
          senderCountry: inferredCountry,
          partnerId,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
    return optIn ? { ...base, optInAt: nowIso } : base;
  }

  return {
    async getCustomer(partnerId: PartnerId, senderPhone: string): Promise<Customer | null> {
      const rows = await db.select().from(customers).where(tenantKey(partnerId, senderPhone)).limit(1);
      return rows[0] ? rowToCustomer(rows[0]) : null;
    },

    /**
     * Every tenant's row for a phone (oldest first). The ONLY phone-alone read;
     * callers must resolve exactly one row themselves and fail closed otherwise.
     */
    async findByPhone(senderPhone: string): Promise<Customer[]> {
      const rows = await db
        .select()
        .from(customers)
        .where(eq(customers.phone, senderPhone))
        .orderBy(asc(customers.createdAt), asc(customers.partnerId));
      return rows.map(rowToCustomer);
    },

    async saveCustomer(customer: Customer): Promise<void> {
      const row = customerToRow(customer);
      await db
        .insert(customers)
        .values(row)
        .onConflictDoUpdate({ target: [customers.partnerId, customers.phone], set: row });
    },

    /**
     * Resolve-or-create WITHOUT implying WhatsApp consent (no optInAt). The
     * partner API mints for senders who never messaged anyone; opt-in is a
     * channel fact recorded only by the inbound webhook (upsertOnFirstInbound).
     */
    async ensureCustomer(partnerId: PartnerId, senderPhone: string): Promise<Customer> {
      const existing = await this.getCustomer(partnerId, senderPhone);
      if (existing) return existing;
      const nowIso = new Date().toISOString();
      const minAt = await firstTransferAt(partnerId, senderPhone);
      const customer = freshCustomer(partnerId, senderPhone, nowIso, minAt, false);
      await db.insert(customers).values(customerToRow(customer)).onConflictDoNothing();
      return (await this.getCustomer(partnerId, senderPhone)) ?? customer;
    },

    async upsertOnFirstInbound(
      partnerId: PartnerId,
      senderPhone: string,
    ): Promise<{ customer: Customer; wasCreated: boolean }> {
      const existing = await this.getCustomer(partnerId, senderPhone);
      if (existing) {
        // Opt-in backfill (first-contact-wins). NO partner_id rewrite: the
        // tenant is fixed by the key; another tenant's row is invisible here.
        if (!existing.optInAt) {
          const nowIso = new Date().toISOString();
          const updated: Customer = { ...existing, optInAt: nowIso, updatedAt: nowIso };
          await this.saveCustomer(updated);
          return { customer: updated, wasCreated: false };
        }
        return { customer: existing, wasCreated: false };
      }
      const nowIso = new Date().toISOString();
      // Grandfathering is per tenant: only THIS partner's ledger history counts.
      const minAt = await firstTransferAt(partnerId, senderPhone);
      const customer = freshCustomer(partnerId, senderPhone, nowIso, minAt, true);
      await this.saveCustomer(customer);
      return { customer, wasCreated: !minAt };
    },

    async setOptedIn(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optInAt: sql`COALESCE(${customers.optInAt}, now())`, updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async setOptedOut(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optedOutAt: new Date(), updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async clearOptedOut(partnerId: PartnerId, senderPhone: string): Promise<void> {
      await db
        .update(customers)
        .set({ optedOutAt: null, updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async recordFundingMethod(partnerId: PartnerId, senderPhone: string, method: FundingMethod): Promise<void> {
      await db
        .update(customers)
        .set({ lastFundingMethod: method, lastFundingMethodAt: new Date(), updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
    },

    async recordKycInquiry(partnerId: PartnerId, senderPhone: string, inquiryId: string): Promise<void> {
      await db
        .update(customers)
        .set({
          kycInquiryId: inquiryId,
          kycProviderRef: inquiryId,
          kycSubmittedAt: sql`COALESCE(${customers.kycSubmittedAt}, now())`,
          updatedAt: new Date(),
        })
        .where(tenantKey(partnerId, senderPhone));
    },

    /** Platform-wide when partnerId is absent; tenant-scoped at the WHERE otherwise. */
    async listCustomers(partnerId?: PartnerId): Promise<Customer[]> {
      const rows = partnerId
        ? await db.select().from(customers).where(eq(customers.partnerId, partnerId)).orderBy(asc(customers.createdAt))
        : await db.select().from(customers).orderBy(asc(customers.createdAt));
      return rows.map(rowToCustomer);
    },
  };
}

export type CustomerRepo = ReturnType<typeof createCustomerRepo>;
