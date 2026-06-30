export type PayoutMethod = 'upi' | 'bank';

// 'ach_pull' = B2B: the licensed partner ACH-debits the payer's business bank via
// the signed settlement instruction. SmartRemit never captures funds for this
// method (non-custodial) — see settlement.ts.
export type FundingMethod = 'credit_card' | 'debit_card' | 'bank_transfer' | 'ach_pull';

// B2B discriminators — absent/default ⇒ the consumer shape.
export type EntityType = 'individual' | 'business';

export type TransferStatus =
  | 'awaiting_payment'
  | 'paid'
  | 'in_review'
  | 'delivered'
  | 'cancelled'
  | 'blocked';

export type ComplianceStatus = 'cleared' | 'flagged' | 'blocked';

export interface Quote {
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;                 // source -> destination cross-rate
  amountInr: number;              // amount in the DESTINATION currency (name kept for back-compat; = INR for India sends)
  deliveryEstimate: string;
  sourceCurrency: CurrencyCode;   // NEW (P4)
  amountSource: number;           // NEW (P4)
  feeSource: number;              // NEW (P4)
  totalChargeSource: number;      // NEW (P4)
  destinationCurrency?: CurrencyCode;  // NEW (any-to-any) — currency amountInr/fxRate are in (absent ⇒ INR)
}

export type RefundStatus = 'none' | 'requested' | 'pending' | 'completed' | 'failed';

export interface Transfer {
  id: string;
  phone: string;
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  complianceStatus: ComplianceStatus;
  complianceReasons: string[];
  status: TransferStatus;
  createdAt: string;
  paidAt?: string;
  deliveredAt?: string;
  assignedTo?: string;
  adminNote?: string;
  // NEW (P1) — required after migration
  sourceCountry: CountryCode;
  sourceCurrency: CurrencyCode;
  destinationCountry: CountryCode;
  destinationCurrency: CurrencyCode;
  partnerId: PartnerId;         // NEW (P2) — required; multi-tenant boundary
  // Best-rate routing (internal-only, NEVER customer/partner-API visible):
  // when set, the settlement RAIL is this partner's; branding/WhatsApp/
  // compliance stay partnerId. undefined ⇒ settle via partnerId (default).
  settlementPartnerId?: PartnerId;
  amountSource: number;         // NEW (P4)
  feeSource: number;            // NEW (P4)
  totalChargeSource: number;    // NEW (P4)
  // ── Payment-provider seam (pay-seam) — optional (dormant) ──
  paymentProviderRef?: string;   // partner's settlement id; the mock sets `mock-<transfer.id>`
  // ── Funds-capture seam + refunds ──
  // fundingRef: the funding provider's charge reference, written BEFORE
  // settlement (crash between capture and settle ⇒ reconcile resumes it).
  // Refund lifecycle lives beside the forward-only status machine:
  // none → requested (customer asked via bot) → pending (ops approved /
  // auto on reject-in-review) → completed | failed (failed → pending on retry).
  fundingRef?: string;
  refundRef?: string;            // funding provider's refund transaction id
  refundStatus?: RefundStatus;   // optional (lazy-fill convention): absent ⇒ 'none'
  refundedAt?: string;
  // ── KYC Tier 2 Travel-Rule (per-send) — all optional (dormant) ──
  recipientLegalName?: string;            // legal name distinct from display recipientName
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  // ── KYC Tier 4 EDD snapshot at send time ──
  eddRequired?: boolean;                  // true when this send crossed the $3k cumulative trigger
  // ── B2B (business-to-business) — all optional; absent ⇒ the consumer shape ──
  transferType?: 'b2c' | 'b2b';           // absent ⇒ 'b2c'
  senderEntityType?: EntityType;          // absent ⇒ 'individual'
  recipientEntityType?: EntityType;       // absent ⇒ 'individual'
  senderBusinessName?: string;            // decrypted on explicit reads; masked ****last4 by default
  recipientBusinessName?: string;
  achTokenRef?: string;                   // partner's opaque ACH-pull mandate token (B2B ach_pull)
  invoiceId?: string;                     // the B2bInvoice this transfer pays
  kybReviewNotes?: string;
}

// ── B2B mock invoices (the "ERP" stand-in) ──
export interface InvoiceLineItem {
  description: string;
  qty: number;
  unitAmountUsd: number;
}

