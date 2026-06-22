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
    assignedTo: text('assigned_to'),
    adminNote: text('admin_note'),
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
    // Refund queues (ops page + sweeps) — partial: 'none' is ~every row.
    index('transfers_refund_status').on(t.refundStatus).where(sql`${t.refundStatus} <> 'none'`),
  ],
);

export const customers = pgTable(
  'customers',
  {
    phone: text('phone').primaryKey(), // senderPhone
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
    lastFundingMethod: text('last_funding_method'),
    lastFundingMethodAt: timestamp('last_funding_method_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    optInAt: timestamp('opt_in_at', { withTimezone: true }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('customers_partner_created').on(t.partnerId, t.createdAt.desc())],
);

export const partnerIntegrations = pgTable('partner_integrations', {
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
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

// Per-sender saved recipients (the recipients:{phone} Redis hash today). Holds
// full bank accounts → encrypted; the last plaintext account store leaves Redis.
export const recipients = pgTable(
  'recipients',
  {
    senderPhone: text('sender_phone').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    name: text('name').notNull(),
    payoutMethod: text('payout_method').notNull(),
    payoutDestinationEnc: text('payout_destination_enc').notNull(), // ENCRYPTED
    payoutDestinationLast4: text('payout_destination_last4').notNull().default(''),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.senderPhone, t.recipientPhone] })],
);

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
  (t) => [index('audit_partner_at').on(t.partnerId, t.at.desc())],
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
});

// Inbound "Partner with us" leads from the public landing form. A durable record
// (the email notification is a best-effort push on top); platform staff review
// them on /admin-dashboard/partner-requests.
export const partnerRequests = pgTable('partner_requests', {
  id: text('id').primaryKey(),
  companyName: text('company_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  corridors: jsonb('corridors').notNull().default([]), // string[] of country codes
  comments: text('comments'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
});

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
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('outbox_dedupe').on(t.dedupeKey).where(sql`${t.dedupeKey} IS NOT NULL`),
    index('outbox_drain')
      .on(t.status, t.nextAttemptAt)
      .where(sql`${t.status} IN ('pending','failed')`),
  ],
);
