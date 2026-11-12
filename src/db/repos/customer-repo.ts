import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { customers } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { decryptField, defaultProvider, encryptField, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { openOptional, sealOptional } from './mappers';
import { customerEmailCtx, customerRowCtx } from '@/lib/crypto-context';
import { DEFAULT_PARTNER_ID, DEFAULT_SENDER_COUNTRY } from '@/lib/defaults';
import { countryForPhone } from '@/lib/partner-currency';
import { isResidenceSource, isUsStateCode, type UsStateCode } from '@/lib/licence-matrix';
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
    // Fix pack 2 (R06): READ-ONLY here (never in customerToRow, like
    // sendLimitOverride): stampScreeningFlagged / clearScreeningHold are the
    // single-column writers, so saveCustomer's whole-row upsert cannot touch them.
    set('screeningFlaggedAt', isoOpt(row.screeningFlaggedAt));
    set('screeningClearedAt', isoOpt(row.screeningClearedAt));
    // Fix pack 7 (R2): READ-ONLY too (never in customerToRow); only
    // stampScreeningFlagged(kind 'watchlist') writes it. Absent when NULL.
    set('screeningWatchlistAt', isoOpt(row.screeningWatchlistAt));
    // Fix pack 6 (R46): READ-ONLY here (never in customerToRow):
    // recordEsignConsent / withdrawEsignConsent are the only writers, so no
    // whole-row save or insert can set or clear a consent.
    set('esignConsentVersion', row.esignConsentVersion);
    set('esignConsentedAt', isoOpt(row.esignConsentedAt));
    set('esignWithdrawnAt', isoOpt(row.esignWithdrawnAt));
    // Fix pack 8 (R12, P7): READ-ONLY here (never in customerToRow):
    // setResidenceState is the only writer. A half-written row (a state
    // without a valid source, or the reverse) maps neither, so it never reads
    // as verified. The reserved source 'kyc_vendor' is readable (D8).
    if (isUsStateCode(row.residenceState) && isResidenceSource(row.residenceStateSource)) {
      set('residenceState', row.residenceState);
      set('residenceStateSource', row.residenceStateSource);
      set('residenceStateAt', isoOpt(row.residenceStateAt));
    }
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
     * Which of `phones` are customers of THIS tenant (partnerId in the WHERE), in one read that
     * selects the key column only (nothing is decrypted). Backs the /partner "Open customer" links.
     */
    async existingPhones(partnerId: PartnerId, phones: readonly string[]): Promise<Set<string>> {
      const wanted = [...new Set(phones.filter((p) => typeof p === 'string' && p.length > 0))];
      if (!partnerId || wanted.length === 0) return new Set();
      const rows = await db
        .select({ phone: customers.phone })
        .from(customers)
        .where(and(eq(customers.partnerId, partnerId), inArray(customers.phone, wanted)));
      return new Set(rows.map((r) => r.phone));
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
      // A whole-row upsert, EXCEPT the legal name: a save that carries no name
      // (blank or whitespace) keeps the one on file, so a copy read before
      // set_sender_name landed can never write the old empty name back and
      // stop the owner's scheduled sends again (2026-10-02). A save that
      // carries a name still writes it.
      // Fix pack 5 (P20): the address and the date of birth are kept the same
      // way; they are written only by the set-if-unset setters
      // (setResidentialAddressIfUnset / setDateOfBirthIfUnset), so a stale copy
      // never clears travel-rule originator data.
      const carriesName = (customer.fullName ?? '').trim() !== '';
      const carriesAddress = (customer.residentialAddress ?? '').trim() !== '';
      const carriesDob = (customer.dateOfBirth ?? '').trim() !== '';
      await db
        .insert(customers)
        .values(row)
        .onConflictDoUpdate({
          target: [customers.partnerId, customers.phone],
          set: {
            ...row,
            ...(carriesName ? {} : { fullNameEnc: sql`${customers.fullNameEnc}` }),
            ...(carriesAddress ? {} : { residentialAddressEnc: sql`${customers.residentialAddressEnc}` }),
            ...(carriesDob ? {} : { dateOfBirthEnc: sql`${customers.dateOfBirthEnc}` }),
          },
        });
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
     * Lost-features p2 A5: insert a customer only when (tenant, phone) is free. Returns whether a
     * row was inserted; an existing row is never touched (unlike saveCustomer's upsert, so a
     * manual create can never overwrite a customer, even in a race).
     */
    async insertCustomerIfAbsent(customer: Customer): Promise<boolean> {
      const rows = await db
        .insert(customers)
        .values(customerToRow(customer))
        .onConflictDoNothing({ target: [customers.partnerId, customers.phone] })
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

    /**
     * UI redesign M2-5: a customer-portal sign-in proved this phone for ONE tenant row. A single-column
     * `UPDATE customers SET phone_verified_at = COALESCE(phone_verified_at, now()) WHERE partner_id = $1
     * AND phone = $2` (the first proof wins). Never saveCustomer (whole row) and never the phone-only
     * markPhoneVerified. Returns whether the row exists.
     */
    async setPhoneVerifiedIfUnset(partnerId: PartnerId, senderPhone: string): Promise<boolean> {
      const rows = await db
        .update(customers)
        .set({ phoneVerifiedAt: sql`COALESCE(${customers.phoneVerifiedAt}, now())`, updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone))
        .returning({ phone: customers.phone });
      return rows.length > 0;
    },

    /**
     * UI redesign M2-11: the customer portal's email change. A single-column UPDATE of email_enc keyed
     * (partner_id, phone), sealed under customerEmailCtx exactly as registration seals it, so no KYC,
     * consent or MFA column is ever rewritten (never saveCustomer). Returns whether the row exists.
     */
    async setEmail(partnerId: PartnerId, senderPhone: string, email: string): Promise<boolean> {
      const sealed = encryptField(email, provider, customerEmailCtx({ partnerId, senderPhone }));
      const rows = await db
        .update(customers)
        .set({ emailEnc: sealed, updatedAt: new Date() })
        .where(tenantKey(partnerId, senderPhone))
        .returning({ phone: customers.phone });
      return rows.length > 0;
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
     * Fix pack 2 (R06): stamp the sender screening hold — a single-column
     * UPDATE of screening_flagged_at keyed (partner_id, phone), so no other
     * column moves. Called in the Persona apply transaction when a watchlist /
     * PEP report matches. Returns whether a row was updated.
     * Pack 2 review R3 (H1 b): the stamp is never earlier than 1 ms after the
     * clear on the row the UPDATE locks (greatest() reads the latest committed
     * screening_cleared_at), so a match committed after a clear always re-arms
     * the hold, whatever clock `at` came from. GREATEST skips a NULL clear.
     * Pack 2 review round 3 (L1): it is also at least 1 ms after the flag on
     * the locked row, so every committed stamp strictly raises the flag and
     * never moves it back: two matches never share a flag time, and a clear
     * posting an older reviewed time is refused (ScreeningChanged).
     */
    async stampScreeningFlagged(
      partnerId: PartnerId,
      senderPhone: string,
      at: Date,
      kind: 'pep' | 'watchlist',
    ): Promise<boolean> {
      const stamp = sql`greatest(${at.toISOString()}::timestamptz, ${customers.screeningClearedAt} + interval '1 millisecond', ${customers.screeningFlaggedAt} + interval '1 millisecond')`;
      const rows = await db
        .update(customers)
        .set({
          screeningFlaggedAt: stamp,
          // Fix pack 7 (R2, P23 "Stamp kind"): a WATCHLIST match also records its own time, the
          // same greatest(...) value (computed on the pre-update row), so a stale whole-row save
          // that nulls watchlist_hit can never make the sender look PEP-only (senderPepOnly).
          ...(kind === 'watchlist' ? { screeningWatchlistAt: stamp } : {}),
          updatedAt: new Date(),
        })
        .where(tenantKey(partnerId, senderPhone))
        .returning({ phone: customers.phone });
      return rows.length > 0;
    },

    /**
     * Fix pack 8 (R12, P7): THE writer of the verified US state of residence (a
     * single-column UPDATE; saveCustomer / insertCustomerIfAbsent never name the
     * columns). Source precedence: 'partner_attested' writes only when the stored
     * source is NULL or 'partner_attested' (a staff document check is never
     * overwritten by an API attestation); 'staff_verified' always writes. The
     * reserved source 'kyc_vendor' has no writer (D8): it and a non-code state
     * throw TypeError before any statement. Zero rows updated -> one tenant-keyed
     * `SELECT 1` tells 'kept' from 'no_customer'.
     * drizzle update().set().where().returning():
     * node_modules/drizzle-orm/pg-core/query-builders/update.d.ts:157-166.
     */
    async setResidenceState(
      partnerId: PartnerId,
      senderPhone: string,
      w: { state: UsStateCode; source: 'partner_attested' | 'staff_verified'; at: Date },
    ): Promise<'set' | 'kept' | 'no_customer'> {
      if (!isUsStateCode(w.state)) throw new TypeError('setResidenceState: not a US state code');
      if (w.source !== 'partner_attested' && w.source !== 'staff_verified') {
        throw new TypeError('setResidenceState: not a writable residence source');
      }
      if (!(w.at instanceof Date) || !Number.isFinite(w.at.getTime())) {
        throw new TypeError('setResidenceState: invalid time');
      }
      const where =
        w.source === 'partner_attested'
          ? and(
              tenantKey(partnerId, senderPhone),
              or(isNull(customers.residenceStateSource), eq(customers.residenceStateSource, 'partner_attested')),
            )
          : tenantKey(partnerId, senderPhone);
      const rows = await db
        .update(customers)
        .set({ residenceState: w.state, residenceStateSource: w.source, residenceStateAt: w.at, updatedAt: w.at })
        .where(where)
        .returning({ phone: customers.phone });
      if (rows.length > 0) return 'set';
      const exists = await db
        .select({ one: sql<number>`1` })
        .from(customers)
        .where(tenantKey(partnerId, senderPhone))
        .limit(1);
      return exists.length > 0 ? 'kept' : 'no_customer';
    },

    /**
     * Fix pack 2 (R06): the audited platform clear's write — reads the flags
     * FOR UPDATE (the caller re-checks the hold on that locked value and audits
     * it in the same transaction), then sets screening_cleared_at only.
     * A missing row ⇒ { found: false } and nothing written.
     * Pack 2 review R3 (H1 b): the clear time is taken AFTER the FOR UPDATE
     * (`at` only for tests) and is never earlier than 1 ms after the flag it
     * locked, so it lifts exactly that flag; a stamp committed later re-arms
     * (stampScreeningFlagged). A caller that refuses on `previous` throws, and
     * the transaction rollback undoes this write.
     */
    async clearScreeningHold(
      partnerId: PartnerId,
      senderPhone: string,
      at?: Date,
    ): Promise<{ found: boolean; previous: SenderScreeningFlags | null }> {
      const rows = await db
        .select(SCREENING_FLAG_COLUMNS)
        .from(customers)
        .where(tenantKey(partnerId, senderPhone))
        .limit(1)
        .for('update');
      if (!rows[0]) return { found: false, previous: null };
      const clearedAt = at ?? new Date(); // taken after the lock
      await db
        .update(customers)
        .set({
          screeningClearedAt: sql`greatest(${clearedAt.toISOString()}::timestamptz, ${customers.screeningFlaggedAt} + interval '1 millisecond')`,
          updatedAt: new Date(),
        })
        .where(tenantKey(partnerId, senderPhone));
      return { found: true, previous: rows[0] };
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

    /**
     * Fix pack 5 (P20): the set-once writer of the sender's home address
     * (travel-rule originator data), the setFullNameIfUnset pattern on
     * residential_address_enc: one conditional UPDATE keyed (partner_id, phone)
     * that lands only while no address is on file (NULL or ''), sealed under
     * customerRowCtx(row, 'residential_address_enc') as customerToRow seals it.
     * Touches no other column; never replaces a value. Returns whether this call
     * wrote it. The value is never logged.
     */
    async setResidentialAddressIfUnset(partnerId: PartnerId, senderPhone: string, address: string): Promise<boolean> {
      const sealed = sealOptional(
        address,
        provider,
        customerRowCtx({ partnerId, phone: senderPhone }, 'residential_address_enc'),
      );
      if (!sealed) return false;
      const rows = await db
        .update(customers)
        .set({ residentialAddressEnc: sealed, updatedAt: new Date() })
        .where(
          and(
            tenantKey(partnerId, senderPhone),
            or(isNull(customers.residentialAddressEnc), eq(customers.residentialAddressEnc, '')),
          ),
        )
        .returning({ phone: customers.phone });
      return rows.length > 0;
    },

    /**
     * Fix pack 5 (P20): the set-once writer of the sender's date of birth
     * (YYYY-MM-DD, validated by the caller), the same pattern on
     * date_of_birth_enc under customerRowCtx(row, 'date_of_birth_enc'). Returns
     * whether this call wrote it. The value is never logged.
     */
    async setDateOfBirthIfUnset(partnerId: PartnerId, senderPhone: string, dateOfBirth: string): Promise<boolean> {
      const sealed = sealOptional(dateOfBirth, provider, customerRowCtx({ partnerId, phone: senderPhone }, 'date_of_birth_enc'));
      if (!sealed) return false;
      const rows = await db
        .update(customers)
        .set({ dateOfBirthEnc: sealed, updatedAt: new Date() })
        .where(and(tenantKey(partnerId, senderPhone), or(isNull(customers.dateOfBirthEnc), eq(customers.dateOfBirthEnc, ''))))
        .returning({ phone: customers.phone });
      return rows.length > 0;
    },

    /**
     * Fix pack 5 (P20): is the sender's address / date of birth on file? A
     * NULL-and-'' test in SQL on this tenant's row: never decrypts, so a value
     * never enters memory here and is never logged. A missing row -> both false.
     */
    async originatorOnFile(partnerId: PartnerId, senderPhone: string): Promise<{ address: boolean; dateOfBirth: boolean }> {
      const rows = await db
        .select({
          address: sql<boolean>`(${customers.residentialAddressEnc} IS NOT NULL AND ${customers.residentialAddressEnc} <> '')`,
          dateOfBirth: sql<boolean>`(${customers.dateOfBirthEnc} IS NOT NULL AND ${customers.dateOfBirthEnc} <> '')`,
        })
        .from(customers)
        .where(tenantKey(partnerId, senderPhone))
        .limit(1);
      const r = rows[0];
      return { address: r?.address === true, dateOfBirth: r?.dateOfBirth === true };
    },

    /**
     * `at` is WHEN the customer opted out — the inbound STOP passes the STOP's
     * send time, so a later consent change is ordered by send time, not by
     * when we happened to process it. Default: now.
     */
    async setOptedOut(partnerId: PartnerId, senderPhone: string, at: Date = new Date()): Promise<void> {
      await db
        .update(customers)
        .set({ optedOutAt: at, updatedAt: new Date() })
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

/**
 * The customer-level screening flags (kyc-state-machine sets the two booleans
 * from Persona reports) and, fix pack 2 (R06), the times of the last hit seen
 * and of the platform clear (compliance-config.ts senderScreeningHoldActive).
 */
export interface SenderScreeningFlags {
  watchlistHit: boolean | null;
  pepHit: boolean | null;
  screeningFlaggedAt: Date | null;
  screeningClearedAt: Date | null;
  /**
   * Fix pack 7 (R2): the last WATCHLIST stamp (0041), read by readSenderScreeningFlags only
   * (clearScreeningHold's `previous` keeps the four columns above, so it is optional here).
   */
  screeningWatchlistAt?: Date | null;
}

const SCREENING_FLAG_COLUMNS = {
  watchlistHit: customers.watchlistHit,
  pepHit: customers.pepHit,
  screeningFlaggedAt: customers.screeningFlaggedAt,
  screeningClearedAt: customers.screeningClearedAt,
};

/** Fix pack 7 (R2): readSenderScreeningFlags also reads the watchlist stamp (null = read, empty). */
const SENDER_FLAG_COLUMNS = { ...SCREENING_FLAG_COLUMNS, screeningWatchlistAt: customers.screeningWatchlistAt };

/**
 * M3-10 follow-up: the SENDER customer's PEP / watchlist flags for the partner hold release.
 * TENANT-SCOPED by (partner_id, phone), like getCustomer; selects ONLY the two boolean columns and
 * (fix pack 2, R06) the two hold times, and (fix pack 7, R2) the watchlist stamp time: no PII column, no decrypt. null when this tenant has no row
 * for the phone. Throws on a DB error: lib/sender-screening.ts turns that into a fail-closed null;
 * the fix pack 2 mint / pay / sweep callers let it throw (nothing paid). `opts.forUpdate` locks
 * the row (the platform release's in-transaction re-check, settlement.ts).
 */
export async function readSenderScreeningFlags(
  db: DbOrTx,
  partnerId: PartnerId,
  phone: string,
  opts: { forUpdate?: boolean } = {},
): Promise<SenderScreeningFlags | null> {
  const q = db
    .select(SENDER_FLAG_COLUMNS)
    .from(customers)
    .where(and(eq(customers.partnerId, partnerId), eq(customers.phone, phone)))
    .limit(1);
  // Pack 2 review R1 (H2): `forUpdate` (inside a transaction) locks the row, so a
  // concurrent stampScreeningFlagged either committed (seen) or waits for the
  // caller's commit. Drizzle select().for('update'):
  // node_modules/drizzle-orm/pg-core/query-builders/select.d.ts:586.
  const rows = opts.forUpdate ? await q.for('update') : await q;
  return rows[0] ?? null;
}

/**
 * Fix pack 6 (R46, P2): the customer's E-SIGN consent as stored. `version` is ANY version on file
 * (the repo does not know the current one: lib/esign.ts esignConsentNeeded decides).
 */
export interface EsignConsentState {
  version: string | null;
  consentedAt: Date | null;
  withdrawnAt: Date | null;
}

const ESIGN_CONSENT_COLUMNS = {
  version: customers.esignConsentVersion,
  consentedAt: customers.esignConsentedAt,
  withdrawnAt: customers.esignWithdrawnAt,
};

/**
 * The narrow reader: the three consent columns only (no PII, no decrypt), TENANT-SCOPED by the
 * owner key (partner_id, phone). null when this tenant has no row for the phone. Throws on a DB
 * error (callers decide; lib/esign.ts readEsignConsentNeeded treats it as "ask again").
 */
export async function readEsignConsent(
  db: DbOrTx,
  partnerId: PartnerId,
  phone: string,
): Promise<EsignConsentState | null> {
  const rows = await db
    .select(ESIGN_CONSENT_COLUMNS)
    .from(customers)
    .where(and(eq(customers.partnerId, partnerId), eq(customers.phone, phone)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * One of the two ONLY writers of the consent columns: records `version` as given at `at` and
 * clears a withdrawal that is not newer than `at` (a re-consent). A withdrawal stamped AFTER `at`
 * is kept (final check X1: the pay page takes `at` before its evidence transaction opens, so a
 * portal withdrawal can commit in between); esignConsentNeeded then still asks next time, since
 * withdrawn_at >= consented_at counts as withdrawn. true = the row was updated; false = this
 * tenant has no row for the phone (nothing written). drizzle update().set().where().returning({...}):
 * node_modules/drizzle-orm/pg-core/query-builders/update.d.ts:157-166.
 */
export async function recordEsignConsent(
  db: DbOrTx,
  partnerId: PartnerId,
  phone: string,
  version: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(customers)
    .set({
      esignConsentVersion: version,
      esignConsentedAt: at,
      esignWithdrawnAt: sql`CASE WHEN ${customers.esignWithdrawnAt} > ${at.toISOString()}::timestamptz THEN ${customers.esignWithdrawnAt} ELSE NULL END`,
      updatedAt: at,
    })
    .where(and(eq(customers.partnerId, partnerId), eq(customers.phone, phone)))
    .returning({ phone: customers.phone });
  return rows.length > 0;
}

/**
 * The other writer: withdraws a consent that is on file (any version, not already withdrawn
 * after it was given). withdrawn_at = greatest(at, consented_at), so clock skew never leaves a
 * withdrawal that does not count. Returns the version withdrawn, or null when nothing was on file
 * (no row, never consented, already withdrawn): then nothing is written.
 */
export async function withdrawEsignConsent(
  db: DbOrTx,
  partnerId: PartnerId,
  phone: string,
  at: Date,
): Promise<string | null> {
  const rows = await db
    .update(customers)
    .set({
      esignWithdrawnAt: sql`greatest(${at.toISOString()}::timestamptz, ${customers.esignConsentedAt})`,
      updatedAt: at,
    })
    .where(
      and(
        eq(customers.partnerId, partnerId),
        eq(customers.phone, phone),
        isNotNull(customers.esignConsentVersion),
        isNotNull(customers.esignConsentedAt),
        or(isNull(customers.esignWithdrawnAt), lt(customers.esignWithdrawnAt, customers.esignConsentedAt)),
      ),
    )
    .returning({ version: customers.esignConsentVersion });
  return rows[0]?.version ?? null;
}
