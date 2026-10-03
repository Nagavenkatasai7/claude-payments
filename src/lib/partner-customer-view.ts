import { sealCustomerRef } from '@/lib/customer-ref';
import { maskPhoneLast4 } from '@/lib/mask';
import { deriveTier, observationDay, type CapSubject } from '@/lib/tier-rules';
import type { MessageKey } from '@/lib/i18n';
import type { Customer, KycStatus, Tier } from '@/lib/types';

// partner-customer-view (UI redesign M3-11): the PURE shapes behind /partner/customers. The pages
// render ONLY from these, so what can reach the HTML (or a client component's props) is decided
// here: masked strings and closed-set label keys, never a decrypted identity value, never a
// screening detail (watchlist / PEP flags, a rejection reason). Server-only: it seals refs with
// FIELD_ENCRYPTION_KEY through customer-ref.

export const PARTNER_CUSTOMERS_PAGE_SIZE = 50;

/** The fields a partner may reveal (one audited `pii.reveal` each). Nothing else is revealable. */
export const REVEALABLE_FIELDS = Object.freeze(['full_name', 'date_of_birth', 'residential_address', 'phone'] as const);
export type RevealableField = (typeof REVEALABLE_FIELDS)[number];

export function isRevealableField(f: unknown): f is RevealableField {
  return typeof f === 'string' && (REVEALABLE_FIELDS as readonly string[]).includes(f);
}

const present = (v: string | undefined): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v : undefined);

/** The value behind one allowlisted field (a switch: no dynamic property lookup). */
export function revealableValue(c: Customer, field: RevealableField): string | undefined {
  switch (field) {
    case 'phone':
      return present(c.senderPhone) ? `+${c.senderPhone}` : undefined;
    case 'full_name':
      return present(c.fullName);
    case 'date_of_birth':
      return present(c.dateOfBirth);
    case 'residential_address':
      return present(c.residentialAddress);
    default:
      return undefined;
  }
}

/** Runtime list of the KycStatus union (pinned against types.ts in the test). */
export const KYC_STATUS_VALUES = Object.freeze([
  'not_started',
  'pending',
  'verified',
  'rejected',
  'grandfathered',
] as const satisfies readonly KycStatus[]);
export type ListKycStatus = KycStatus | 'unknown';

const KYC_KEYS: Readonly<Record<KycStatus, MessageKey>> = Object.freeze({
  not_started: 'partner.customers.kyc.not_started',
  pending: 'partner.customers.kyc.pending',
  verified: 'partner.customers.kyc.verified',
  rejected: 'partner.customers.kyc.rejected',
  grandfathered: 'partner.customers.kyc.grandfathered',
});

const closedKyc = (s: unknown): ListKycStatus =>
  typeof s === 'string' && (KYC_STATUS_VALUES as readonly string[]).includes(s) ? (s as KycStatus) : 'unknown';

export function kycStatusKey(s: unknown): MessageKey {
  const k = closedKyc(s);
  return k === 'unknown' ? 'partner.customers.kyc.unknown' : KYC_KEYS[k];
}

// The review state is shown as a generic stage only. A screening-driven "needs review" reads the
// same as any other review: partners never learn why (no tipping off).
const REVIEW_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze({
  none: 'partner.customers.review.none',
  inquiry_started: 'partner.customers.review.inquiry_started',
  pending_review: 'partner.customers.review.in_review',
  needs_review: 'partner.customers.review.in_review',
  approved: 'partner.customers.review.approved',
  rejected: 'partner.customers.review.rejected',
});

export function reviewStateKey(s: unknown): MessageKey {
  if (s === undefined || s === null) return 'partner.customers.review.none';
  return typeof s === 'string' && Object.hasOwn(REVIEW_KEYS, s) ? REVIEW_KEYS[s] : 'partner.customers.review.unknown';
}

const TIER_KEYS: Readonly<Record<string, MessageKey>> = Object.freeze({
  T0: 'partner.customers.tier.T0',
  T1: 'partner.customers.tier.T1',
  Suspended: 'partner.customers.tier.Suspended',
});

export interface TierView {
  tier: Tier;
  key: MessageKey;
  /** 1-3 while the customer is in the T0 observation window, else null. */
  dayOfWindow: number | null;
}

/**
 * The ONE tier label for /partner (customer list and detail, transfer list): deriveTier with the
 * owner's verify-before-send gate (sendGateActive), plus the day of the observation window for T0.
 */
export function tierView(subject: CapSubject, now: Date, kycGateActive: boolean): TierView {
  const tier = deriveTier(subject, now, kycGateActive);
  return {
    tier,
    key: TIER_KEYS[tier] ?? 'partner.customers.tier.unknown',
    dayOfWindow: tier === 'T0' ? Math.max(1, observationDay(subject, now)) : null,
  };
}

/** Initials only ("A. R."): never a whole word of the legal name. */
export function maskInitials(name: string | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  return words.map((w) => `${Array.from(w)[0].toUpperCase()}.`).join(' ');
}

const HIDDEN = '••••'; // ••••

export interface CustomerListRow {
  ref: string;
  phone: string;
  kycStatus: ListKycStatus;
  createdAt: string;
}

/** One list row. No name column (review round 1): the legal name is KYC PII. */
export function customerListRow(c: Customer): CustomerListRow {
  return {
    ref: sealCustomerRef(c.partnerId, c.senderPhone),
    phone: maskPhoneLast4(c.senderPhone),
    kycStatus: closedKyc(c.kycStatus),
    createdAt: c.createdAt,
  };
}

export interface DetailField {
  field: RevealableField;
  labelKey: MessageKey;
  masked: string;
  present: boolean;
}

export interface CustomerDetailView {
  ref: string;
  phone: string;
  fields: DetailField[];
  kycStatusKey: MessageKey;
  reviewKey: MessageKey;
  tierKey: MessageKey;
  kycVerifiedAt: string | null;
  firstSeenAt: string;
}

/** Everything the detail page renders. `ref` is the caller's (already verified) ref. */
export function customerDetailView(c: Customer, ref: string, now: Date, kycGateActive: boolean): CustomerDetailView {
  const f = (field: RevealableField, labelKey: MessageKey, mask: (v: string) => string): DetailField => {
    const v = revealableValue(c, field);
    return { field, labelKey, masked: v === undefined ? '—' : mask(v), present: v !== undefined };
  };
  const phone = maskPhoneLast4(c.senderPhone);
  return {
    ref,
    phone,
    fields: [
      f('phone', 'partner.customers.field.phone', () => phone),
      f('full_name', 'partner.customers.field.full_name', (v) => maskInitials(v)),
      f('date_of_birth', 'partner.customers.field.date_of_birth', () => HIDDEN),
      f('residential_address', 'partner.customers.field.residential_address', () => HIDDEN),
    ],
    kycStatusKey: kycStatusKey(c.kycStatus),
    reviewKey: reviewStateKey(c.kycReviewState),
    tierKey: tierView(c, now, kycGateActive).key,
    kycVerifiedAt: c.kycVerifiedAt ?? null,
    firstSeenAt: c.firstSeenAt,
  };
}

/** One page of the tenant's customers, by created time (the list is already tenant-scoped). */
export function pageCustomers(
  all: readonly Customer[],
  p: { offset: number; limit: number; dir: 'asc' | 'desc' },
): { rows: Customer[]; total: number } {
  const sorted = [...all].sort((a, b) => {
    const d = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.senderPhone < b.senderPhone ? -1 : 1;
    return p.dir === 'asc' ? d : -d;
  });
  return { rows: sorted.slice(p.offset, p.offset + p.limit), total: all.length };
}
