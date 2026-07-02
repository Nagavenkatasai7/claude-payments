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

  // Watchlist or PEP match is a hard hold: once in needs_review from a compliance signal,
  // only another hard-hold event (not a routine inquiry event) can touch the delta.
  // HOLD LOCK: no later NON-watchlist/PEP Persona event may touch it — only a human via
  // kyc-case-store.review() can clear it. Return an empty delta so a clean
  // inquiry.approved/completed delivered out of order cannot silently downgrade the hold.
  const isHardHoldEvent =
    event.watchlistMatched === true ||
    event.name === 'report/watchlist.matched' ||
    event.pepMatched === true ||
    event.name === 'report/pep.matched';

  if (customer.kycReviewState === 'needs_review' && !isHardHoldEvent) {
    return {}; // hold lock: routine events cannot downgrade a compliance hold
  }

  const delta: KycDelta = {};
  if (event.inquiryId) {
    delta.kycInquiryId = event.inquiryId;
    delta.kycProviderRef = event.inquiryId;
  }
  if (event.idLast4) delta.idLast4 = event.idLast4;

  if (isHardHoldEvent) {
    if (event.watchlistMatched === true || event.name === 'report/watchlist.matched') {
      delta.watchlistHit = true;
    }
    if (event.pepMatched === true || event.name === 'report/pep.matched') {
      delta.pepHit = true;
    }
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
