import { describe, it, expect } from 'vitest';
import { freshManualCustomer, parseManualCustomer } from '@/lib/partner-customer-create';

// Lost-features p2 A5: a partner admin creates a customer by hand. Pure parsing: the phone, the
// country (one of the partner's), an optional legal name, and the KYC status (not started; verified
// only in delegated KYC mode and with a reason). Grandfathered is never offered to partners.
const ours = { countries: ['US', 'GB'] as const, kycMode: 'ours' as const };
const delegated = { countries: ['US', 'GB'] as const, kycMode: 'delegated' as const };
const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

describe('parseManualCustomer', () => {
  it('a minimal not-started customer; the country falls back to the phone’s when the partner serves it', () => {
    expect(parseManualCustomer(form({ phone: '+1 (555) 123-4567' }), ours)).toEqual({
      ok: true,
      phone: '15551234567',
      senderCountry: 'US',
      kycStatus: 'not_started',
    });
    expect(parseManualCustomer(form({ phone: '447911123456', country: 'GB', fullName: '  Asha  Rao ' }), ours)).toEqual({
      ok: true,
      phone: '447911123456',
      senderCountry: 'GB',
      fullName: 'Asha Rao',
      kycStatus: 'not_started',
    });
  });
  it('phone bounds', () => {
    for (const p of ['', '12345', '1234567890123456', 'abc']) {
      expect(parseManualCustomer(form({ phone: p }), ours), p).toEqual({ ok: false, errorKey: 'partner.customers.create.invalidPhone' });
    }
  });
  it('the country must be one of the partner’s (posted or derived)', () => {
    expect(parseManualCustomer(form({ phone: '15551234567', country: 'IN' }), ours)).toEqual({ ok: false, errorKey: 'partner.customers.create.invalidCountry' });
    expect(parseManualCustomer(form({ phone: '919876543210' }), ours)).toEqual({ ok: false, errorKey: 'partner.customers.create.invalidCountry' });
    expect(parseManualCustomer(form({ phone: '15551234567', country: 'us' }), ours)).toEqual({ ok: false, errorKey: 'partner.customers.create.invalidCountry' });
  });
  it('a long or phone-shaped name is refused', () => {
    expect(parseManualCustomer(form({ phone: '15551234567', fullName: 'x'.repeat(121) }), ours)).toEqual({ ok: false, errorKey: 'partner.customers.create.invalidName' });
    expect(parseManualCustomer(form({ phone: '15551234567', fullName: 'Call 555 123 4567 89' }), ours)).toEqual({ ok: false, errorKey: 'partner.customers.create.invalidName' });
  });
  it('verified: refused in ours mode; in delegated mode it needs a reason of 10+ characters with no long number', () => {
    expect(parseManualCustomer(form({ phone: '15551234567', kycStatus: 'verified', reason: 'Checked passport in branch' }), ours)).toEqual({
      ok: false,
      errorKey: 'partner.customers.create.verifiedNotAllowed',
    });
    expect(parseManualCustomer(form({ phone: '15551234567', kycStatus: 'verified' }), delegated)).toEqual({ ok: false, errorKey: 'partner.customers.create.reasonTooShort' });
    expect(parseManualCustomer(form({ phone: '15551234567', kycStatus: 'verified', reason: 'short' }), delegated)).toEqual({ ok: false, errorKey: 'partner.customers.create.reasonTooShort' });
    expect(parseManualCustomer(form({ phone: '15551234567', kycStatus: 'verified', reason: 'ID card 1234567890 seen' }), delegated)).toEqual({
      ok: false,
      errorKey: 'partner.customers.create.reasonHasNumber',
    });
    expect(parseManualCustomer(form({ phone: '15551234567', kycStatus: 'verified', reason: 'Checked passport in branch' }), delegated)).toEqual({
      ok: true,
      phone: '15551234567',
      senderCountry: 'US',
      kycStatus: 'verified',
      reason: 'Checked passport in branch',
    });
  });
  it('grandfathered, rejected, pending and junk statuses are refused', () => {
    for (const s of ['grandfathered', 'rejected', 'pending', 'nope', '__proto__']) {
      expect(parseManualCustomer(form({ phone: '15551234567', kycStatus: s, reason: 'A long enough reason' }), delegated), s).toEqual({
        ok: false,
        errorKey: 'partner.customers.create.invalidStatus',
      });
    }
  });
});

describe('freshManualCustomer', () => {
  const now = '2026-10-01T12:00:00.000Z';
  it('builds the row: no consent implied, tenant from the caller; verified carries the approval stamps', () => {
    const p = parseManualCustomer(form({ phone: '15551234567', fullName: 'Asha Rao' }), ours);
    if (!p.ok) throw new Error('parse');
    const c = freshManualCustomer(p, 'pa', now, 'Admin (pa-admin)');
    expect(c).toMatchObject({ senderPhone: '15551234567', partnerId: 'pa', kycStatus: 'not_started', fullName: 'Asha Rao', firstSeenAt: now, createdAt: now });
    expect(c.optInAt).toBeUndefined();
    expect(c.kycVerifiedAt).toBeUndefined();
    const v = parseManualCustomer(form({ phone: '15551234567', kycStatus: 'verified', reason: 'Checked passport in branch' }), delegated);
    if (!v.ok) throw new Error('parse');
    expect(freshManualCustomer(v, 'pa', now, 'Admin (pa-admin)')).toMatchObject({
      kycStatus: 'verified',
      kycVerifiedAt: now,
      kycApprovedBy: 'Admin (pa-admin)',
      kycApprovedAt: now,
    });
  });
});
