import {
  pgTable,
  text,
  boolean,
  numeric,
  timestamp,
  jsonb,
  integer,
  bigint,
  date,
  index,
  uniqueIndex,
  primaryKey,
  check,
  uuid,
  smallint,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// SmartRemit ledger schema (Stage 1, Postgres/Neon via Drizzle).
//
// Conventions:
//  • text PKs reuse the existing newTransferId() ids — no id-format migration.
//  • Money as numeric(12,2); FX as numeric(14,6). Mappers convert to/from the
//    existing number-based domain types in src/lib/types.ts.
//  • `*_enc` columns hold field-crypto envelope blobs (AES-256-GCM, unchanged
//    format); sibling `*_last4` columns are computed at write time so list and
//    dashboard queries NEVER decrypt.
//  • partner_id is NOT NULL + FK on every tenant-owned table — the relational
//    backbone of cross-tenant isolation (app-level scoping in the repos).
//  • The ledger is FRESH-START: no Redis backfill; migration 0001 seeds only
//    the `default` partner row (mirroring ensureDefaultPartner()).

export const partners = pgTable('partners', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  countries: jsonb('countries').notNull().default([]),
  brandName: text('brand_name'),
  displayName: text('display_name'),
  primaryColor: text('primary_color'),
  logoUrl: text('logo_url'),
  supportContact: text('support_contact'),
  botPersona: text('bot_persona'),
  adminNote: text('admin_note'),
  kycMode: text('kyc_mode').notNull().default('ours'),
  requireKycBeforeSend: boolean('require_kyc_before_send'),
  corridorCompliance: jsonb('corridor_compliance'),
  // Program fix 16 (0018): PartnerSendLimits — tighten-only in fix 16, audited raises in 16b.
  sendLimits: jsonb('send_limits'),
  supportConfig: jsonb('support_config'), // PartnerSupportConfig (absent ⇒ defaults)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const transfers = pgTable(
  'transfers',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    // Best-rate routing (internal): when set, the settlement RAIL is this
    // partner's; branding/WhatsApp/compliance stay partnerId. null ⇒ settle
    // via partnerId (the only behavior before partner_rates existed).
    settlementPartnerId: text('settlement_partner_id').references(() => partners.id),
    phone: text('phone').notNull(),
    status: text('status').notNull(),
    complianceStatus: text('compliance_status').notNull(),
    complianceReasons: jsonb('compliance_reasons').notNull().default([]),
    amountUsd: numeric('amount_usd', { precision: 12, scale: 2 }).notNull(),
    feeUsd: numeric('fee_usd', { precision: 12, scale: 2 }).notNull(),
    totalChargeUsd: numeric('total_charge_usd', { precision: 12, scale: 2 }).notNull(),
    amountSource: numeric('amount_source', { precision: 12, scale: 2 }).notNull(),
    feeSource: numeric('fee_source', { precision: 12, scale: 2 }).notNull(),
    totalChargeSource: numeric('total_charge_source', { precision: 12, scale: 2 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 14, scale: 6 }).notNull(),
    amountDest: numeric('amount_dest', { precision: 14, scale: 2 }).notNull(), // domain: amountInr
    sourceCountry: text('source_country').notNull(),
    sourceCurrency: text('source_currency').notNull(),
    destinationCountry: text('destination_country').notNull(),
    destinationCurrency: text('destination_currency').notNull(),
    recipientName: text('recipient_name').notNull(),
    recipientPhone: text('recipient_phone').notNull().default(''),
    payoutMethod: text('payout_method').notNull(),
    payoutDestinationEnc: text('payout_destination_enc').notNull().default(''), // ENCRYPTED full account
    payoutDestinationLast4: text('payout_destination_last4').notNull().default(''),
    fundingMethod: text('funding_method').notNull(),
    paymentProviderRef: text('payment_provider_ref'),
    // Funds-capture seam: the funding provider's charge reference (write-once,
    // set BEFORE settlement so a crash between capture and settle is
    // recoverable by the reconcile sweep). Refunds live in their own columns —
    // the forward-only `status` machine is untouched.
    fundingRef: text('funding_ref'),
    refundRef: text('refund_ref'),
    refundStatus: text('refund_status').notNull().default('none'),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    recipientLegalNameEnc: text('recipient_legal_name_enc'), // ENCRYPTED
    relationship: text('relationship'),
    purpose: text('purpose'),
    eddRequired: boolean('edd_required'),
    // ── B2B (business-to-business) — every column defaults to the consumer
    // shape so the b2c path is byte-identical. `transfer_type` discriminates;
    // business names are encrypted at rest (masked ****last4) like recipient
    // legal names; `ach_token_ref` is the partner's opaque ACH-pull mandate
    // (SmartRemit never holds funds); `invoice_id` links the mock invoice. ──
    transferType: text('transfer_type').notNull().default('b2c'),
    senderEntityType: text('sender_entity_type').notNull().default('individual'),
    recipientEntityType: text('recipient_entity_type').notNull().default('individual'),
    senderBusinessNameEnc: text('sender_business_name_enc'),
    senderBusinessNameLast4: text('sender_business_name_last4'),
    recipientBusinessNameEnc: text('recipient_business_name_enc'),
    recipientBusinessNameLast4: text('recipient_business_name_last4'),
    achTokenRef: text('ach_token_ref'),
    invoiceId: text('invoice_id'),
    kybReviewNotes: text('kyb_review_notes'),
    assignedTo: text('assigned_to'),
    adminNote: text('admin_note'),
    // Program-Fix 44 P2: 'live' | 'test'. A 'test' row was minted by a sandbox
    // (sr_test_) Partner API key: it never reaches a real rail, never messages a
    // customer, and never counts toward a live customer's caps, velocity or AML
    // aggregates. Write-once (saveTransfer's conflict-update never touches it).
    // A constant DEFAULT is catalog-only on PG11+ (no table rewrite). The union
    // is enforced in code (types.ts TransferEnvironment); no CHECK, so the
    // migration never scans the table.
    environment: text('environment').notNull().default('live'),
    // Program-Fix 14 PR C (0023, B3): the mint's sanctions screening evidence
    // (ScreeningEvidence: list source/version/hash, decision, per-party KEYED
    // input hash + score + list entry id — never a name). INSERT-ONLY: the
    // mint and the quote-time blocked row set it; saveTransfer's
    // conflict-update never touches it, and it is NOT mapped onto the domain
    // Transfer (so it never reaches an API response). NULL = pre-0023 row or
    // an old-build mint (the audit_events 'sanctions.screen' row is the other
    // record).
    screening: jsonb('screening'),
    // Program-Fix 7 (0024): ASYNC sender funds capture through the LICENSED
    // PARTNER's PSP account (Stripe; STRIPE_FUNDING_ENABLED, OFF by default).
    // All NULL on every mock / partner-settled row — the old build never names
    // them. Written only by guarded column-targeted repo updates (never by
    // saveTransfer's conflict-update). funding_state is code-enforced
    // ('pending' | 'succeeded' | 'failed' | 'returned'); no CHECK, so the
    // migration never scans the table. The paid/hold ledger claims require
    // funding_state IS NULL OR 'succeeded' (transfer-repo fundingGate).
    fundingProvider: text('funding_provider'),
    fundingIntentRef: text('funding_intent_ref'),
    fundingState: text('funding_state'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'transfers_status_check',
      sql`${t.status} IN ('awaiting_payment','paid','in_review','delivered','cancelled','blocked')`,
    ),
    check(
      'transfers_refund_status_check',
      sql`${t.refundStatus} IN ('none','requested','pending','completed','failed')`,
    ),
    index('transfers_partner_created').on(t.partnerId, t.createdAt.desc()),
    index('transfers_phone_created').on(t.phone, t.createdAt.desc()),
    index('transfers_status_paid').on(t.status, t.paidAt), // reconciliation sweep
    index('transfers_provider_ref').on(t.paymentProviderRef),
    // Program-Fix 7: the Stripe webhook resolves (partner, intent) → transfer
    // (a dispute carries only payment_intent). Partial: NULL on every other row.
    index('transfers_funding_intent')
      .on(t.partnerId, t.fundingIntentRef)
      .where(sql`${t.fundingIntentRef} IS NOT NULL`),
    // Refund queues (ops page + sweeps) — partial: 'none' is ~every row.
    index('transfers_refund_status').on(t.refundStatus).where(sql`${t.refundStatus} <> 'none'`),
  ],
);

