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

  // Regression: PEP events were silently ignored — neither pepHit nor needs_review was set.
  it('a PEP match sets pepHit + needs_review (regression: was silently discarded)', () => {
    const customer = { ...base, kycReviewState: 'inquiry_started' } as Customer;
    const pepEvent = ev({ name: 'report/pep.matched', status: null, watchlistMatched: undefined });
    const d = applyKycEvent(customer, pepEvent);
    expect(d.pepHit).toBe(true);
    expect(d.kycReviewState).toBe('needs_review');
    // inquiryId in the event is still recorded for traceability
    expect(d.kycInquiryId).toBe('inq_1');
    expect(d.kycProviderRef).toBe('inq_1');
    expect('kycStatus' in d).toBe(false); // NEVER touch tier-driving field
  });

  it('a PEP match from the null state (fresh customer) also sets pepHit + needs_review', () => {
    const d = applyKycEvent(base, ev({ name: 'report/pep.matched', status: null }));
    expect(d.pepHit).toBe(true);
    expect(d.kycReviewState).toBe('needs_review');
    expect(d.watchlistHit).toBeUndefined();
  });

  it('a PEP match does NOT set watchlistHit (separate flag from watchlist events)', () => {
    const d = applyKycEvent(base, ev({ name: 'report/pep.matched', status: null }));
    expect(d.watchlistHit).toBeUndefined();
    expect(d.pepHit).toBe(true);
  });

  // HOLD LOCK: needs_review must be sealed against non-hard-hold events.
  it('needs_review is not downgraded by a subsequent inquiry.approved (HOLD LOCK)', () => {
    const customer = { ...base, kycReviewState: 'needs_review' } as Customer;
    const d = applyKycEvent(customer, ev({ name: 'inquiry.approved', status: 'approved' }));
    expect(d).toEqual({}); // sealed — inquiry.approved must not move needs_review to pending_review
  });

  it('needs_review allows a second hard-hold event (watchlist after PEP)', () => {
    const customer = { ...base, kycReviewState: 'needs_review' } as Customer;
    const wlEvent = ev({ name: 'report/watchlist.matched', status: null, watchlistMatched: true });
    const d = applyKycEvent(customer, wlEvent);
    expect(d.watchlistHit).toBe(true);
    expect(d.kycReviewState).toBe('needs_review');
  });
});
