import { describe, it, expect } from 'vitest';
import { partnerMayClaimSlug } from '@/lib/partner-slug-policy';

// UI redesign M3-18: a partner claims its slug once; after that only SmartRemit changes it.
describe('partnerMayClaimSlug', () => {
  it('true only when the partner has no slug yet', () => {
    expect(partnerMayClaimSlug(null)).toBe(true);
    expect(partnerMayClaimSlug({ slug: null })).toBe(true);
  });
  it('false once any slug is set', () => {
    expect(partnerMayClaimSlug({ slug: 'acme' })).toBe(false);
  });
  it('an empty-string slug (never valid, but not null) is treated as claimed: fail closed', () => {
    expect(partnerMayClaimSlug({ slug: '' })).toBe(false);
  });
});
