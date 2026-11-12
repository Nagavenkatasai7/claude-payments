import { isPartnerReleasableHold, isScreeningCustomerHold, type CustomerScreeningFlags, type LegacyHoldOwner } from '@/lib/compliance-config';
import { partnerDecidesKyc, type ScopeOwner } from '@/lib/partner-decision-scope';
import { senderPepOnly } from '@/lib/hold-queue';
import type { MessageKey } from '@/lib/i18n';
import type { AmlRule } from '@/lib/aml-rules';
import type { Customer, PartnerId } from '@/lib/types';

// partner-reviews (merge plan 2c): the PURE rules behind /partner/reviews and its three decisions.
// Owner decisions D3 (KYC), D4 (reject a hold) and D5 (AML alerts, admin only). Every refusal is a
// bare { ok: false } with no reason, so a caller can never surface WHY (a screening hit and an
// 'ours'-mode partner read the same: nothing is tipped off).

export type KycDecision = 'approve' | 'reject';
export type PartnerKycDecision =
  | { ok: true; slug: `kyc.review.${KycDecision}` | `kyc.manual_override.${KycDecision}`; source: 'persona_review' | 'manual' }
  | { ok: false };

/** The review states that mean "a human must decide" (the KYC queue). */
export function isKycQueueState(s: unknown): boolean {
  return s === 'pending_review' || s === 'needs_review';
}

// Fix pack 7 (P22, T24): a partner that decides KYC (partnerDecidesKyc: certified, posture
// kycDecider 'partner', kycMode 'delegated') records a closed disposition with a flagged decision.
export const KYC_DISPOSITIONS = Object.freeze(['false_positive', 'pep_accepted_with_edd', 'reject'] as const);
export type KycDisposition = (typeof KYC_DISPOSITIONS)[number];

export function isKycDisposition(v: unknown): v is KycDisposition {
  return typeof v === 'string' && (KYC_DISPOSITIONS as readonly string[]).includes(v);
}

/** The closed extra keys a partner KYC decision adds to its audit meta (parsed in partner-kyc-decision.ts). */
export interface KycDecisionExtraMeta { disposition?: KycDisposition; eddDone?: true; eddNote?: string }

/** Who is looking: the caller computes `qualified` with isQualifiedComplianceUser (fresh staff read + MFA). */
export interface PartnerKycViewer { qualified: boolean }

/** The owner fields the KYC rules read (a full Partner, or just { kycMode } in pure tests). */
export type KycOwner = { kycMode?: string | null; id?: string; status?: string; liveControls?: unknown } | null | undefined;

// An object without id / status / liveControls is never certified, so every pack 3 caller keeps today's branch.
function decides(owner: KycOwner): boolean {
  return partnerDecidesKyc(owner as ScopeOwner | null | undefined);
}

/**
 * Fix pack 7 (P22, R2): whose decision is a customer's screening flag, for a partner that decides
 * KYC? 'none' = no active flag; 'pep' = a PEP-only flag the partner decides (senderPepOnly: no
 * watchlist hit and no watchlist stamp newer than the last clear); 'platform' = a watchlist hit,
 * an uncovered watchlist stamp, or a stamp no boolean explains (SmartRemit decides). Fails closed:
 * no flags, or flags whose screeningWatchlistAt was not read (a Customer from getCustomer), read
 * 'platform' while a flag is active. Callers pass flags from readSenderScreeningFlags.
 */
export function partnerKycFlag(c: CustomerScreeningFlags | null | undefined): 'none' | 'pep' | 'platform' {
  if (!c) return 'platform';
  if (c.watchlistHit === true) return 'platform';
  if (!isScreeningCustomerHold(c, { pepClearable: true })) return 'none';
  return senderPepOnly(c) ? 'pep' : 'platform';
}

/**
 * D3, the OFFER: which decision may the page show a partner admin? Only when the owning partner's
 * KYC mode is exactly 'delegated'. A customer in the queue is decided through the Persona-review
 * slug; any other customer through the manual override slug, where a no-op (approve a verified or
 * grandfathered customer, reject a rejected one) is refused so no audit row is written for nothing.
 * For every owner where partnerDecidesKyc is false it NEVER reads the screening flags (or the
 * viewer), so a flagged and an unflagged customer are offered the same controls. Fails closed on a
 * missing owner or customer and on an unknown decision.
 *
 * Fix pack 7 (P22): for a partner that DECIDES KYC the offer needs a qualified compliance viewer
 * (a licensee may see its own PEP flags), and a watchlist or unattributable flag is SmartRemit's
 * (partnerKycFlag 'platform' -> refused); a PEP-only customer is offered (the action then requires
 * a disposition). The flags are read ONLY for such an owner.
 */
