export type PayoutMethod = 'upi' | 'bank';

export type FundingMethod = 'credit_card' | 'debit_card' | 'bank_transfer';

export type TransferStatus =
  | 'awaiting_payment'
  | 'paid'
  | 'delivered'
  | 'cancelled'
  | 'blocked';

export type ComplianceStatus = 'cleared' | 'flagged' | 'blocked';

export interface Quote {
  amountUsd: number;
  feeUsd: number;
  totalChargeUsd: number;
  fxRate: number;
  amountInr: number;
  deliveryEstimate: string;
}

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
}

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
  partnerId: PartnerId;   // NEW (P3) — required; multi-tenant boundary
}

export type StaffRole = 'admin' | 'agent';

export interface StaffPermissions {
  canCancel: boolean;
  canResend: boolean;
  canAssign: boolean;
}

export interface Staff {
  username: string;
  name: string;
  role: StaffRole;
  permissions: StaffPermissions;
  passwordHash: string;
  createdAt: string;
  partnerId?: PartnerId;        // NEW (P2) — OPTIONAL: undefined = global admin; set = scoped (P3 enforces)
}

export interface Recipient {
  name: string;
  recipientPhone: string;
  payoutMethod: PayoutMethod;
  payoutDestination: string;
  lastUsedAt: string; // ISO-8601
}

export interface Draft {
  senderPhone: string;
  recipient: {
    name: string;
    recipientPhone: string;
    payoutMethod: PayoutMethod;
    payoutDestination: string;
  };
  amountUsd: number;
  fundingMethod: FundingMethod;
  quote: {
    feeUsd: number;
    fxRate: number;
    amountInr: number;
  };
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

export interface Customer {
  senderPhone: string;
  firstSeenAt: string;
  kycStatus: KycStatus;
  kycVerifiedAt?: string;
  kycProviderRef?: string;
  kycRejectedReason?: string;
  fullName?: string;
  dateOfBirth?: string;
  country?: string;             // legacy KYC-provider free-text — DO NOT use for routing
  senderCountry: CountryCode;   // (P1) the routing field
  partnerId: PartnerId;         // NEW (P2) — required; multi-tenant boundary
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
export type CountryCode =
  | 'US' | 'CA' | 'GB' | 'AE' | 'SG' | 'AU' | 'NZ'  // send-side (Phase 1)
  | 'IN';                                              // payout-side (v1 only)

// ISO 4217 currency codes corresponding to the supported countries.
export type CurrencyCode =
  | 'USD' | 'CAD' | 'GBP' | 'AED' | 'SGD' | 'AUD' | 'NZD'  // send-side
  | 'INR';                                                    // payout-side

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
};

// ── Partner entity (P2) ───────────────────────────────────────────────
//
// `partnerId` introduces the multi-tenant boundary. Every Customer and
// Transfer belongs to a Partner. Staff `partnerId` is optional — undefined
// means global admin (sees all partners' data). P3 will enforce sub-admin
// auth scoping; P2 just establishes the data field.

export type PartnerId = string;  // 'default' or newTransferId() output

export type PartnerStatus = 'active' | 'suspended';

export interface Partner {
  id: PartnerId;
  name: string;                       // staff-facing display name
  countries: CountryCode[];           // which Phase-1 countries this partner operates in
  status: PartnerStatus;
  // Whitelabel placeholders — optional until a real partner needs them.
  brandName?: string;                 // end-customer-facing brand (NOT used in P2; future whitelabel)
  primaryColor?: string;              // hex string e.g. '#1a73e8'
  logoUrl?: string;                   // CDN URL
  adminNote?: string;                 // internal staff annotation
  createdAt: string;
  updatedAt: string;
}
