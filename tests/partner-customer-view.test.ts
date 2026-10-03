import { describe, it, expect } from 'vitest';
import { openCustomerRef } from '@/lib/customer-ref';
import {
  REVEALABLE_FIELDS,
  KYC_STATUS_VALUES,
  PARTNER_CUSTOMERS_PAGE_SIZE,
  customerListRow,
  customerDetailView,
  isRevealableField,
  kycStatusKey,
  maskInitials,
  pageCustomers,
  reviewStateKey,
  revealableValue,
  tierView,
  customerProfileView,
} from '@/lib/partner-customer-view';
import type { Customer, KycReviewState, KycStatus } from '@/lib/types';

// UI redesign M3-11: the PURE view behind /partner/customers. Everything the page renders comes
// from these shapes, so the no-PII rule is checked here, structurally, not only on HTML strings.

const PHONE = '15551239876';
const NAME = 'Ashaqz Ramanathan';
const DOB = '1987-03-14';
const ADDRESS = '42 Elmqz Street, Springfield';
const GOV_ID = 'X9981234';

function customer(over: Partial<Customer> = {}): Customer {
  return {
    senderPhone: PHONE,
    firstSeenAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'ptn-alpha3',
    createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    updatedAt: new Date().toISOString(),
    fullName: NAME,
    dateOfBirth: DOB,
    residentialAddress: ADDRESS,
    govIdType: 'passport',
    govIdNumber: GOV_ID,
    idLast4: '1234',
    nationality: 'IN',
    kycRejectedReason: 'Matched list entry for Ashaqz',
    watchlistHit: true,
    ...over,
  } as Customer;
}

const PII = [PHONE, NAME, 'Ashaqz', 'Ramanathan', DOB, ADDRESS, 'Elmqz', GOV_ID, 'Matched list'];
const phoneRuns = (s: string) => {
  // any run of 5+ consecutive digits of the phone
  const runs: string[] = [];
  for (let i = 0; i + 5 <= PHONE.length; i++) runs.push(PHONE.slice(i, i + 5));
  return runs.filter((r) => s.includes(r));
};

describe('customerListRow', () => {
  it('never contains the full phone, a name, or any identity value', () => {
    const row = customerListRow(customer());
    const json = JSON.stringify(row);
    for (const v of PII) expect(json).not.toContain(v);
    expect(row.phone).toBe('••••9876');
  });
  it('has NO name key (review round 1: no name column)', () => {
    expect(Object.keys(customerListRow(customer())).sort()).toEqual(['createdAt', 'kycStatus', 'phone', 'ref']);
  });
  it('the ref round-trips to (partnerId, phone) and carries no digit run of the phone', () => {
    const row = customerListRow(customer());
    expect(openCustomerRef(row.ref)).toEqual({ partnerId: 'ptn-alpha3', phone: PHONE });
    expect(phoneRuns(row.ref)).toEqual([]);
    expect(row.ref).toMatch(/^[A-Za-z0-9._-]+$/);
  });
  it('an unknown kycStatus collapses to unknown (closed set)', () => {
    expect(customerListRow(customer({ kycStatus: 'weird' as KycStatus })).kycStatus).toBe('unknown');
  });
});

describe('closed label sets', () => {
  it('KYC_STATUS_VALUES pins every KycStatus', () => {
    const all: Record<KycStatus, true> = { not_started: true, pending: true, verified: true, rejected: true, grandfathered: true };
    expect([...KYC_STATUS_VALUES].sort()).toEqual(Object.keys(all).sort());
  });
  it('every status and review state has its own key; anything else is the unknown key', () => {
    const keys = new Set(KYC_STATUS_VALUES.map((s) => kycStatusKey(s)));
    expect(keys.size).toBe(KYC_STATUS_VALUES.length);
    expect(kycStatusKey('__proto__')).toBe('partner.customers.kyc.unknown');
    expect(kycStatusKey(undefined)).toBe('partner.customers.kyc.unknown');
    const review: Record<KycReviewState, true> = {
      none: true, inquiry_started: true, pending_review: true, needs_review: true, approved: true, rejected: true,
    };
    for (const s of Object.keys(review)) expect(reviewStateKey(s)).toMatch(/^partner\.customers\.review\./);
    expect(reviewStateKey(undefined)).toBe('partner.customers.review.none');
    expect(reviewStateKey('constructor')).toBe('partner.customers.review.unknown');
  });
});

describe('maskInitials', () => {
  it('shows initials only', () => {
    expect(maskInitials(NAME)).toBe('A. R.');
    expect(maskInitials('Ashaqz')).toBe('A.');
    expect(maskInitials('  ')).toBe('—');
    expect(maskInitials(undefined)).toBe('—');
  });
});