export interface B2bInvoice {
  id: string;
  partnerId: PartnerId;
  businessName: string;        // the SELLER business issuing the invoice
  buyerPhone: string;          // the buyer's WhatsApp number
  lineItems: InvoiceLineItem[];
  amountUsd: number;
  currency: CurrencyCode;
  // unpaid → paid (on delivery). voided = staff killed the bill; disputed = buyer
  // rejected it (a support ticket carries the reason). voided/disputed are NOT
  // re-payable; reissue mints a fresh 'unpaid' invoice.
  status: 'unpaid' | 'paid' | 'voided' | 'disputed';
  createdAt: string;           // ISO-8601
  paidAt?: string;
}

// Why a buyer declines a bill (decline/dispute). Closed list; surfaced to staff
// via a support ticket. Kept small + non-accusatory.
export const B2B_DISPUTE_REASONS = ['not_my_bill', 'wrong_amount', 'duplicate', 'already_paid', 'other'] as const;
export type B2bDisputeReason = (typeof B2B_DISPUTE_REASONS)[number];

// ── KYC Travel-Rule (Tier 2) enums — per-send counterparty data ──
export type SenderRecipientRelationship =
  | 'self' | 'spouse' | 'parent' | 'child' | 'sibling'
  | 'other_family' | 'friend' | 'business' | 'other';

export type TransferPurpose =
  | 'family_support' | 'gift' | 'education' | 'medical'
  | 'savings' | 'bills' | 'business' | 'other';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  // OpenAI-compatible APIs return null content when an assistant message
  // carries tool_calls instead of text.
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ScheduleFrequency = 'monthly' | 'weekly';
export type ScheduleStatus = 'active' | 'cancelled';

export interface Schedule {
  id: string;
  phone: string;
  amountUsd: number;
  recipientName: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  fundingMethod: FundingMethod;
  frequency: ScheduleFrequency;
  dayOfMonth?: number;
  dayOfWeek?: number;
  status: ScheduleStatus;
  createdAt: string;
  lastRunAt?: string;
  endDate?: string;               // NEW (QA #7) — ISO-8601 date; absent ⇒ runs until cancelled
  partnerId: PartnerId;   // NEW (P3) — required; multi-tenant boundary
  sourceCurrency: CurrencyCode;   // NEW (P4)
  amountSource: number;           // NEW (P4)
}

// 'support' (NEW): tickets-only staff — answers customer queries, escalates to
// admins. ENFORCED at requireScope (every ops/money page bounces support to the
// ticket queue); nav hiding alone is never the guard.
export type StaffRole = 'admin' | 'agent' | 'support';

// Reversible account state. Absent ⇒ 'active' (no migration; lazy default on read),
// so existing staff records keep working. 'suspended' = access revoked but the record
// (and its audit history) is preserved — mirrors the Partner suspend model.
export type StaffStatus = 'active' | 'suspended';

export interface StaffPermissions {
  canCancel: boolean;
  canResend: boolean;
  canAssign: boolean;
}

// Support staff get no money permissions — hasPermission() must resolve false
// for every money action without special-casing the role at call sites.
export const SUPPORT_DEFAULT_PERMISSIONS: StaffPermissions = {
  canCancel: false,
  canResend: false,
  canAssign: false,
};

export interface Staff {
  username: string;
  name: string;
  role: StaffRole;
  permissions: StaffPermissions;
  passwordHash: string;
  createdAt: string;
  partnerId?: PartnerId;        // NEW (P2) — OPTIONAL: undefined = global admin; set = scoped (P3 enforces)
  status?: StaffStatus;         // NEW (team) — absent ⇒ active; 'suspended' locks out + bounces sessions
  lastLoginAt?: string;         // NEW (team) — ISO-8601; set at login for an "active" signal
}

export interface Recipient {
  name: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  lastUsedAt: string; // ISO-8601
}

// ── Support tickets ─────────────────────────────────────────────────────────
//
// One system serves two flows, discriminated by `kind`:
//  • 'customer' — a customer query (customer_phone set). Customers create/reply
//    from /account/support; support staff + admins answer from the dashboard.
//  • 'internal' — an employee question to the admins (opened_by = staff
//    username, customer_phone ''). Answered from the admin queue.
// Status flow: open → pending (waiting on customer) → resolved → closed
// (terminal); waiting_admin = escalated to an admin. Customers never see
// internal notes (TicketMessage.internal) and see waiting_admin as
// "In progress" — compliance/internal detail never leaks.

export type TicketKind = 'customer' | 'internal';
export type TicketStatus = 'open' | 'pending' | 'waiting_admin' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'urgent';