// B2B mock invoices — the "ERP" stand-in for the test case. The bot presents an
// unpaid invoice (Phase 1); the transfer that pays it flips it to 'paid' on
// delivery (Phase 4). Mock data only — no real accounting integration in the MVP.
export const b2bInvoices = pgTable(
  'b2b_invoices',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    businessName: text('business_name').notNull(), // the SELLER business issuing the invoice
    buyerPhone: text('buyer_phone').notNull(), // the buyer's WhatsApp number
    lineItems: jsonb('line_items').notNull().default([]), // {description, qty, unitAmountUsd}[]
    amountUsd: numeric('amount_usd', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('USD'),
    // ── Cross-border B2B (Plan 3) — additive, all NULLABLE ──
    // When set, these carry the cross-border obligation FIXED in
    // invoicedCurrency — the SELLER's currency (Case S, e.g. 1,000 HKD: the
    // seller receives `invoicedAmount` exactly) or the BUYER's currency (Case B,
    // 2026-07-02 spec, e.g. 1,200 MXN: the buyer pays it exactly). The model is
    // DERIVED at pay time (billDenomination()); FX is quoted LIVE at payment,
    // never locked here. A row with these null is a back-compat US-domestic bill
    // driven by amountUsd/currency exactly as before.
    sellerId: text('seller_id').references(() => sellers.id),
    invoicedAmount: numeric('invoiced_amount', { precision: 12, scale: 2 }),
    invoicedCurrency: text('invoiced_currency'),
    status: text('status').notNull().default('unpaid'), // 'unpaid' | 'paid' | 'voided' | 'disputed'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [
    check('b2b_invoices_status_check', sql`${t.status} IN ('unpaid','paid','voided','disputed')`),
    index('b2b_invoices_buyer').on(t.buyerPhone, t.status),
    index('b2b_invoices_partner').on(t.partnerId, t.createdAt.desc()),
  ],
);

