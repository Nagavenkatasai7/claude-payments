import { describe, it, expect } from 'vitest';
import { partnerIdForRequest, partnerRecordFromRequest, REQUEST_SOURCE_COUNTRIES } from '@/lib/partner-from-request';

// UI redesign M3-21: the pure half of "create a partner from an APPROVED partner request".

describe('partnerIdForRequest', () => {
  it('is deterministic per request (the double-submit guard) and distinct across requests', () => {
    expect(partnerIdForRequest('preq_A')).toBe(partnerIdForRequest('preq_A'));
    expect(partnerIdForRequest('preq_A')).not.toBe(partnerIdForRequest('preq_B'));
  });
  it('has the shape of a wizard partner id (22 base64url chars, never starting with _ or -)', () => {
    for (let i = 0; i < 300; i++) {
      const id = partnerIdForRequest(`preq_${i}`);
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{21}$/);
    }
  });
  it('never equals the request id itself, nor the platform tenant', () => {
    expect(partnerIdForRequest('preq_A')).not.toBe('preq_A');
    expect(partnerIdForRequest('default')).not.toBe('default');
  });
});

describe('partnerRecordFromRequest', () => {
  const now = '2026-09-29T12:00:00.000Z';
  it('uses the wizard defaults: active, our KYC, no send gate, no branding; name + source countries from the lead', () => {
    const p = partnerRecordFromRequest({ companyName: '  Acme Remit  ', corridors: ['CA', 'IN', 'Other', 'GB'] }, 'pid', now);
    expect(p).toEqual({
      id: 'pid',
      name: 'Acme Remit',
      countries: ['CA', 'GB'],
      status: 'active',
      kycMode: 'ours',
      requireKycBeforeSend: false,
      createdAt: now,
      updatedAt: now,
    });
  });
  it('falls back to US when the lead lists no source country (the wizard default)', () => {
    expect(partnerRecordFromRequest({ companyName: 'Acme', corridors: ['IN'] }, 'pid', now).countries).toEqual(['US']);
  });
  it('bounds the name like the wizard prefill', () => {
    expect(partnerRecordFromRequest({ companyName: 'x'.repeat(300), corridors: [] }, 'pid', now).name).toHaveLength(120);
  });
  it('the source countries are the wizard list', () => {
    expect([...REQUEST_SOURCE_COUNTRIES]).toEqual(['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ']);
  });
});
