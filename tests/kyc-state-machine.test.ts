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

describe('applyKycEvent — watchlistHit freeze guard (regression)', () => {
  // Bug: a customer with watchlistHit:true and kycReviewState:'needs_review' could
  // be silently advanced to 'pending_review' by a subsequent inquiry.approved Persona
  // webhook. The HUMAN_TERMINAL guard only covered ['approved','rejected'], not the
  // watchlist-triggered needs_review state.
  const watchlisted: Customer = {
    ...base,
    kycReviewState: 'needs_review',
    watchlistHit: true,
  } as Customer;

  const pepFlagged: Customer = {
    ...base,
    kycReviewState: 'needs_review',
    pepHit: true,
  } as Customer;

  it('inquiry.approved does NOT advance a watchlistHit customer out of needs_review', () => {
    const d = applyKycEvent(watchlisted, ev({ name: 'inquiry.approved', status: 'approved' }));
    expect(d).toEqual({});
  });

  it('inquiry.completed does NOT advance a watchlistHit customer', () => {
    const d = applyKycEvent(watchlisted, ev({ name: 'inquiry.completed', status: 'completed' }));
    expect(d).toEqual({});
  });

  it('inquiry.created does NOT advance a watchlistHit customer', () => {
    const d = applyKycEvent(watchlisted, ev({ name: 'inquiry.created', status: 'created' }));
    expect(d).toEqual({});
  });

  it('inquiry.started does NOT advance a watchlistHit customer', () => {
    const d = applyKycEvent(watchlisted, ev({ name: 'inquiry.started', status: 'started' }));
    expect(d).toEqual({});
  });

  it('pepHit also freezes the customer (same hard-hold logic)', () => {
    const d = applyKycEvent(pepFlagged, ev({ name: 'inquiry.approved', status: 'approved' }));
    expect(d).toEqual({});
  });

  it('a clean customer with no watchlistHit still advances normally', () => {
    const d = applyKycEvent(base, ev({ name: 'inquiry.approved', status: 'approved' }));
    expect(d.kycReviewState).toBe('pending_review');
  });
});