// Registered cross-border B2B sellers — a business that issues bills and receives
// payouts in its own currency. The payout destination is envelope-encrypted at rest
// (field-crypto); only the masked last4 is stored in the clear. Partner-scoped.
export const sellers = pgTable(
  'sellers',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    phone: text('phone').notNull(), // digits-only WhatsApp wa_id
    businessName: text('business_name').notNull(),
    country: text('country').notNull(),
    currency: text('currency').notNull(),
    payoutDestinationEnc: text('payout_destination_enc'), // null until onboarding completes
    payoutLast4: text('payout_last4'),
    payoutMethod: text('payout_method').notNull().default('bank'), // 'bank' | 'usdc' — how payouts are delivered
    status: text('status').notNull().default('pending'), // 'pending' | 'active' | 'suspended'
    kycReviewState: text('kyc_review_state').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sellers_status_check', sql`${t.status} IN ('pending','active','suspended')`),
    uniqueIndex('sellers_partner_phone').on(t.partnerId, t.phone),
    index('sellers_partner_created').on(t.partnerId, t.createdAt.desc()),
  ],
);

export const customers = pgTable(
  'customers',
  {
    // Tenant-scoped identity (fix 1 / F44): a phone is NOT a global key. The same
    // number can be a customer of several partners, each with its OWN row (own
    // kyc_status, own encrypted PII, own password). PK (partner_id, phone).
    phone: text('phone').notNull(), // senderPhone
    partnerId: text('partner_id').notNull().references(() => partners.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    senderCountry: text('sender_country').notNull(),
    kycStatus: text('kyc_status').notNull().default('not_started'),
    kycReviewState: text('kyc_review_state'),
    kycInquiryId: text('kyc_inquiry_id'),
    kycProviderRef: text('kyc_provider_ref'),
    kycRejectedReason: text('kyc_rejected_reason'),
    kycVerifiedAt: timestamp('kyc_verified_at', { withTimezone: true }),
    kycSubmittedAt: timestamp('kyc_submitted_at', { withTimezone: true }),
    kycApprovedBy: text('kyc_approved_by'),
    kycApprovedAt: timestamp('kyc_approved_at', { withTimezone: true }),
    kycRejectedAt: timestamp('kyc_rejected_at', { withTimezone: true }),
    fullNameEnc: text('full_name_enc'), // ENCRYPTED
    dateOfBirthEnc: text('date_of_birth_enc'), // ENCRYPTED
    residentialAddressEnc: text('residential_address_enc'), // ENCRYPTED
    emailEnc: text('email_enc'), // ENCRYPTED
    govIdNumberEnc: text('gov_id_number_enc'), // ENCRYPTED
    govIdType: text('gov_id_type'),
    idLast4: text('id_last4'),
    idDocType: text('id_doc_type'),
    nationality: text('nationality'),
    pepDeclared: boolean('pep_declared'),
    watchlistHit: boolean('watchlist_hit'),
    pepHit: boolean('pep_hit'),
    sourceOfFunds: text('source_of_funds'),
    occupation: text('occupation'),
    eddCapturedAt: timestamp('edd_captured_at', { withTimezone: true }),
    // Program fix 16 (0018): SendLimitOverride — declared + read here, written by fix 16b.
    sendLimitOverride: jsonb('send_limit_override'),
    lastFundingMethod: text('last_funding_method'),
    lastFundingMethodAt: timestamp('last_funding_method_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    optInAt: timestamp('opt_in_at', { withTimezone: true }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    // Program-Fix 49D (0020, portal-03): opt-in portal TOTP. The base32 secret
    // is ENCRYPTED (field-crypto, customerRowCtx(row, 'mfa_totp_enc')). Present
    // = enrolled. NEITHER column is in customerToRow: saveCustomer's whole-row
    // upsert never names them, so only customer-repo's single-column MFA
    // writers can set or clear an enrolment.
    mfaTotpEnc: text('mfa_totp_enc'), // ENCRYPTED
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.partnerId, t.phone] }),
    index('customers_partner_created').on(t.partnerId, t.createdAt.desc()),
    // The three legitimate phone-alone lookups (portal login, platform-staff
    // detail page, Persona webhook) go through customer-repo.findByPhone — indexed.
    index('customers_phone').on(t.phone),
  ],
);

