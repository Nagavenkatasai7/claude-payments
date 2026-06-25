import { describe, it, expect } from 'vitest';
import { applyKycEvent } from '@/lib/kyc-state-machine';
import type { Customer } from '@/lib/types';
import type { PersonaEvent } from '@/lib/providers/persona-webhook-parse';

const base: Customer = {
  senderPhone: '15551230000',
  firstSeenAt: '2026-06-01T00:00:00Z',
  kycStatus: 'pending',
  senderCountry: 'US',
  partnerId: 'default',
  createdAt: '',
  updatedAt: '',
} as Customer;

const ev = (over: Partial<PersonaEvent>): PersonaEvent => ({
  eventId: 'e',
  name: 'inquiry.completed',
  createdAt: '2026-06-02T20:00:00Z',
  inquiryId: 'inq_1',
  referenceId: base.senderPhone,
  status: 'completed',
  ...over,
});

describe('applyKycEvent (human-review-only)', () => {
  it('a clean completed/approved inquiry → pending_review, NEVER verified', () => {
    const d = applyKycEvent(base, ev({ name: 'inquiry.approved', status: 'approved', idLast4: '6789' }));
    expect(d.kycReviewState).toBe('pending_review');
    expect(d.idLast4).toBe('6789');
    expect(d.kycInquiryId).toBe('inq_1');
    expect('kycStatus' in d).toBe(false); // tier-driving field is NEVER touched here
  });

  it('a declined/failed inquiry → needs_review (a human decides; not auto-rejected)', () => {
    expect(applyKycEvent(base, ev({ name: 'inquiry.declined', status: 'declined' })).kycReviewState).toBe('needs_review');
    expect(applyKycEvent(base, ev({ name: 'inquiry.failed', status: 'failed' })).kycReviewState).toBe('needs_review');
    expect('kycStatus' in applyKycEvent(base, ev({ name: 'inquiry.failed' }))).toBe(false);
  });

  it('a watchlist match → needs_review + watchlistHit (hard stop for a human)', () => {
    const d = applyKycEvent(base, ev({ name: 'report/watchlist.matched', status: null, watchlistMatched: true }));
    expect(d.kycReviewState).toBe('needs_review');
    expect(d.watchlistHit).toBe(true);
  });

  it('inquiry.created/started → inquiry_started + kycSubmittedAt (once)', () => {
    const d = applyKycEvent(base, ev({ name: 'inquiry.created', status: 'created' }), '2026-06-02T19:00:00Z');
    expect(d.kycReviewState).toBe('inquiry_started');
    expect(d.kycSubmittedAt).toBe('2026-06-02T19:00:00Z');
  });

  it('does NOT re-stamp kycSubmittedAt if already set', () => {
    const seeded = { ...base, kycSubmittedAt: '2026-06-01T00:00:00Z' } as Customer;
    const d = applyKycEvent(seeded, ev({ name: 'inquiry.started', status: 'started' }));
    expect(d.kycSubmittedAt).toBeUndefined();
    expect(d.kycReviewState).toBe('inquiry_started');
  });

  it('does NOT downgrade an already human-approved customer on a late event', () => {
    const approved = { ...base, kycStatus: 'verified', kycReviewState: 'approved' } as Customer;
    const d = applyKycEvent(approved, ev({ name: 'inquiry.completed', status: 'completed' }));
    expect(d).toEqual({}); // no change — human terminal decision wins
  });

  it('ignores unknown/no-op events (expired, transitioned) for state', () => {
    const d = applyKycEvent(base, ev({ name: 'inquiry.transitioned', status: 'completed' }));
    expect(d.kycReviewState).toBeUndefined();
  });
});

// ── Regression: bug-hunt fix #4 ─────────────────────────────────────────────
describe('applyKycEvent — watchlist hard-hold cannot be overwritten by a later webhook', () => {
  // Before the fix: a watchlist event sets kycReviewState='needs_review', but a
  // subsequent inquiry.approved webhook would move the customer to 'pending_review',
  // silently clearing the watchlist hold.

  it('inquiry.approved after watchlist.matched keeps needs_review (hard hold)', () => {
    // Step 1: apply watchlist event to a fresh customer
    const afterWatchlist = { ...base, kycReviewState: 'needs_review' as const, watchlistHit: true };
    // Step 2: a late/redelivered inquiry.approved arrives — must be ignored
    const d = applyKycEvent(afterWatchlist, ev({ name: 'inquiry.approved', status: 'approved' }));
    expect(d.kycReviewState).toBeUndefined(); // state must NOT advance
    // The returned delta must not contain kycReviewState at all (or must be {})
    expect('kycReviewState' in d && d.kycReviewState !== undefined).toBe(false);
  });

  it('inquiry.completed after watchlist.matched keeps needs_review', () => {
    const afterWatchlist = { ...base, kycReviewState: 'needs_review' as const, watchlistHit: true };
    const d = applyKycEvent(afterWatchlist, ev({ name: 'inquiry.completed', status: 'completed' }));
    expect(d.kycReviewState).toBeUndefined();
  });

  it('inquiry.declined after watchlist.matched keeps needs_review (already there; no change needed)', () => {
    const afterWatchlist = { ...base, kycReviewState: 'needs_review' as const, watchlistHit: true };
    const d = applyKycEvent(afterWatchlist, ev({ name: 'inquiry.declined', status: 'declined' }));
    // Either {} or kycReviewState='needs_review' is acceptable — the key is it does NOT
    // move to a different state.
    if (d.kycReviewState !== undefined) {
      expect(d.kycReviewState).toBe('needs_review');
    }
  });

  it('human-approved watchlist customer is still terminal (human terminal guard fires first)', () => {
    // If a human has approved despite watchlistHit, that human decision wins.
    const humanApproved = { ...base, kycReviewState: 'approved' as const, watchlistHit: true };
    const d = applyKycEvent(humanApproved, ev({ name: 'inquiry.approved', status: 'approved' }));
    expect(d).toEqual({}); // HUMAN_TERMINAL guard fires first
  });
});
