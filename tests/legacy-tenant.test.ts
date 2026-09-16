import { describe, it, expect } from 'vitest';
import { legacyTenantResolver, legacyKeyAllowed } from '@/lib/legacy-tenant';
import type { Customer } from '@/lib/types';

const row = (partnerId: string, createdAt: string) =>
  ({ senderPhone: 'p', partnerId, createdAt, updatedAt: createdAt, firstSeenAt: createdAt, kycStatus: 'not_started', senderCountry: 'US' }) as Customer;

describe('legacy-tenant (fix 1 D9/D10/D12): the pre-fix tenant is the OLDEST row', () => {
  it('resolves the oldest row\'s partner; null when the phone has no row', async () => {
    const resolve = legacyTenantResolver({ findByPhone: async () => [row('default', '2026-01-01T00:00:00Z'), row('acme', '2026-09-20T00:00:00Z')] });
    expect(await resolve('p')).toBe('default');
    expect(await legacyTenantResolver({ findByPhone: async () => [] })('p')).toBeNull();
  });
  it('legacyKeyAllowed is true only for that tenant, and false with no resolver (fail closed)', async () => {
    const resolve = legacyTenantResolver({ findByPhone: async () => [row('default', '2026-01-01T00:00:00Z'), row('acme', '2026-09-20T00:00:00Z')] });
    expect(await legacyKeyAllowed('default', 'p', resolve)).toBe(true);
    expect(await legacyKeyAllowed('acme', 'p', resolve)).toBe(false);
    expect(await legacyKeyAllowed('default', 'p', undefined)).toBe(false);
  });
});
