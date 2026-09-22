import { describe, it, expect, beforeEach } from 'vitest';
import { PARTNER_TYPES, isPartnerType, partnerTypeLabel, filterByPartnerType } from '@/lib/partner-type';
import { freshDb } from './helpers-db';
import { createPartnerRequestRepo } from '@/db/repos/aux-repos';
import type { Db } from '@/db/client';
import type { PartnerRequest } from '@/lib/types';

// partner-type — the "I am a:" choice: one allow-list shared by the schema
// CHECK, the action, the radio group and the admin filter.

describe('partner-type allow-list', () => {
  it('has exactly the three approved values', () => {
    expect(PARTNER_TYPES.map((t) => t.value)).toEqual(['referral', 'business', 'licensed_mt']);
  });
  it('isPartnerType accepts only those values', () => {
    expect(isPartnerType('referral')).toBe(true);
    expect(isPartnerType('licensed_mt')).toBe(true);
    expect(isPartnerType('')).toBe(false);
    expect(isPartnerType('admin')).toBe(false);
    expect(isPartnerType(undefined)).toBe(false);
  });
  it('partnerTypeLabel renders the label, or a dash for old rows without one', () => {
    expect(partnerTypeLabel('business')).toBe('Business accepting payments');
    expect(partnerTypeLabel(undefined)).toBe('—');
    expect(partnerTypeLabel('bogus')).toBe('—');
  });
});

const req = (id: string, partnerType?: PartnerRequest['partnerType']): PartnerRequest => ({
  id,
  companyName: id,
  email: `${id}@x.co`,
  phone: '15551112222',
  corridors: ['US'],
  capturedAt: '2026-06-20T10:00:00.000Z',
  ...(partnerType ? { partnerType } : {}),
});

describe('filterByPartnerType (the admin ?type= filter)', () => {
  const all = [req('a', 'referral'), req('b', 'business'), req('c'), req('d', 'licensed_mt')];
  it('returns everything when the filter is absent or not an allowed value', () => {
    expect(filterByPartnerType(all, undefined)).toBe(all);
    expect(filterByPartnerType(all, '')).toBe(all);
    expect(filterByPartnerType(all, 'admin')).toBe(all);
  });
  it('keeps only the chosen type', () => {
    expect(filterByPartnerType(all, 'business').map((r) => r.id)).toEqual(['b']);
  });
  it('"none" keeps the legacy rows without an answer', () => {
    expect(filterByPartnerType(all, 'none').map((r) => r.id)).toEqual(['c']);
  });
});

describe('partner-request repo round-trips partner_type', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });
  it('stores and lists the value; legacy rows come back without the field', async () => {
    const repo = createPartnerRequestRepo(db);
    await repo.savePartnerRequest(req('preq_new', 'referral'));
    await repo.savePartnerRequest(req('preq_old'));
    const rows = await repo.listPartnerRequests();
    expect(rows.find((r) => r.id === 'preq_new')!.partnerType).toBe('referral');
    expect(rows.find((r) => r.id === 'preq_old')!.partnerType).toBeUndefined();
  });
});