describe('customerDetailView', () => {
  it('holds only masked strings and closed-set keys: no identity value, no screening detail', () => {
    const v = customerDetailView(customer(), 'REF', new Date(), true);
    const json = JSON.stringify(v);
    for (const x of PII) expect(json).not.toContain(x);
    expect(json).not.toMatch(/watchlist|pep|sanction/i);
    expect(json).not.toContain('"IN"');
    expect(v.fields.map((f) => f.field)).toEqual(['phone', 'full_name', 'date_of_birth', 'nationality', 'residential_address']);
    const byField = Object.fromEntries(v.fields.map((f) => [f.field, f]));
    expect(byField.phone.masked).toBe('••••9876');
    expect(byField.full_name.masked).toBe('A. R.');
    expect(byField.date_of_birth.masked).toBe('••••');
    expect(byField.nationality.masked).toBe('••');
    expect(byField.residential_address.masked).toBe('••••');
    expect(v.kycStatusKey).toBe('partner.customers.kyc.verified');
    expect(v.tierKey).toBe('partner.customers.tier.T1');
  });
  it('an absent field is not revealable (nothing to reveal, no audit)', () => {
    const v = customerDetailView(customer({ dateOfBirth: undefined }), 'REF', new Date(), true);
    const dob = v.fields.find((f) => f.field === 'date_of_birth')!;
    expect(dob.present).toBe(false);
    expect(dob.masked).toBe('—');
  });
  it('the tier comes from deriveTier (rejected → Suspended; new → T0)', () => {
    expect(customerDetailView(customer({ kycStatus: 'rejected' }), 'R', new Date(), true).tierKey).toBe('partner.customers.tier.Suspended');
    expect(
      customerDetailView(customer({ firstSeenAt: new Date().toISOString(), kycStatus: 'pending' }), 'R', new Date(), true).tierKey,
    ).toBe('partner.customers.tier.T0');
  });
});

describe('tierView (the one tier label for the list, the detail page and the transfer list)', () => {
  const DAY = 86_400_000;
  const now = new Date('2026-09-10T12:00:00.000Z');
  const subject = (daysAgo: number, kycStatus: KycStatus) => ({ firstSeenAt: new Date(now.getTime() - daysAgo * DAY).toISOString(), kycStatus });
  it('T0 carries the day of the 3-day window (1 on the first day, capped at 3)', () => {
    expect(tierView(subject(0, 'pending'), now, true)).toEqual({ tier: 'T0', key: 'partner.customers.tier.T0', dayOfWindow: 1 });
    expect(tierView(subject(1.5, 'not_started'), now, true)).toEqual({ tier: 'T0', key: 'partner.customers.tier.T0', dayOfWindow: 2 });
    expect(tierView(subject(2.99, 'verified'), now, true).dayOfWindow).toBe(3);
  });
  it('T1 and Suspended carry no day; the KYC gate decides an unverified customer past the window', () => {
    expect(tierView(subject(10, 'verified'), now, true)).toEqual({ tier: 'T1', key: 'partner.customers.tier.T1', dayOfWindow: null });
    expect(tierView(subject(10, 'grandfathered'), now, true).tier).toBe('T1');
    expect(tierView(subject(10, 'pending'), now, true)).toEqual({ tier: 'Suspended', key: 'partner.customers.tier.Suspended', dayOfWindow: null });
    expect(tierView(subject(10, 'pending'), now, false).tier).toBe('T1');
    expect(tierView(subject(0, 'rejected'), now, false)).toEqual({ tier: 'Suspended', key: 'partner.customers.tier.Suspended', dayOfWindow: null });
  });
  it('the detail view uses the same label', () => {
    for (const c of [customer(), customer({ kycStatus: 'rejected' }), customer({ firstSeenAt: now.toISOString(), kycStatus: 'pending' })]) {
      expect(customerDetailView(c, 'R', now, true).tierKey).toBe(tierView(c, now, true).key);
    }
  });
});

describe('revealable fields', () => {
  it('the allowlist is exactly the five plan fields (p2 B5 adds nationality)', () => {
    expect([...REVEALABLE_FIELDS]).toEqual(['full_name', 'date_of_birth', 'nationality', 'residential_address', 'phone']);
  });
  it('isRevealableField refuses anything else, including prototype keys and non-strings', () => {
    for (const f of ['email', '__proto__', 'constructor', 'toString', 'govIdNumber', 'gov_id', 'pep_declared', '', 'PHONE']) {
      expect(isRevealableField(f), f).toBe(false);
    }
    expect(isRevealableField(1)).toBe(false);
    expect(isRevealableField(null)).toBe(false);
    for (const f of REVEALABLE_FIELDS) expect(isRevealableField(f)).toBe(true);
  });
  it('revealableValue maps each field to its own value', () => {
    const c = customer();
    expect(revealableValue(c, 'phone')).toBe(`+${PHONE}`);
    expect(revealableValue(c, 'full_name')).toBe(NAME);
    expect(revealableValue(c, 'date_of_birth')).toBe(DOB);
    expect(revealableValue(c, 'residential_address')).toBe(ADDRESS);
    expect(revealableValue(c, 'nationality')).toBe('IN');
    expect(revealableValue(customer({ nationality: undefined }), 'nationality')).toBeUndefined();
    expect(revealableValue(customer({ fullName: '  ' }), 'full_name')).toBeUndefined();
  });
});

