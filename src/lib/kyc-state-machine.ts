import type { Customer, KycReviewState } from './types';
import type { PersonaEvent } from './providers/persona-webhook-parse';

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
  // A human's terminal decision is final — ignore any later Persona event.
  if (customer.kycReviewState && HUMAN_TERMINAL.includes(customer.kycReviewState)) {
    return {};
  }

  const delta: KycDelta = {};
  if (event.inquiryId) {
    delta.kycInquiryId = event.inquiryId;
    delta.kycProviderRef = event.inquiryId;
  }
  if (event.idLast4) delta.idLast4 = event.idLast4;

  // Watchlist/PEP match is a hard hold regardless of inquiry status.
  if (event.watchlistMatched || event.name === 'report/watchlist.matched') {
    delta.watchlistHit = true;
    delta.kycReviewState = 'needs_review';
    return delta;
  }

  switch (event.name) {
    case 'inquiry.created':
    case 'inquiry.started':
      delta.kycReviewState = 'inquiry_started';
      if (!customer.kycSubmittedAt) delta.kycSubmittedAt = nowIso;
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
  return delta;
}
