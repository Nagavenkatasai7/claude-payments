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
    expect(v.fields.map((f) => f.field)).toEqual(['phone', 'full_name', 'date_of_birth', 'residential_address']);
    const byField = Object.fromEntries(v.fields.map((f) => [f.field, f]));
    expect(byField.phone.masked).toBe('••••9876');
    expect(byField.full_name.masked).toBe('A. R.');
    expect(byField.date_of_birth.masked).toBe('••••');
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
  it('the allowlist is exactly the four plan fields', () => {
    expect([...REVEALABLE_FIELDS]).toEqual(['full_name', 'date_of_birth', 'residential_address', 'phone']);
  });
  it('isRevealableField refuses anything else, including prototype keys and non-strings', () => {
    for (const f of ['email', '__proto__', 'constructor', 'toString', 'govIdNumber', 'nationality', '', 'PHONE']) {
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