describe('pageCustomers', () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    customer({ senderPhone: `1555000${String(i).padStart(4, '0')}`, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() }),
  );
  it('pages 50 at a time, newest first by default, and reports the total', () => {
    expect(PARTNER_CUSTOMERS_PAGE_SIZE).toBe(50);
    const p1 = pageCustomers(many, { offset: 0, limit: 50, dir: 'desc' });
    expect(p1.total).toBe(120);
    expect(p1.rows).toHaveLength(50);
    expect(p1.rows[0].senderPhone).toBe('15550000119');
    const p3 = pageCustomers(many, { offset: 100, limit: 50, dir: 'desc' });
    expect(p3.rows).toHaveLength(20);
    expect(pageCustomers(many, { offset: 0, limit: 50, dir: 'asc' }).rows[0].senderPhone).toBe('15550000000');
  });
});

// Lost-features p2 B6: the profile fields that come back. Closed label keys and masked strings only;
// never the screening flags, the full ID number, the full verification reference or the rejected reason.
describe('customerProfileView', () => {
  const full = customer({
    govIdType: 'passport',
    govIdNumber: 'X9981234',
    idDocType: 'national_id',
    idLast4: '5678',
    pepDeclared: false,
    sourceOfFunds: 'employment',
    occupation: 'self_employed',
    kycProviderRef: 'inq_ABCDEFGH7777',
    kycInquiryId: 'inq_ABCDEFGH7777',
  });
  it('closed keys and masked values', () => {
    expect(customerProfileView(full)).toEqual({
      country: 'US',
      govId: { typeKey: 'partner.customers.govId.passport', last4: '••••1234' },
      pepDeclaredKey: 'partner.customers.pepDeclared.no',
      sourceOfFundsKey: 'partner.customers.sof.employment',
      occupationKey: 'partner.customers.occupation.self_employed',
      verificationRefs: ['****7777'],
    });
  });
  it('falls back to the verified document class and its last 4; two different refs show twice', () => {
    const v = customerProfileView(customer({ govIdType: undefined, govIdNumber: undefined, idDocType: 'national_id', idLast4: '5678', kycProviderRef: 'prov_1111', kycInquiryId: 'inq_2222' }));
    expect(v.govId).toEqual({ typeKey: 'partner.customers.govId.national_id', last4: '••••5678' });
    expect(v.verificationRefs).toEqual(['****1111', '****2222']);
  });
  it('absent values give null (the PEP row renders only when the customer answered)', () => {
    const v = customerProfileView(customer({ govIdType: undefined, govIdNumber: undefined, idDocType: undefined, idLast4: undefined }));
    expect(v).toMatchObject({ govId: null, pepDeclaredKey: null, sourceOfFundsKey: null, occupationKey: null, verificationRefs: [] });
    expect(customerProfileView(customer({ pepDeclared: true })).pepDeclaredKey).toBe('partner.customers.pepDeclared.yes');
  });
  it('unknown enum values collapse to the unknown key', () => {
    const v = customerProfileView(customer({ sourceOfFunds: 'crypto' as never, occupation: '__proto__' as never, govIdType: 'weird' as never }));
    expect(v.sourceOfFundsKey).toBe('partner.customers.sof.unknown');
    expect(v.occupationKey).toBe('partner.customers.occupation.unknown');
    expect(v.govId?.typeKey).toBe('partner.customers.govId.unknown');
  });
  it('never carries the full ID, the full reference, the rejected reason or a screening flag; identical with the flags flipped', () => {
    const json = JSON.stringify(customerProfileView(full));
    for (const x of ['X998', 'ABCDEFGH', 'Matched list', 'watchlist', 'pepHit']) expect(json).not.toContain(x);
    const a = customerProfileView(customer({ ...full, watchlistHit: true, pepHit: true, kycRejectedReason: 'hit' }));
    const b = customerProfileView(customer({ ...full, watchlistHit: false, pepHit: false, kycRejectedReason: undefined }));
    expect(a).toEqual(b);
  });
});