export const partnerIntegrations = pgTable(
  'partner_integrations',
  {
    partnerId: text('partner_id').primaryKey().references(() => partners.id),
    kycProviderType: text('kyc_provider_type'),
    kycApiKeyEnc: text('kyc_api_key_enc'),
    kycWebhookSecretEnc: text('kyc_webhook_secret_enc'),
    paymentProviderType: text('payment_provider_type'),
    paymentCredentialsEnc: text('payment_credentials_enc'),
    paymentWebhookSecretEnc: text('payment_webhook_secret_enc'),
    waPhoneNumberId: text('wa_phone_number_id'),
    waTokenEnc: text('wa_token_enc'),
    waVerifyTokenEnc: text('wa_verify_token_enc'),
    waAppSecretEnc: text('wa_app_secret_enc'),
    // Program-Fix 7 (0024): the partner's OWN funds-capture PSP account
    // (PartnerFundingConfig). Selector in the clear; key + endpoint secrets
    // envelope-encrypted like every other integration secret. Read/written
    // only by getFundingConfig / setFundingConfig (never by saveIntegrations).
    fundingProviderType: text('funding_provider_type'),
    fundingCredentialsEnc: text('funding_credentials_enc'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // D11 (fix 1): a WhatsApp phone_number_id routes inbound traffic to ONE
    // tenant, so it may be held by ONE partner. Partial: partners without a
    // BYO number keep NULL. The write-time refusal lives in partners/actions.ts;
    // this index is the last line against a race or a hand-edited row.
    uniqueIndex('partner_integrations_wa_pnid')
      .on(t.waPhoneNumberId)
      .where(sql`${t.waPhoneNumberId} IS NOT NULL`),
  ],
);

// Per-partner conversion pricing per corridor (best-rate selection). A partner
// competes for a corridor when it has a FRESH pushed rate (effective_rate with
// expires_at in the future) or a standing margin_bps off mid-market. Rates are
// not PII — no encryption. One row per (partner, source→dest) corridor.
export const partnerRates = pgTable(
  'partner_rates',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    sourceCurrency: text('source_currency').notNull(),
    destinationCurrency: text('destination_currency').notNull(),
    // Pushed via PUT /api/partner/v1/rates — destination units per 1 source unit.
    effectiveRate: numeric('effective_rate', { precision: 14, scale: 6 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // pushed-rate TTL
    pushedAt: timestamp('pushed_at', { withTimezone: true }),
    // Admin-configured standing improvement over mid-market, in basis points
    // (positive ⇒ better for the customer). Fallback when no fresh push exists.
    marginBps: integer('margin_bps'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('partner_rates_corridor').on(t.partnerId, t.sourceCurrency, t.destinationCurrency),
    index('partner_rates_pair').on(t.sourceCurrency, t.destinationCurrency),
  ],
);

// Support tickets — customer queries ('customer') + employee questions to the
// admins ('internal'), one table discriminated by kind. partner_id NOT NULL is
// the tenant boundary as everywhere; bodies are plaintext (AI triage/copilot
// and queue search need them; create-forms warn against posting account
// numbers, and every transfer join stays masked).
export const tickets = pgTable(
  'tickets',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    kind: text('kind').notNull().default('customer'),
    customerPhone: text('customer_phone').notNull().default(''), // '' for internal
    openedBy: text('opened_by'), // staff username (internal tickets)
    transferId: text('transfer_id').references(() => transfers.id),
    subject: text('subject').notNull(),
    status: text('status').notNull().default('open'),
    priority: text('priority').notNull().default('normal'),
    category: text('category'),
    assignedTo: text('assigned_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    check('tickets_kind_check', sql`${t.kind} IN ('customer','internal')`),
    check(
      'tickets_status_check',
      sql`${t.status} IN ('open','pending','waiting_admin','resolved','closed')`,
    ),
    check('tickets_priority_check', sql`${t.priority} IN ('low','normal','urgent')`),
    index('tickets_partner_status').on(t.partnerId, t.status),
    index('tickets_assigned_updated').on(t.assignedTo, t.updatedAt.desc()),
    index('tickets_customer_partner').on(t.customerPhone, t.partnerId),
    index('tickets_kind_status').on(t.kind, t.status),
  ],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    ticketId: text('ticket_id').notNull().references(() => tickets.id),
    actorType: text('actor_type').notNull(), // 'customer' | 'staff' | 'system'
    actorId: text('actor_id').notNull(),
    body: text('body').notNull(),
    internal: boolean('internal').notNull().default(false), // staff-only note
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ticket_messages_ticket').on(t.ticketId, t.createdAt)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(), // keyId
    partnerId: text('partner_id').notNull().references(() => partners.id),
    keyHash: text('key_hash').notNull(),
    label: text('label'),
    last4: text('last4').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    // Program-Fix 44 P2: an explicit scope set (JSON array of ApiScope). NULL ⇒
    // the key mode's default set, so every existing key keeps its full live
    // scope. Never widens a mode: authenticate() intersects it with the mode's set.
    scopes: jsonb('scopes'),
  },
  (t) => [
    uniqueIndex('api_keys_hash').on(t.keyHash), // O(1) auth lookup
    index('api_keys_partner').on(t.partnerId),
  ],
);

export const schedules = pgTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    phone: text('phone').notNull(),
    amountUsd: numeric('amount_usd', { precision: 12, scale: 2 }).notNull(),
    amountSource: numeric('amount_source', { precision: 12, scale: 2 }).notNull(),
    sourceCurrency: text('source_currency').notNull(),
    recipientName: text('recipient_name').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    payoutMethod: text('payout_method').notNull(),
    payoutDestinationEnc: text('payout_destination_enc').notNull().default(''), // ENCRYPTED
    payoutDestinationLast4: text('payout_destination_last4').notNull().default(''),
    fundingMethod: text('funding_method').notNull(),
    frequency: text('frequency').notNull(),
    dayOfMonth: integer('day_of_month'),
    dayOfWeek: integer('day_of_week'),
    status: text('status').notNull().default('active'),
    endDate: date('end_date'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('schedules_status').on(t.status, t.frequency)],
);

export const beneficiaries = pgTable(
  'beneficiaries',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    name: text('name').notNull(),
    country: text('country').notNull(),
    payoutMethod: text('payout_method').notNull(),
    payoutDestinationEnc: text('payout_destination_enc').notNull(), // ENCRYPTED
    payoutDestinationLast4: text('payout_destination_last4').notNull().default(''),
    recipientPhone: text('recipient_phone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('beneficiaries_partner').on(t.partnerId, t.createdAt.desc())],
);

// Per-sender saved recipients. Holds full bank accounts → encrypted. The
// address book is per (TENANT, sender): partner B can never read or overwrite
// partner A's saved payout destinations for the same phone (fix 1 / F45, F47).
export const recipients = pgTable(
  'recipients',
  {
    partnerId: text('partner_id').notNull().references(() => partners.id),
    senderPhone: text('sender_phone').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    name: text('name').notNull(),
    payoutMethod: text('payout_method').notNull(),
    payoutDestinationEnc: text('payout_destination_enc').notNull(), // ENCRYPTED
    payoutDestinationLast4: text('payout_destination_last4').notNull().default(''),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.partnerId, t.senderPhone, t.recipientPhone] })],
);

