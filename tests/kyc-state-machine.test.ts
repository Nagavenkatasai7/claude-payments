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

describe('applyKycEvent — monotone rank guard (regression: bug-hunt)', () => {
  it('does NOT regress pending_review → inquiry_started on a late inquiry.started webhook', () => {
    const customer = { ...base, kycReviewState: 'pending_review' } as Customer;
    const lateEvent = ev({ name: 'inquiry.started', status: 'started', createdAt: '2026-06-01T09:00:00Z' });
    const delta = applyKycEvent(customer, lateEvent);
    // kycReviewState must NOT be set — backward move must be suppressed
    expect(delta.kycReviewState).toBeUndefined();
  });

  it('does NOT regress needs_review → inquiry_started on a late inquiry.created webhook', () => {
    const customer = { ...base, kycReviewState: 'needs_review' } as Customer;
    const lateEvent = ev({ name: 'inquiry.created', status: 'created', createdAt: '2026-06-01T08:00:00Z' });
    const delta = applyKycEvent(customer, lateEvent);
    expect(delta.kycReviewState).toBeUndefined();
  });

  it('allows needs_review → pending_review (equal rank 2 — a human still reviews both)', () => {
    // needs_review and pending_review share rank 2 (both await human review),
    // so the rank guard does NOT block this transition (newRank = currentRank = 2).
    // A customer in needs_review who also gets a clean inquiry.approved event stays visible
    // to reviewers — the watchlistHit flag is the actual hold signal, not the state alone.
    const customer = { ...base, kycReviewState: 'needs_review' } as Customer;
    const approvedEvent = ev({ name: 'inquiry.approved', status: 'approved' });
    const delta = applyKycEvent(customer, approvedEvent);
    // Equal rank: allowed (not blocked)
    expect(delta.kycReviewState).toBe('pending_review');
  });

  it('still allows forward transitions: inquiry_started → pending_review', () => {
    const customer = { ...base, kycReviewState: 'inquiry_started' } as Customer;
    const approvedEvent = ev({ name: 'inquiry.approved', status: 'approved' });
    const delta = applyKycEvent(customer, approvedEvent);
    expect(delta.kycReviewState).toBe('pending_review');
  });

  it('still allows forward transitions: inquiry_started → needs_review', () => {
    const customer = { ...base, kycReviewState: 'inquiry_started' } as Customer;
    const failedEvent = ev({ name: 'inquiry.failed', status: 'failed' });
    const delta = applyKycEvent(customer, failedEvent);
    expect(delta.kycReviewState).toBe('needs_review');
  });

  it('still allows watchlist hit from pending_review → needs_review (equal rank, but watchlist path returns early)', () => {
    const customer = { ...base, kycReviewState: 'pending_review' } as Customer;
    const watchlistEvent = ev({ name: 'report/watchlist.matched', status: null, watchlistMatched: true });
    const delta = applyKycEvent(customer, watchlistEvent);
    // The watchlist early-return bypasses the rank guard, so this should still work
    expect(delta.kycReviewState).toBe('needs_review');
    expect(delta.watchlistHit).toBe(true);
  });
});
