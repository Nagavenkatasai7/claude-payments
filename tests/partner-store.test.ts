import { describe, it, expect, beforeEach } from 'vitest';
import { createPartnerStore } from '@/lib/partner-store';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';

// freshDb() truncates the shared PGlite and re-seeds the 'default' partner,
// so every test starts with exactly one row: the default.
let db: Db;
let ps: ReturnType<typeof createPartnerStore>;
beforeEach(async () => {
  db = await freshDb();
  ps = createPartnerStore(db);
});

function buildPartner(id: string, overrides: Partial<{ name: string; countries: ('US'|'CA'|'GB'|'AE'|'SG'|'AU'|'NZ'|'IN')[]; status: 'active'|'suspended' }> = {}) {
  const now = '2026-05-27T12:00:00.000Z'; // full-ms ISO — Date round-trip is exact
  return {
    id,
    name: overrides.name ?? 'Test Partner',
    countries: overrides.countries ?? (['US'] as const),
    status: overrides.status ?? ('active' as const),
    kycMode: 'ours' as const, // repo normalizes absent kycMode to 'ours'
    createdAt: now,
    updatedAt: now,
  };
}

describe('partner store', () => {
  it('getPartner returns null when no record', async () => {
    expect(await ps.getPartner('missing')).toBeNull();
  });

  it('savePartner + getPartner round-trips', async () => {
    const p = buildPartner('acme', { name: 'Acme Remit', countries: ['CA'] });
    await ps.savePartner(p);
    expect(await ps.getPartner('acme')).toEqual(p);
  });

  it('listPartners returns every saved partner (plus the seeded default)', async () => {
    await ps.savePartner(buildPartner('a'));
    await ps.savePartner(buildPartner('b'));
    const all = await ps.listPartners();
    expect(all.map((p) => p.id).sort()).toEqual(['a', 'b', 'default']);
  });

  it('listPartners returns [] when no partners exist', async () => {
    await db.execute(`DELETE FROM partners WHERE id = 'default'`);
    expect(await ps.listPartners()).toEqual([]);
  });

  it('ensureDefaultPartner creates the default record when missing', async () => {
    await db.execute(`DELETE FROM partners WHERE id = 'default'`);
    const p = await ps.ensureDefaultPartner();
    expect(p.id).toBe('default');
    expect(p.name).toBe('SmartRemit Default');
    // Any-to-any: the default tenant serves the supported source countries with
    // unambiguous calling codes (CA excluded — shares +1 with the US).
    expect(p.countries).toEqual(['US', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN']);
    expect(p.status).toBe('active');
    expect(await ps.getPartner('default')).toEqual(p);
  });

  it('ensureDefaultPartner is idempotent — second call returns existing record unchanged', async () => {
    const first = await ps.ensureDefaultPartner();
    // Simulate admin renaming the default
    await ps.savePartner({ ...first, name: 'Renamed Default', updatedAt: '2026-05-28T00:00:00.000Z' });
    const second = await ps.ensureDefaultPartner();
    expect(second.name).toBe('Renamed Default');  // NOT overwritten
    expect(second.createdAt).toBe(first.createdAt);
  });

  // The Redis-era "returns null on JSON corruption" test is gone: rows are
  // typed columns on Postgres, so a corrupt-JSON partner blob cannot exist.
});
