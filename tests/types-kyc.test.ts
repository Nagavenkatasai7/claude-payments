import { describe, it, expect } from 'vitest';
import type { Customer, KycReviewState } from '@/lib/types';

describe('Phase-2 KYC types', () => {
  it('Customer carries the new Persona review fields', () => {
    const c: Partial<Customer> = {
      kycInquiryId: 'inq_x',
      kycReviewState: 'pending_review',
      idLast4: '1234',
      idDocType: 'passport',
      watchlistHit: false,
      pepHit: false,
      kycSubmittedAt: '2026-06-02T20:00:00Z',
      kycApprovedBy: 'admin',
      kycApprovedAt: '2026-06-02T21:00:00Z',
      kycRejectedAt: undefined,
    };
    expect(c.kycReviewState).toBe('pending_review');
    expect(c.idLast4).toBe('1234');
  });

  it('KycReviewState covers the case states', () => {
    const states: KycReviewState[] = [
      'none',
      'inquiry_started',
      'pending_review',
      'needs_review',
      'approved',
      'rejected',
    ];
    expect(states).toHaveLength(6);
  });
});