export interface Ticket {
  id: string;
  partnerId: PartnerId;
  kind: TicketKind;
  customerPhone: string;       // '' for internal tickets
  openedBy?: string;           // staff username (internal tickets)
  transferId?: string;         // optional link to a transfer
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category?: string;           // AI-triage suggestion or staff-set
  assignedTo?: string;         // staff username
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface TicketMessage {
  id: number;
  ticketId: string;
  actorType: 'customer' | 'staff' | 'system';
  actorId: string;             // customer phone or staff username or 'system'
  body: string;
  internal: boolean;           // staff-only note — NEVER returned to customers
  createdAt: string;
}

// Admin-controlled support behavior, stored on the partner row (the same
// opt-in pattern as requireKycBeforeSend). Absent ⇒ defaults.
export interface PartnerSupportConfig {
  enableSupportPortal?: boolean;        // default true — customer /account/support visibility
  autoAssign?: 'none' | 'round_robin';  // default 'none'
}

export interface Draft {
  senderPhone: string;
  recipient: {
    name: string;
    recipientPhone: string;
    // Item 2: bank details are entered by the sender on the secure pay page, not
    // collected in chat. On a cold-start draft payoutDestination is '' (or absent
    // for old in-flight drafts) and is filled at pay time from the POST body.
    // payoutMethod defaults to 'bank'.
    payoutMethod: PayoutMethod;
    payoutDestination?: string;
  };
  amountUsd: number;              // USD-equivalent (for cap re-check)
  amountSource: number;           // NEW (P4)
  sourceCurrency: CurrencyCode;   // NEW (P4)
  destinationCountry?: CountryCode;   // NEW (any-to-any) — absent ⇒ IN
  destinationCurrency?: CurrencyCode; // NEW (any-to-any) — absent ⇒ INR
  fundingMethod: FundingMethod;
  // ── KYC Travel-Rule / EDD (optional; populated only on the EDD path) ──
  recipientLegalName?: string;
  relationship?: SenderRecipientRelationship;
  purpose?: TransferPurpose;
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  quote: {
    feeUsd: number;
    fxRate: number;
    amountInr: number;
    feeSource?: number;
    totalChargeSource?: number;
    totalChargeUsd?: number;
    destinationCurrency?: CurrencyCode; // NEW (any-to-any)
  };
  // Best-rate routing: the partner whose rail settles this draft's transfer
  // when its rate won the corridor at quote time (default-tenant only).
  // Internal — never shown to the customer. Absent ⇒ platform default.
  settlementPartnerId?: PartnerId;
  // ── B2B (business-to-business) — all optional; absent ⇒ the consumer shape.
  // Carried on the draft so the approve-tap mint threads the same discriminators,
  // business names, and linked invoice into createTransfer that the card showed.
  // achTokenRef is NOT set here — U2 binds the ACH-pull mandate token at pay time
  // (non-custodial: the bot never captures funds). For a B2B draft recipient.name
  // is the PAYEE business legal name (so the existing sanctions screen covers it).
  transferType?: 'b2c' | 'b2b';
  senderEntityType?: EntityType;
  recipientEntityType?: EntityType;
  senderBusinessName?: string;
  recipientBusinessName?: string;
  invoiceId?: string;
  createdAt: string; // ISO-8601
}

export type ButtonTap =
  | { kind: 'recipient'; recipientPhone: string }
  | { kind: 'recipient_new' }
  | { kind: 'approve'; draftId: string }
  | { kind: 'cancel'; draftId: string };

export interface TurnContext {
  isNewConversation: boolean;
  buttonTap?: ButtonTap;
  isNewCustomer?: boolean;              // true only on the first inbound from a brand-new phone (never grandfathered)
  tierReminderDayOfWindow?: 1 | 2 | 3;  // T0 + new conversation + not new-customer → which day of the 3-day window
}

export type IncomingMessage =
  | { kind: 'text'; from: string; text: string; messageId: string }
  | { kind: 'button'; from: string; buttonId: string; messageId: string };

export type KycStatus =
  | 'not_started'
  | 'pending'
  | 'verified'
  | 'rejected'
  | 'grandfathered';

/**
 * The KYC *review* case state (Phase 2). SEPARATE from `kycStatus` (which drives
 * tier/cap and is moved to a terminal value ONLY by a human). Persona webhooks
 * move THIS field, never `kycStatus` — that is the human-review-only invariant.
 *   none            — never started (treat undefined as 'none')
 *   inquiry_started — inquiry created, customer in the hosted flow
 *   pending_review  — Persona returned a clean pass; awaiting human approval
 *   needs_review    — Persona declined/failed OR a watchlist/PEP hit → a human must decide
 *   approved        — a human approved (mirrors kycStatus:'verified')
 *   rejected        — a human rejected (mirrors kycStatus:'rejected')
 */
export type KycReviewState =
  | 'none'
  | 'inquiry_started'
  | 'pending_review'
  | 'needs_review'
  | 'approved'
  | 'rejected';

// ── KYC tiered capture: closed-list enums (screenable, friction-free) ──
export type GovIdType = 'passport' | 'drivers_license' | 'national_id' | 'state_id';

export type SourceOfFunds =
  | 'employment' | 'business' | 'investment' | 'gift' | 'savings' | 'other';

export type Occupation =
  | 'salaried' | 'self_employed' | 'business_owner' | 'student'
  | 'homemaker' | 'retired' | 'unemployed' | 'other';

export interface Customer {
  senderPhone: string;
  firstSeenAt: string;
  kycStatus: KycStatus;
  kycVerifiedAt?: string;
  kycProviderRef?: string;
  kycRejectedReason?: string;
  fullName?: string;
  dateOfBirth?: string;
  // ── KYC Tier 1 Core-ID (CIP) — all optional (dormant) ──
  residentialAddress?: string;   // single-line residential address (captured, not validated)
  govIdType?: GovIdType;
  govIdNumber?: string;          // PII — dashboard masks to last 4
  nationality?: CountryCode;     // ISO 3166-1 alpha-2 (typed, unlike legacy `country`)
  // ── KYC Tier 3 Risk ──
  pepDeclared?: boolean;         // self-declared Politically Exposed Person flag
  // ── KYC Tier 4 EDD profile (sticky once captured) ──
  sourceOfFunds?: SourceOfFunds;
  occupation?: Occupation;
  eddCapturedAt?: string;        // ISO — when EDD enums were last supplied
  // ── Sticky funding (Bundle C) — the sender's last-used funding method ──
  lastFundingMethod?: FundingMethod;
  lastFundingMethodAt?: string;   // ISO-8601; powers the 90-day staleness check
  country?: string;             // legacy KYC-provider free-text — DO NOT use for routing
  senderCountry: CountryCode;   // (P1) the routing field
  partnerId: PartnerId;         // NEW (P2) — required; multi-tenant boundary
  // ── WhatsApp consent (Item 4) — both optional/dormant; absence = not-yet-set ──
  optInAt?: string;     // ISO — first transactional inbound (sender initiating = opt-in)
  optedOutAt?: string;  // ISO — set on STOP; cleared (undefined) on START
  // ── Customer onboarding Phase 1 — persistent account auth (all optional, lazy) ──
  email?: string;            // field-crypto ciphertext blob (C2 PII), absent until they register
  passwordHash?: string;     // Argon2id PHC string (the hash itself; not extra-encrypted)
  passwordUpdatedAt?: string;// ISO — set on register / password change
  phoneVerifiedAt?: string;  // ISO — set when the WhatsApp OTP is verified
  // ── Customer onboarding Phase 2 — Persona KYC (data-minimized; raw ID/SSN/images never stored) ──
  kycInquiryId?: string;     // Persona inquiry id (inq_…); also mirrored to kycProviderRef
  kycReviewState?: KycReviewState;
  idLast4?: string;          // last 4 of the verified government ID (display only; full number never stored)
  idDocType?: GovIdType;     // verified document class (mirrors the Persona result)
  watchlistHit?: boolean;    // a Persona watchlist/sanctions report matched → hard hold
  pepHit?: boolean;          // a Persona PEP report matched
  kycSubmittedAt?: string;   // ISO — inquiry created / customer entered the hosted flow
  kycApprovedBy?: string;    // staff username who approved (audit)
  kycApprovedAt?: string;    // ISO
  kycRejectedAt?: string;    // ISO
  createdAt: string;
  updatedAt: string;
}

export type Tier = 'T0' | 'T1' | 'Suspended';

export type CapReason =
  | 'verification_required_after_window'
  | 'verification_rejected'
  | 'over_per_transfer_cap'
  | 'over_daily_cap';

export interface CapEvaluation {
  withinCap: boolean;
  tier: Tier;
  dailyCapCents: number;
  perTransferCapCents: number;
  todayUsedCents: number;
  todayRemainingCents: number;
  reason?: CapReason;
  dayOfWindow?: number;   // 1, 2, or 3 — present only when tier === 'T0'
}

// ── Phase 1 country + currency types (P1) ─────────────────────────────
//
// `country?: string` on Customer (B1) is reserved for free-text KYC-provider
// values (Persona may return "United States" as text). The NEW strictly-typed
// `senderCountry: CountryCode` below is our routing field. Two different
// concerns, two different fields. Routing code never reads `country`.

// ISO 3166-1 alpha-2. Note: UAE = 'AE' (not 'UAE').
// Any-to-any: every code below is valid as BOTH a source and a destination
// (e.g. INR→USD or USD→INR). Don't re-introduce a send-only / payout-only split.
export type CountryCode =
  | 'US' | 'CA' | 'GB' | 'AE' | 'SG' | 'AU' | 'NZ' | 'IN' | 'HK';

// ISO 4217 currency codes corresponding to the supported countries (any-to-any:
// each is usable as source or destination).
export type CurrencyCode =
  | 'USD' | 'CAD' | 'GBP' | 'AED' | 'SGD' | 'AUD' | 'NZD' | 'INR' | 'HKD';

// Single source of truth for "what's the home currency of country X?"
// Consumed by the migration + bot defaults.
export const DEFAULT_CURRENCY_FOR_COUNTRY: Record<CountryCode, CurrencyCode> = {
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AE: 'AED',
  SG: 'SGD',
  AU: 'AUD',
  NZ: 'NZD',
  IN: 'INR',
  HK: 'HKD',
};

// ── Partner entity (P2) ───────────────────────────────────────────────
//
// `partnerId` introduces the multi-tenant boundary. Every Customer and
// Transfer belongs to a Partner. Staff `partnerId` is optional — undefined
// means global admin (sees all partners' data). P3 will enforce sub-admin
// auth scoping; P2 just establishes the data field.

export type PartnerId = string;  // 'default' or newTransferId() output

export type PartnerStatus = 'active' | 'suspended';

// White-label KYC posture (WL1). 'ours' = SmartRemit runs full KYC (the default,
// unchanged behavior). 'delegated' = the partner is the licensed entity and runs
// KYC on their side; our send-gate short-circuits. ⚠️ Sanctions/OFAC screening
// (`screenTransfer`) is NEVER affected by this and runs in BOTH modes.
export type KycMode = 'ours' | 'delegated';

export interface Partner {
  id: PartnerId;
  name: string;                       // staff-facing display name
  countries: CountryCode[];           // which Phase-1 countries this partner operates in
  status: PartnerStatus;
  // Whitelabel branding (WL1) — the end-customer-facing identity. All optional;
  // ABSENCE is what keeps the `default` partner byte-for-byte 'SmartRemit'. The
  // resolver (partner-config.ts) supplies defaults so callers never branch on
  // undefined — never seed these into ensureDefaultPartner().
  brandName?: string;                 // end-customer-facing brand
  displayName?: string;               // preferred end-customer brand (falls back to brandName, then 'SmartRemit')
  primaryColor?: string;              // hex string e.g. '#1a73e8' — null/absent = no override (default CSS)
  logoUrl?: string;                   // CDN URL — absent = no logo override
  supportContact?: string;            // e.g. 'support@acme.com' — surfaced in branded surfaces
  botPersona?: string;                // freeform tone/persona hint appended to the system prompt
  adminNote?: string;                 // internal staff annotation
  // KYC delegation (WL1). Absent ⇒ 'ours' ⇒ full SmartRemit KYC (default flow).
  kycMode?: KycMode;
  requireKycBeforeSend?: boolean;     // only consulted when kycMode==='delegated' (absent ⇒ false = skip our gate)
  corridorCompliance?: Partial<Record<CountryCode, CorridorComplianceRule>>;  // NEW (P5) — optional override map (default partner never gets it)
  supportConfig?: PartnerSupportConfig; // admin-controlled support behavior (absent ⇒ defaults)
  createdAt: string;
  updatedAt: string;
}

// ── Partner best-rate selection (internal pricing) ─────────────────────────
//
// One record per (partner, source→dest currency) corridor. A partner competes
// when it has a FRESH pushed rate (effectiveRate with a future expiresAt) or a
// standing marginBps. Rates are destination units per 1 source unit; marginBps
// is a signed adjustment off mid-market (positive ⇒ better for the customer).
export interface PartnerRate {
  id: string;
  partnerId: PartnerId;
  sourceCurrency: CurrencyCode;
  destinationCurrency: CurrencyCode;
  effectiveRate?: number;  // pushed via PUT /api/partner/v1/rates
  expiresAt?: string;      // ISO-8601; a pushed rate without freshness never competes
  pushedAt?: string;
  marginBps?: number;      // admin-configured fallback when no fresh push
  updatedAt: string;
}

// The outcome of best-rate selection for one quote. source 'platform' ⇒
// today's exact behavior (mid-market, settle via the customer's own partner).
export interface SettlementRoute {
  fxRate: number;                    // destination units per 1 source unit
  source: 'platform' | 'partner';
  settlementPartnerId?: PartnerId;   // set only when source==='partner'
}

// ── Per-corridor compliance (P5) ──────────────────────────────────────
//
// A corridor is a (source-country → IN) pair; destination is always IN in v1,
// so a corridor is identified by its SOURCE CountryCode (the map key). All
// fields optional so an override can tweak a single dimension. This data is
// untrusted at rest (set manually / via a future API) — readers must treat
// its strings/lists defensively (?? '' / ?? [], lowercase/trim before compare).
export interface CorridorComplianceRule {
  watchlistExtra?: string[];   // names appended to the screener's base list (lowercased on read)
  largeAmountUsd?: number;     // USD-equivalent flag threshold; overrides LARGE_AMOUNT_USD
  velocityLimit?: number;      // transfers/day before 'High transfer velocity.'; overrides VELOCITY_LIMIT
  kycCapHintUsd?: number;      // ADVISORY ONLY — hook for the NEXT (KYC) batch; NOT read by screenTransfer in P5
}

// ── Destination-interest lead (non-India payout requests) ─────────────────────
//
// When a user asks to send to a country we don't yet deliver to, the bot
// captures a lightweight lead record so the team can track demand. The word
// "corridor" is INTERNAL and must never appear in any customer-facing chat text.
export interface CorridorRequest {
  id: string;
  senderPhone: string;
  destinationCountry: string;   // free text as the user named it ("UAE", "Pakistan")
  approxAmount?: number;
  approxCurrency?: string;
  capturedAt: string;           // ISO-8601
}

/** An inbound "Partner with us" lead from the public landing form. */
export interface PartnerRequest {
  id: string;
  companyName: string;
  email: string;
  phone: string;
  corridors: string[];          // country codes the partner is interested in
  comments?: string;
  capturedAt: string;           // ISO-8601
  // Stage-2 detailed application (the emailed link → form).
  applicationStatus?: string;   // 'invited' | 'completed'
  tokenExpiresAt?: string;      // ISO-8601 — when the application link expires
}

/** A document uploaded with a partner application (a private Vercel Blob ref). */
export interface PartnerApplicationDocument {
  label: string;
  url: string;
  size: number;
  contentType: string;
}

/**
 * The detailed partner application's four sections. All fields optional strings —
 * the public form enforces the required ones; values are stored verbatim (this is
 * partner business data, not customer PII).
 */
export interface PartnerApplicationDetails {
  // §1 Company & legal entity
  legalName?: string;
  tradingName?: string;
  registrationNumber?: string;
  countryOfIncorporation?: string;
  registeredAddress?: string;
  website?: string;
  yearEstablished?: string;
  ownership?: string;
  // §2 Licensing, regulation & compliance
  isLicensed?: string;
  licenseTypes?: string;
  primaryRegulator?: string;
  otherJurisdictions?: string;
  amlProgram?: string;
  complianceOfficerName?: string;
  complianceOfficerEmail?: string;
  sanctionsApproach?: string;
  lastAuditDate?: string;
  // §3 Operations & settlement
  corridors?: string;
  expectedMonthlyVolumeUsd?: string;
  avgTransferSize?: string;
  currentMonthlyVolume?: string;
  settlementBank?: string;
  settlementCountry?: string;
  settlementCurrencies?: string;
  payoutMethods?: string;
  // §4 Technical & contacts
  integrationPreference?: string;
  whatsappNumber?: string;
  brandName?: string;
  primaryContact?: string;
  complianceContact?: string;
  technicalContact?: string;
  notes?: string;
}

/** A submitted detailed partner application, linked to its partner_request. */
export interface PartnerApplication {
  id: string;
  partnerRequestId: string;
  details: PartnerApplicationDetails;
  documents: PartnerApplicationDocument[];
  submittedAt: string;          // ISO-8601
}
