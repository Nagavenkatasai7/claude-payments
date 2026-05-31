import { describe, it, expect } from 'vitest';
import { createPartnerStore } from '@/lib/partner-store';
import { fakeRedis } from './helpers';

const DEFAULT_ID = 'default';

function buildPartner(id: string, overrides: Partial<{ name: string; countries: ('US'|'CA'|'GB'|'AE'|'SG'|'AU'|'NZ'|'IN')[]; status: 'active'|'suspended' }> = {}) {
  const now = '2026-05-27T12:00:00Z';
  return {
    id,
    name: overrides.name ?? 'Test Partner',
    countries: overrides.countries ?? (['US'] as const),
    status: overrides.status ?? ('active' as const),
    createdAt: now,
    updatedAt: now,
  };
}

describe('partner store', () => {
  it('getPartner returns null when no record', async () => {
    const ps = createPartnerStore(fakeRedis());
    expect(await ps.getPartner(DEFAULT_ID)).toBeNull();
  });

  it('savePartner + getPartner round-trips', async () => {
    const ps = createPartnerStore(fakeRedis());
    const p = buildPartner('acme', { name: 'Acme Remit', countries: ['CA'] });
    await ps.savePartner(p);
    expect(await ps.getPartner('acme')).toEqual(p);
  });

  it('listPartners returns every saved partner', async () => {
    const ps = createPartnerStore(fakeRedis());
    await ps.savePartner(buildPartner('a'));
    await ps.savePartner(buildPartner('b'));
    const all = await ps.listPartners();
    expect(all.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('listPartners returns [] when no partners exist', async () => {
    expect(await createPartnerStore(fakeRedis()).listPartners()).toEqual([]);
  });

  it('ensureDefaultPartner creates the default record when missing', async () => {
    const ps = createPartnerStore(fakeRedis());
    const p = await ps.ensureDefaultPartner();
    expect(p.id).toBe('default');
    expect(p.name).toBe('SmartRemit Default');
    expect(p.countries).toEqual(['US']);
    expect(p.status).toBe('active');
    expect(await ps.getPartner('default')).toEqual(p);
  });

  it('ensureDefaultPartner is idempotent — second call returns existing record unchanged', async () => {
    const ps = createPartnerStore(fakeRedis());
    const first = await ps.ensureDefaultPartner();
    // Simulate admin renaming the default
    await ps.savePartner({ ...first, name: 'Renamed Default', updatedAt: '2026-05-28T00:00:00Z' });
    const second = await ps.ensureDefaultPartner();
    expect(second.name).toBe('Renamed Default');  // NOT overwritten
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('returns null on JSON corruption rather than throwing', async () => {
    const redis = fakeRedis();
    await redis.set('partner:bad', 'not-json');
    const ps = createPartnerStore(redis);
    expect(await ps.getPartner('bad')).toBeNull();
  });
});