// Append-only IN THE DATABASE (Program-Fix 28, drizzle/0019): a BEFORE UPDATE
// OR DELETE row trigger rejects any change to an existing row. Only INSERT.
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: text('partner_id'),
    actor: text('actor').notNull(),
    actorType: text('actor_type').notNull(), // 'staff' | 'api_key' | 'system'
    action: text('action').notNull(),
    subjectId: text('subject_id'),
    meta: jsonb('meta'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_partner_at').on(t.partnerId, t.at.desc()),
    // Program-Fix 28 PR B: the per-subject trails (listKycForSubject,
    // lastSendLimitChange) filter on (partner_id, subject_id).
    index('audit_partner_subject').on(t.partnerId, t.subjectId),
    // Program-Fix 14 PR C (0023): every mint now writes a sanctions.screen row,
    // so the per-subject look-ups by action (the pay-page 'transaction.create'
    // NOT EXISTS, a sanctions look-back) and the system-actor timelines get
    // their own indexes as the table grows.
    index('audit_subject_action').on(t.subjectId, t.action),
    index('audit_actor_type_at').on(t.actorType, t.at.desc()),
  ],
);

// The duplicate-window killer: PK (partner_id, key) makes a replayed create
// structurally unable to mint a second transfer.
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    partnerId: text('partner_id').notNull(),
    key: text('key').notNull(),
    transferId: text('transfer_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.partnerId, t.key] })],
);