export function partnerKycOffer(
  owner: KycOwner,
  customer: (Pick<Customer, 'kycStatus' | 'kycReviewState'> & CustomerScreeningFlags) | null | undefined,
  decision: KycDecision,
  viewer?: PartnerKycViewer,
): PartnerKycDecision {
  const no = { ok: false } as const;
  if (decision !== 'approve' && decision !== 'reject') return no;
  if (decides(owner)) {
    if (viewer?.qualified !== true || partnerKycFlag(customer) === 'platform') return no;
  }
  if (!owner || owner.kycMode !== 'delegated') return no;
  if (!customer) return no;
  if (isKycQueueState(customer.kycReviewState)) return { ok: true, slug: `kyc.review.${decision}`, source: 'persona_review' };
  if (decision === 'approve' && (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered')) return no;
  if (decision === 'reject' && customer.kycStatus === 'rejected') return no;
  return { ok: true, slug: `kyc.manual_override.${decision}`, source: 'manual' };
}

/** The decisions the customer page offers: partnerKycOffer for each. */
export function partnerKycOfferedDecisions(
  owner: KycOwner,
  customer: (Pick<Customer, 'kycStatus' | 'kycReviewState'> & CustomerScreeningFlags) | null | undefined,
  viewer?: PartnerKycViewer,
): KycDecision[] {
  return (['approve', 'reject'] as const).filter((d) => partnerKycOffer(owner, customer, d, viewer).ok);
}

/**
 * D3, the DECISION: may a partner admin record it? The offer above AND no PEP / watchlist hit and
 * no uncleared screening stamp on the customer (isScreeningCustomerHold; the writer re-checks this
 * on the LOCKED row with allowScreeningHold:false). Fix pack 7 (P22): for a partner that decides
 * KYC the offer alone decides (a PEP-only flag is the partner's; the store re-checks it locked).
 */
export function partnerKycDecision(
  owner: KycOwner,
  customer: (Pick<Customer, 'kycStatus' | 'kycReviewState'> & CustomerScreeningFlags) | null | undefined,
  decision: KycDecision,
  viewer?: PartnerKycViewer,
): PartnerKycDecision {
  if (decides(owner)) return partnerKycOffer(owner, customer, decision, viewer);
  if (!customer || isScreeningCustomerHold(customer)) return { ok: false };
  return partnerKycOffer(owner, customer, decision);
}

/**
 * D4: a partner admin may reject (and so refund) ONLY a hold it may release: the same rule as
 * isPartnerReleasableHold (delegated KYC, in_review, not blocked, every reason KYC-class, the
 * sender's customer row present with no PEP / watchlist hit). Sanctions, screening and AML holds
 * stay PLATFORM-only for both outcomes.
 */
export function partnerMayRejectHold(
  t: { status: string; complianceStatus?: string | null; complianceReasons?: readonly string[] | null },
  owner: LegacyHoldOwner | null | undefined,
  sender: CustomerScreeningFlags | null | undefined,
): boolean {
  return isPartnerReleasableHold(t, owner, sender);
}

export interface KycQueueCounts {
  /** Awaiting a human decision: ONE count, never split by why a customer is in the queue. */
  awaiting: number;
}

/** The KYC status tile, over THIS tenant's rows only (another tenant's row is ignored). */
export function kycQueueCounts(
  customers: ReadonlyArray<Pick<Customer, 'partnerId' | 'kycReviewState'>>,
  partnerId: PartnerId,
): KycQueueCounts {
  let awaiting = 0;
  for (const c of customers) {
    if (c.partnerId === partnerId && isKycQueueState(c.kycReviewState)) awaiting += 1;
  }
  return { awaiting };
}

/** D5: the ONLY thing a partner admin sees about an AML rule is one label. A closed map. */
export const AML_RULE_KEYS: Readonly<Record<AmlRule, MessageKey>> = Object.freeze({
  structuring: 'partner.reviews.aml.rule.structuring',
  first_transfer: 'partner.reviews.aml.rule.first_transfer',
  new_beneficiary: 'partner.reviews.aml.rule.new_beneficiary',
  cluster: 'partner.reviews.aml.rule.cluster',
});

export function amlRuleKey(rule: unknown): MessageKey {
  return typeof rule === 'string' && Object.hasOwn(AML_RULE_KEYS, rule)
    ? AML_RULE_KEYS[rule as AmlRule]
    : 'partner.reviews.aml.rule.other';
}

/** Program-Fix 43: the closed list of AML alert outcomes (shared with the legacy compliance action). */
export const AML_DISPOSITIONS = Object.freeze(['no_action', 'escalated'] as const);
export type AmlDisposition = (typeof AML_DISPOSITIONS)[number];

export function isAmlDisposition(v: unknown): v is AmlDisposition {
  return typeof v === 'string' && (AML_DISPOSITIONS as readonly string[]).includes(v);
}

/** An alert id from a form: a positive safe integer of at most 15 digits, else null. */
export function parseAmlAlertId(raw: FormDataEntryValue | null): number | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[1-9]\d{0,14}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}
