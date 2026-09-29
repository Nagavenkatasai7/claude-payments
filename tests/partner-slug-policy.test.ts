import { describe, it, expect } from 'vitest';
import { normalizeSlugInput, partnerMayClaimSlug } from '@/lib/partner-slug-policy';

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

describe('normalizeSlugInput', () => {
  it('trims and lowercases printable ASCII (the proxy lowercases the host too)', () => {
    expect(normalizeSlugInput('  Acme-Co ')).toBe('acme-co');
  });
  it('refuses non-strings, oversized input and any non-ASCII character (no Unicode case folding)', () => {
    expect(normalizeSlugInput(null)).toBeNull();
    expect(normalizeSlugInput(new File(['x'], 'x'))).toBeNull();
    expect(normalizeSlugInput('a'.repeat(65))).toBeNull();
    expect(normalizeSlugInput('Kelvin')).toBeNull();
    expect(normalizeSlugInput('acme\u0000')).toBeNull();
  });
});