export const kycCases = pgTable(
  'kyc_cases',
  {
    id: text('id').primaryKey(),
    partnerId: text('partner_id').notNull(),
    phone: text('phone').notNull(),
    state: text('state').notNull(),
    providerRef: text('provider_ref'),
    notes: jsonb('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('kyc_cases_state').on(t.state, t.updatedAt.desc())],
);

export const corridorRequests = pgTable('corridor_requests', {
  id: text('id').primaryKey(),
  senderPhone: text('sender_phone').notNull(),
  destinationCountry: text('destination_country').notNull(),
  approxAmount: numeric('approx_amount', { precision: 12, scale: 2 }),
  approxCurrency: text('approx_currency'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  // Program-Fix 49D (0020, partner-02): the lead's review state. NULLABLE with
  // no default and no CHECK: NULL means 'open' (every row captured so far);
  // the values are CorridorRequestStatus (src/lib/types.ts).
  status: text('status'),
});

// Inbound "Partner with us" leads from the public landing form. A durable record
// (the email notification is a best-effort push on top); platform staff review
// them on /admin-dashboard/partner-requests.
export const partnerRequests = pgTable(
  'partner_requests',
  {
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    corridors: jsonb('corridors').notNull().default([]), // string[] of country codes
    comments: text('comments'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    // Stage-2 detailed application: an emailed single-use, 30-day capability link.
    // Only the SHA-256 HASH of the URL token is stored (a DB dump leaks nothing
    // usable). status: 'invited' (link sent) → 'completed' (form submitted ⇒ link dead).
    applicationTokenHash: text('application_token_hash'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    applicationStatus: text('application_status').notNull().default('invited'),
    // "I am a:" — referral partner | business accepting payments | licensed money
    // transmitter (src/lib/partner-type.ts). NULLABLE: rows captured before 0017
    // have no answer; the form makes it required at the edge.
    partnerType: text('partner_type'),
  },
  (t) => [
    check('partner_requests_partner_type_check', sql`${t.partnerType} IN ('referral','business','licensed_mt')`),
  ],
);

// Public "Join waitlist" signups (SmartRemit's OWN marketing list — no tenant
// column; platform staff only). PII is envelope-encrypted at rest (`*_enc`,
// field-crypto); dedupe is enforced by KEYED blind indexes (`*_bidx`,
// src/lib/blind-index.ts) — never an unkeyed hash of an email or phone. The
// masked siblings (`name_initial`, `email_masked`, `phone_last4`) are computed
// at write time so the admin list never decrypts; only the audited CSV export
// opens the ciphertext.
export const waitlistSignups = pgTable(
  'waitlist_signups',
  {
    id: text('id').primaryKey(),
    fullNameEnc: text('full_name_enc').notNull(), // ENCRYPTED
    emailEnc: text('email_enc').notNull(), // ENCRYPTED
    phoneEnc: text('phone_enc').notNull(), // ENCRYPTED (E.164)
    locationEnc: text('location_enc').notNull(), // ENCRYPTED (city / state, free text)
    emailBidx: text('email_bidx').notNull(), // HMAC blind index of the normalised email
    phoneBidx: text('phone_bidx').notNull(), // HMAC blind index of the E.164 phone
    nameInitial: text('name_initial').notNull(),
    emailMasked: text('email_masked').notNull(),
    phoneLast4: text('phone_last4').notNull(),
    destinations: jsonb('destinations').notNull().default([]), // string[] of country codes
    consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
    consentTextVersion: text('consent_text_version').notNull(),
    utmSource: text('utm_source'),
    utmCampaign: text('utm_campaign'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('waitlist_signups_email_bidx').on(t.emailBidx),
    uniqueIndex('waitlist_signups_phone_bidx').on(t.phoneBidx),
  ],
);

// The detailed partner application (Stage 2) — one row per submitted application,
// linked to its partner_request. The KYB/compliance/commercial answers live in a
// typed `details` jsonb (the 4 sections); uploaded documents are a jsonb array of
// {label,url,size,contentType}. Fix 24: the urls point at a PRIVATE Vercel Blob
// store (`<store>.private.blob.vercel-storage.com/partner-applications/<requestId>/…`)
// and need the store token on every read, so a url is not a capability; staff
// read them only through the audited route
// admin-dashboard/partner-requests/[id]/documents/[index] (one `partner_doc.view`
// audit row per read). Rows written before fix 24 held public-store urls; the
// owner-run scripts/migrate-partner-docs-private.ts re-issues those.
export const partnerApplications = pgTable(
  'partner_applications',
  {
    id: text('id').primaryKey(),
    partnerRequestId: text('partner_request_id').notNull(),
    details: jsonb('details').notNull().default({}),
    documents: jsonb('documents').notNull().default([]),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('partner_applications_request').on(t.partnerRequestId)],
);

// The durability backbone (Stage 2): every external effect (WhatsApp send,
// settlement instruction, rail callback, mock settle, agent turn, ops alert)
// is written here IN THE SAME TRANSACTION as the state change that implies it,
// then drained by /api/worker with retries → dead-letter → ops alert.
export const outbox = pgTable(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'), // pending|processing|done|failed|dead
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    // Lease (Phase 1 fix 7): a 'processing' row is owned by lease_owner until
    // lease_until; past that, claimBatch may RECLAIM it (the owner died mid-row).
    // markDone/markFailed compare-and-set on lease_owner so a resurrected old
    // worker can never overwrite the new owner's outcome.
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outbox_dedupe').on(t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL`),
    // 'processing' is IN the predicate now: an expired lease must be reachable
    // by the drain query (the old two-state predicate is exactly why a row
    // interrupted by the 60s ceiling was stranded forever — money-03).
    index('outbox_drain')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} IN ('pending','failed','processing')`),
    index('outbox_lease').on(t.leaseUntil).where(sql`${t.status} = 'processing'`),
  ],
);

// ── Program-Fix 14 PR C (0023): the loaded sanctions lists ────────────────────
// One row per DISTINCT published list (source + content hash). The daily loader
// (src/lib/sanctions/list-loader.ts, OFF unless SANCTIONS_LOADER_ENABLED) inserts
// a new version with its entries and flips `active` in ONE transaction; the
// partial unique index keeps at most one active version per source. The
// screener (SANCTIONS_LIST=ofac-sdn) reads only the active version and FAILS
// CLOSED (every transfer to review) when there is none. Public-domain list data
// only — no customer data lives in these tables.
export const sanctionsListVersions = pgTable(
  'sanctions_list_versions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    source: text('source').notNull(),            // 'ofac-sdn'
    version: text('version').notNull(),          // the publish date (YYYY-MM-DD)
    hash: text('hash').notNull(),                // sha256 over the canonical entries
    entryCount: integer('entry_count').notNull(),
    nameCount: integer('name_count').notNull(),
    active: boolean('active').notNull().default(false),
    loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sanctions_list_versions_source_hash').on(t.source, t.hash),
    uniqueIndex('sanctions_list_versions_one_active').on(t.source).where(sql`${t.active}`),
  ],
);

export const sanctionsListEntries = pgTable(
  'sanctions_list_entries',
  {
    versionId: bigint('version_id', { mode: 'number' })
      .notNull()
      .references(() => sanctionsListVersions.id, { onDelete: 'cascade' }),
    entryId: text('entry_id').notNull(),         // 'sdn:<uid>'
    type: text('type').notNull(),                // 'Individual' | 'Entity' | …
    programs: jsonb('programs').notNull(),       // string[]
    names: jsonb('names').notNull(),             // string[]: primary name first, then strong AKAs
    weakNames: jsonb('weak_names').notNull().default([]), // string[]: weak AKAs (review, never block)
  },
  (t) => [primaryKey({ columns: [t.versionId, t.entryId] })],
);

// Program-Fix 45 P5 (crypto-03, migration 0022): the staff ledger. Staff
// records lived only in Redis (auth-store `staff:<username>`, no TTL). During
// the dual-write release auth-store writes BOTH stores and a record exists only
// while its Redis record exists; this row can only RESTRICT it (status, role,
// permissions, partner scope). password_hash is a mirror that is NOT read yet
// (the PG-first flip is a later PR). partner_id NULL = platform staff.
export const staff = pgTable(
  'staff',
  {
    username: text('username').primaryKey(),
    partnerId: text('partner_id').references(() => partners.id),
    name: text('name').notNull(),
    role: text('role').notNull(),
    permissions: jsonb('permissions').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('staff_role_check', sql`${t.role} IN ('admin','agent','support')`),
    check('staff_status_check', sql`${t.status} IN ('active','suspended')`),
    index('staff_partner').on(t.partnerId),
  ],
);

// ── Program-Fix 7 (0024): processed PSP webhook events ────────────────────────
// Idempotency BACKSTOP for the Stripe funding webhook (the guarded ledger
// transitions are the primary guard): one row per (partner, provider, event
// id), inserted in the SAME transaction as the state change it caused, so a
// redelivered event is a no-op (https://docs.stripe.com/webhooks — "Handle
// duplicate events": log processed event ids). Tenant-owned: partner_id FK.
export const fundingEvents = pgTable(
  'funding_events',
  {
    partnerId: text('partner_id').notNull().references(() => partners.id),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    transferId: text('transfer_id'),
    outcome: text('outcome').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.partnerId, t.provider, t.eventId] })],
);

// ── Partner-Demo R3b (0025): the sealed, permanent conversation log ──────────
// One row per customer-visible chat message (customer text in, the reply out).
// Written by the R3b writer (src/db/repos/conversation-log-repo.ts): the
// worker's agent.turn branch (WhatsApp) and web-chat's runTurn (web).
//   • No plaintext phone. thread_key is the raw 32-byte auditSubjectId HMAC
//     (customer-ref.ts), so a thread joins to its pii.view audit rows. That HMAC
//     is keyed by an HKDF of FIELD_ENCRYPTION_KEY (k0): it is stable only
//     because that key is set-once. Retiring k0 would orphan every thread join.
//   • body_enc is a v2 context-bound field-crypto envelope (AES-256-GCM),
//     sealed before INSERT under ctx.conversationMessage (crypto-context.ts):
//     the AAD binds (partner_id, id, hex(thread_key), channel, direction).
//     Metadata (created_at, channel, direction, ciphertext length) is plain.
//   • channel: 1 = WhatsApp, 2 = web. direction: 1 = inbound, 2 = outbound.
//   • id has NO default: the writer supplies it (deterministic for WhatsApp, so
//     worker retries dedupe with INSERT … ON CONFLICT DO NOTHING).
//   • Tenant-owned: partner_id NOT NULL + FK (schema convention above).
// The Redis 30-day chat history is still plaintext; this does not close crypto-06.
// neon-serverless (node-postgres types) returns bytea as a Buffer, PGlite as a
// plain Uint8Array; a text-mode driver would hand back '\\x<hex>'. Normalise
// both directions to a Buffer so equality params and hex encoding are identical.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array | string }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    if (typeof value === 'string') {
      return value.startsWith('\\x') ? Buffer.from(value.slice(2), 'hex') : Buffer.from(value, 'binary');
    }
    return Buffer.from(value);
  },
});

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey(),
    partnerId: text('partner_id').notNull().references(() => partners.id),
    threadKey: bytea('thread_key').notNull(),
    channel: smallint('channel').notNull(),
    direction: smallint('direction').notNull(),
    bodyEnc: text('body_enc').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conversation_messages_thread').on(t.partnerId, t.threadKey, t.createdAt)],
);
