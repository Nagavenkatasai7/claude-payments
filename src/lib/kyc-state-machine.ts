import type { Customer, KycReviewState } from './types';
import type { PersonaEvent, PersonaMatchKind } from './providers/persona-webhook-parse';
import { isReportEventName, reportMatchKind } from './providers/persona-webhook-parse';

/**
 * applyKycEvent — pure Persona-event → field delta (Phase 2, Task 6).
 *
 * THE HUMAN-REVIEW-ONLY INVARIANT lives here: this function NEVER sets
 * `kycStatus` (the tier/cap-driving field). It only moves `kycReviewState` and
 * records data-minimized facts (inquiry id, idLast4, watchlist/PEP hit). The
 * only path to `kycStatus:'verified'`/`'rejected'` is a human in
 * `kyc-case-store.review()`. A late/out-of-order Persona event can never
 * override a human terminal decision.
 */

export interface KycDelta {
  kycReviewState?: KycReviewState;
  kycInquiryId?: string;
  kycProviderRef?: string;
  idLast4?: string;
  watchlistHit?: boolean;
  pepHit?: boolean;
  kycSubmittedAt?: string;
}

const HUMAN_TERMINAL: KycReviewState[] = ['approved', 'rejected'];

export function applyKycEvent(
  customer: Customer,
  event: PersonaEvent,
  nowIso: string = new Date().toISOString(),
): KycDelta {
  // Program-Fix 35: any `report/*.matched` (PEP, watchlist, adverse media, …)
  // is a HOLD. Derived purely from the event, before anything else.
  const matchKind: PersonaMatchKind | undefined =
    event.matchKind ??
    reportMatchKind(event.name) ??
    (event.watchlistMatched === true ? 'watchlist' : undefined);
  const isHoldEvent = matchKind !== undefined;
  const flag: KycDelta =
    matchKind === 'pep' ? { pepHit: true } : matchKind === 'watchlist' ? { watchlistHit: true } : {};

  // A human's terminal decision is final — ignore any later NON-match Persona
  // event. A later match on an approved/rejected customer records only its
  // flag (C2 default: flag + ops alert, staff decide); it never moves
  // kycReviewState and never writes the inquiry id.
  if (customer.kycReviewState && HUMAN_TERMINAL.includes(customer.kycReviewState)) {
    return isHoldEvent ? flag : {};
  }

  // HOLD LOCK: once a customer is in needs_review (a watchlist/PEP hold, or a
  // failed inquiry awaiting a human), no later NON-match Persona event may
  // touch it — only a human via kyc-case-store.review() can clear it. Return an
  // empty delta so a clean inquiry.approved/completed delivered out of order
  // cannot silently downgrade (or even partially overwrite) the hold.
  if (customer.kycReviewState === 'needs_review' && !isHoldEvent) {
    return {};
  }

  // A match is a hard hold regardless of inquiry status. It can only ever set
  // needs_review (plus its flag): never approve, never downgrade. A report
  // event never writes kycInquiryId/kycProviderRef (its id is a rep_ id).
  if (isHoldEvent) {
    return { ...flag, kycReviewState: 'needs_review' };
  }

  // Any other report event (.ready/.dismissed/.errored/…) moves nothing: a
  // dismissed match does not clear a hold — a human does.
  if (isReportEventName(event.name) || event.reportId !== undefined) {
    return {};
  }

  const delta: KycDelta = {};
  if (event.inquiryId) {
    delta.kycInquiryId = event.inquiryId;
    delta.kycProviderRef = event.inquiryId;
  }
  if (event.idLast4) delta.idLast4 = event.idLast4;

  switch (event.name) {
    case 'inquiry.created':
    case 'inquiry.started':
      delta.kycReviewState = 'inquiry_started';
      // Program-Fix 48: stamp the submission time only while the customer is at
      // or before inquiry_started. A late started/created after pending_review
      // has its state change dropped by the rank guard below; the timestamp
      // must not leak through on its own.
      if (
        !customer.kycSubmittedAt &&
        (!customer.kycReviewState ||
          customer.kycReviewState === 'none' ||
          customer.kycReviewState === 'inquiry_started')
      ) {
        delta.kycSubmittedAt = nowIso;
      }
      break;
    case 'inquiry.completed':
    case 'inquiry.approved':
      // CLEAN PASS — awaiting a human. NEVER set kycStatus here.
      delta.kycReviewState = 'pending_review';
      break;
    case 'inquiry.declined':
    case 'inquiry.failed':
    case 'inquiry.marked-for-review':
      delta.kycReviewState = 'needs_review';
      break;
    // inquiry.expired / inquiry.transitioned / unknown ⇒ no review-state change
    default:
      break;
  }

  // MONOTONE-RANK GUARD: drop any kycReviewState update that would move the
  // customer BACKWARD — e.g. a late/re-delivered inquiry.started arriving after
  // pending_review must not regress the customer to inquiry_started.
  const STATE_RANK: Record<KycReviewState, number> = {
    none: 0,
    inquiry_started: 1,
    pending_review: 2,
    needs_review: 2, // equal rank: both await a human
    approved: 3,
    rejected: 3,
  };
  if (delta.kycReviewState && customer.kycReviewState) {
    const currentRank = STATE_RANK[customer.kycReviewState] ?? 0;
    const newRank = STATE_RANK[delta.kycReviewState] ?? 0;
    if (newRank < currentRank) {
      delete delta.kycReviewState;
    }
  }

  return delta;
}
