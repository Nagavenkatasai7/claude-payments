import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { customers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { openOptional, sealOptional } from './mappers';
import { customerRowCtx } from '@/lib/crypto-context';
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
  SendLimitOverride,
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
// selects a row. The cross-tenant reads are findByPhone, used by portal auth,
// the platform-staff detail page and the Persona webhook only, and
// findByKycInquiryId (Program-Fix 35), used by the Persona webhook only to bind
// a report event (which carries no phone) by the inquiry the row recorded. upsertOnFirstInbound
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
    // Contexts come from the FETCHED row's own key (Program-Fix 46A); a mismatch
    // throws (openOptional never swallows) — the sanctions screen reads fullName.
    set('fullName', openOptional(row.fullNameEnc, provider, customerRowCtx(row, 'full_name_enc')));
    set('dateOfBirth', openOptional(row.dateOfBirthEnc, provider, customerRowCtx(row, 'date_of_birth_enc')));
    set('residentialAddress', openOptional(row.residentialAddressEnc, provider, customerRowCtx(row, 'residential_address_enc')));
    set('govIdType', (row.govIdType ?? undefined) as GovIdType | undefined);
    set('govIdNumber', openOptional(row.govIdNumberEnc, provider, customerRowCtx(row, 'gov_id_number_enc')));
    set('nationality', (row.nationality ?? undefined) as CountryCode | undefined);
    set('pepDeclared', row.pepDeclared ?? undefined);
    set('sourceOfFunds', (row.sourceOfFunds ?? undefined) as SourceOfFunds | undefined);
    set('occupation', (row.occupation ?? undefined) as Occupation | undefined);
    set('eddCapturedAt', isoOpt(row.eddCapturedAt));
    // Program fix 16: READ-ONLY here (not in customerToRow — saveCustomer's
    // full-row upsert must never rewrite it; fix 16b's setSendLimitOverride is
    // the single-column writer). Nothing evaluates it until fix 16b.
    if (row.sendLimitOverride && typeof row.sendLimitOverride === 'object') {
      c.sendLimitOverride = row.sendLimitOverride as SendLimitOverride;
    }
    set('lastFundingMethod', (row.lastFundingMethod ?? undefined) as FundingMethod | undefined);
    set('lastFundingMethodAt', isoOpt(row.lastFundingMethodAt));
    set('optInAt', isoOpt(row.optInAt));
    set('optedOutAt', isoOpt(row.optedOutAt));
    set('email', row.emailEnc); // already-a-blob passthrough (see header note)
    set('passwordHash', row.passwordHash);
    set('passwordUpdatedAt', isoOpt(row.passwordUpdatedAt));
    set('phoneVerifiedAt', isoOpt(row.phoneVerifiedAt));
    // Program-Fix 49D: ON = a secret is stored (a stamp without a secret is not
    // enrolment). The secret is NOT opened here — readMfa does that on demand.
    if (row.mfaTotpEnc) set('mfaEnrolledAt', isoOpt(row.mfaEnrolledAt) ?? row.updatedAt.toISOString());
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
    // The row key AS WRITTEN — every sealed column below binds to it.
    const key = { partnerId: c.partnerId ?? DEFAULT_PARTNER_ID, phone: c.senderPhone };
    return {
      phone: key.phone,
      partnerId: key.partnerId,
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
      fullNameEnc: sealOptional(c.fullName, provider, customerRowCtx(key, 'full_name_enc')) ?? null,
      dateOfBirthEnc: sealOptional(c.dateOfBirth, provider, customerRowCtx(key, 'date_of_birth_enc')) ?? null,
      residentialAddressEnc: sealOptional(c.residentialAddress, provider, customerRowCtx(key, 'residential_address_enc')) ?? null,
      emailEnc: c.email ?? null, // already a field-crypto blob — stored verbatim
      govIdNumberEnc: sealOptional(c.govIdNumber, provider, customerRowCtx(key, 'gov_id_number_enc')) ?? null,
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

    /**
     * Program-Fix 35: every tenant's row that recorded this Persona inquiry id
     * (oldest first). Cross-tenant, like findByPhone — the Persona webhook only;
     * it binds a report event when exactly ONE row matches and fails closed
     * otherwise. An empty id matches nothing. (No index on kyc_inquiry_id:
     * a scan is acceptable at today's customer count; add one if it grows.)
     */
    async findByKycInquiryId(inquiryId: string): Promise<Customer[]> {
      if (!inquiryId) return [];
      const rows = await db
        .select()
        .from(customers)
        .where(eq(customers.kycInquiryId, inquiryId))
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
     * Program-Fix 17a: the lazy scrypt → Argon2id upgrade as a single-column
     * COMPARE-AND-SET — `UPDATE customers SET password_hash = $new,
     * updated_at = now() WHERE partner_id = $p AND phone = $ph AND
     * password_hash = $old`. Unlike saveCustomer's whole-row upsert it can never
     * revert a concurrent password reset (the old hash no longer matches) or a
     * concurrent KYC / consent write (no other column is named). Returns whether
     * a row was updated (via RETURNING, not a driver-specific rowCount).
     */
    async upgradePasswordHash(
      partnerId: PartnerId,
      senderPhone: string,
      oldHash: string,
      newHash: string,
    ): Promise<boolean> {
      const rows = await db
        .update(customers)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(and(tenantKey(partnerId, senderPhone), eq(customers.passwordHash, oldHash)))
        .returning({ phone: customers.phone });
      return rows.length > 0;
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

    /**
     * Program-Fix 28: a LOCK-ONLY read of one tenant row — `SELECT 1 … FOR
     * UPDATE` keyed (partner_id, phone), returning whether the row exists. Run
     * it on a TRANSACTION handle before the ordinary (decrypting) getCustomer,
     * so a staff KYC decision serializes against a concurrent one without ever
     * round-tripping masked or ciphertext values through the domain object.
     */
    async lockCustomer(partnerId: PartnerId, senderPhone: string): Promise<boolean> {
      const rows = await db
        .select({ one: sql<number>`1` })
        .from(customers)
        .where(tenantKey(partnerId, senderPhone))
        .limit(1)
        .for('update');
      return rows.length > 0;
    },

    /**
     * Program fix 16b: the ONE writer of customers.send_limit_override — a
     * single-column UPDATE keyed (partner_id, phone), so a KYC / consent
     * saveCustomer (which never names the column) can't clobber a raise and a
     * raise can't clobber anything else. Reads the previous value under FOR
     * UPDATE first so the caller's audit row records the true old value when
     * this runs inside its transaction. A missing row ⇒ { found: false } and
     * nothing written (the caller refuses "Customer not found.").
     */
    async setSendLimitOverride(
      partnerId: PartnerId,
      senderPhone: string,
      value: SendLimitOverride | null,
    ): Promise<{ found: boolean; previous: SendLimitOverride | null }> {
      const rows = await db
        .select({ sendLimitOverride: customers.sendLimitOverride })
        .from(customers)
        .where(tenantKey(partnerId, senderPhone))
        .limit(1)
        .for('update');
      if (!rows[0]) return { found: false, previous: null };
      const prev = rows[0].sendLimitOverride;
      const previous = prev && typeof prev === 'object' ? (prev as SendLimitOverride) : null;
      await db
        .update(customers)
        .set({ sendLimitOverride: value, updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone));
      return { found: true, previous };
    },

    /**
     * Program-Fix 14: the set-once writer of a customer's own legal name — a
     * single-column conditional UPDATE keyed (partner_id, phone) that lands
     * only while no name is on file (NULL, or the '' sealOptional keeps for an
     * empty value). Sealed exactly as customerToRow seals it (same provider,
     * same (partner_id, phone, 'full_name_enc') context), so getCustomer opens
     * it. It never rewrites another column, so a concurrent KYC / consent
     * write to the row survives, and a name already there (including one that
     * landed after the caller's read) is never replaced. Returns whether this
     * call wrote it; false for a missing row or a name already on file.
     */
    async setFullNameIfUnset(partnerId: PartnerId, senderPhone: string, fullName: string): Promise<boolean> {
      const sealed = sealOptional(fullName, provider, customerRowCtx({ partnerId, phone: senderPhone }, 'full_name_enc'));
      if (!sealed) return false;
      const rows = await db
        .update(customers)
        .set({ fullNameEnc: sealed, updatedAt: new Date() })
        .where(and(tenantKey(partnerId, senderPhone), or(isNull(customers.fullNameEnc), eq(customers.fullNameEnc, ''))))
        .returning({ phone: customers.phone });
      return rows.length > 0;
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

    // ── Program-Fix 49D: portal TOTP (customers.mfa_totp_enc / mfa_enrolled_at) ──
    // The ONLY writers of these two columns: single-column UPDATEs keyed
    // (partner_id, phone). customerToRow never names them, so no whole-row
    // saveCustomer (this build's or the previous one's) can set or clear an
    // enrolment. The base32 secret is sealed with encryptField under
    // customerRowCtx({partnerId, phone}, 'mfa_totp_enc') — v1 until 46B flips
    // writes to v2 — and opened under the FETCHED row's own key.

    /** ON = a secret is stored (no decrypt: a blob that no longer opens still counts, so it fails closed). */
    async isMfaEnrolled(partnerId: PartnerId, senderPhone: string): Promise<boolean> {
      const rows = await db
        .select({ on: sql<boolean>`${customers.mfaTotpEnc} IS NOT NULL` })
        .from(customers)
        .where(tenantKey(partnerId, senderPhone))
        .limit(1);
      return rows[0]?.on === true;
    },

    /**
     * The stored secret, or null when MFA is off. Throws when the blob does not
     * open (tamper, a moved blob, a key mismatch): callers fail CLOSED.
     */
    async readMfa(
      partnerId: PartnerId,
      senderPhone: string,
    ): Promise<{ secretBase32: string; sealed: string } | null> {
      const rows = await db
        .select({ partnerId: customers.partnerId, phone: customers.phone, mfaTotpEnc: customers.mfaTotpEnc })
        .from(customers)
        .where(tenantKey(partnerId, senderPhone))
        .limit(1);
      const row = rows[0];
      if (!row?.mfaTotpEnc) return null;
      const secretBase32 = decryptField(row.mfaTotpEnc, provider, customerRowCtx(row, 'mfa_totp_enc'));
      return { secretBase32, sealed: row.mfaTotpEnc };
    },

    /** Turn MFA on. Never replaces an existing enrolment; false for a missing row or one already on. */
    async enableMfa(partnerId: PartnerId, senderPhone: string, secretBase32: string): Promise<boolean> {
      const sealed = encryptField(secretBase32, provider, customerRowCtx({ partnerId, phone: senderPhone }, 'mfa_totp_enc'));
      const at = new Date();
      const rows = await db
        .update(customers)
        .set({ mfaTotpEnc: sealed, mfaEnrolledAt: at, updatedAt: at })
        .where(and(tenantKey(partnerId, senderPhone), isNull(customers.mfaTotpEnc)))
        .returning({ phone: customers.phone });
      return rows.length > 0;
    },

    /** Turn MFA off (recovery). Returns whether it was on. */
    async clearMfa(partnerId: PartnerId, senderPhone: string): Promise<boolean> {
      const rows = await db
        .update(customers)
        .set({ mfaTotpEnc: null, mfaEnrolledAt: null, updatedAt: new Date() })
        .where(and(tenantKey(partnerId, senderPhone), isNotNull(customers.mfaTotpEnc)))
        .returning({ phone: customers.phone });
      return rows.length > 0;
    },

    /**
     * Re-seal after a successful verify when a fresh seal would be a different
     * version (v1 → v2 once 46B flips writes; a no-op before). Compare-and-set
     * on the blob that was read, so a reset or re-enrolment in between wins.
     */
    async resealMfa(partnerId: PartnerId, senderPhone: string, oldSealed: string, secretBase32: string): Promise<boolean> {
      const fresh = encryptField(secretBase32, provider, customerRowCtx({ partnerId, phone: senderPhone }, 'mfa_totp_enc'));
      const version = (b: string) => b.slice(0, b.indexOf('.'));
      if (version(fresh) === version(oldSealed)) return false;
      const rows = await db
        .update(customers)
        .set({ mfaTotpEnc: fresh })
        .where(and(tenantKey(partnerId, senderPhone), eq(customers.mfaTotpEnc, oldSealed)))
        .returning({ phone: customers.phone });
      return rows.length > 0;
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
