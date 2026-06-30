import { describe, it, expect } from 'vitest';
import { sellers } from '@/db/schema';

describe('sellers table', () => {
  it('exposes the expected columns', () => {
    const cols = Object.keys(sellers);
    for (const c of [
      'id', 'partnerId', 'phone', 'businessName', 'country', 'currency',
      'payoutDestinationEnc', 'payoutLast4', 'status', 'kycReviewState',
      'createdAt', 'updatedAt',
    ]) {
      expect(cols).toContain(c);
    }
  });
});
