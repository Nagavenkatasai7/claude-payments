import { describe, it, expect } from 'vitest';
import {
  customerDirectoryRow,
  directorySummary,
  filterDirectory,
  pageDirectory,
  parseCustomerFilters,
  sendingTodayView,
  type CustomerDirectoryRow,
} from '@/lib/partner-customer-view';
import type { CapEvaluation, Customer } from '@/lib/types';

// Lost-features p2 B4 (customer list: country, tier, totals, last activity, filters) and B7
// ("Sending today"). Pure; phones stay masked, no name, no screening flag.
const DAY = 86_400_000;
const now = new Date('2026-09-10T12:00:00.000Z');
const PHONE = '15551239876';

function customer(over: Partial<Customer> = {}): Customer {
  return {
    senderPhone: PHONE,
    firstSeenAt: new Date(now.getTime() - 10 * DAY).toISOString(),
    kycStatus: 'verified',
    senderCountry: 'US',
    partnerId: 'ptn-alpha3',
    createdAt: new Date(now.getTime() - 10 * DAY).toISOString(),
    updatedAt: now.toISOString(),
    fullName: 'Ashaqz Ramanathan',
    watchlistHit: true,
    pepHit: true,
    ...over,
  } as Customer;
}

describe('customerDirectoryRow', () => {
  it('adds country, tier (with day of window), totals and last activity; still no name and no full phone', () => {
    const r = customerDirectoryRow(customer(), { count: 3, sentCents: 15_000, lastAt: '2026-09-09T10:00:00.000Z' }, now, true);
    expect(r).toMatchObject({
      phone: '••••9876',
      kycStatus: 'verified',
      country: 'US',
      tier: 'T1',
      tierKey: 'partner.customers.tier.T1',
      dayOfWindow: null,
      transfers: 3,
      sentCents: 15_000,
      lastActivityAt: '2026-09-09T10:00:00.000Z',
    });
    const json = JSON.stringify(r);
    for (const v of [PHONE, 'Ashaqz', 'Ramanathan']) expect(json).not.toContain(v);
    expect(json).not.toMatch(/watchlist|pepHit/i);
    expect(Object.keys(r)).not.toContain('name');
  });
  it('no transfers → zero totals and last activity falls back to first seen', () => {
    const c = customer({ firstSeenAt: new Date(now.getTime() - DAY / 2).toISOString(), kycStatus: 'pending' });
    const r = customerDirectoryRow(c, undefined, now, true);
    expect(r).toMatchObject({ transfers: 0, sentCents: 0, lastActivityAt: c.firstSeenAt, tier: 'T0', dayOfWindow: 1 });
  });
  it('identical output whatever the screening flags say (no oracle)', () => {
    const a = customerDirectoryRow(customer({ watchlistHit: true, pepHit: true }), undefined, now, true);
    const b = customerDirectoryRow(customer({ watchlistHit: false, pepHit: false }), undefined, now, true);
    expect({ ...a, ref: '' }).toEqual({ ...b, ref: '' });
  });
});

describe('parseCustomerFilters', () => {
  it('keeps closed values only', () => {
    expect(parseCustomerFilters({ kyc: 'verified', tier: 'T0', last4: '9876' })).toEqual({ kyc: 'verified', tier: 'T0', last4: '9876' });
    expect(parseCustomerFilters({ kyc: 'nope', tier: 't0', last4: '987' })).toEqual({});
    for (const bad of ['98765', '98a6', ' 9876', '+9876', '']) expect(parseCustomerFilters({ last4: bad }), bad).toEqual({});
    expect(parseCustomerFilters({ kyc: ['verified', 'pending'] })).toEqual({ kyc: 'verified' });
    expect(parseCustomerFilters({ tier: '__proto__', kyc: 'constructor' })).toEqual({});
    // A tenant parameter is never a filter.
    expect(parseCustomerFilters({ partnerId: 'pb', partner: 'pb' } as Record<string, string>)).toEqual({});
  });
});

describe('filterDirectory, pageDirectory and directorySummary', () => {
  const rows: CustomerDirectoryRow[] = [
    customerDirectoryRow(customer({ senderPhone: '15550001111', kycStatus: 'verified', createdAt: '2026-09-01T00:00:00.000Z' }), { count: 1, sentCents: 100, lastAt: '2026-09-09T00:00:00.000Z' }, now, true),
    customerDirectoryRow(customer({ senderPhone: '15550002222', kycStatus: 'pending', firstSeenAt: new Date(now.getTime() - DAY).toISOString(), createdAt: '2026-09-02T00:00:00.000Z' }), undefined, now, true),
    customerDirectoryRow(customer({ senderPhone: '15550003333', kycStatus: 'rejected', createdAt: '2026-09-03T00:00:00.000Z' }), { count: 2, sentCents: 0, lastAt: '2026-09-04T00:00:00.000Z' }, now, true),
  ];
  it('filters by KYC, tier and the last 4 digits', () => {
    expect(filterDirectory(rows, { kyc: 'pending' }).map((r) => r.phone)).toEqual(['••••2222']);
    expect(filterDirectory(rows, { tier: 'Suspended' }).map((r) => r.phone)).toEqual(['••••3333']);
    expect(filterDirectory(rows, { last4: '1111' }).map((r) => r.phone)).toEqual(['••••1111']);
    expect(filterDirectory(rows, { last4: '1111', kyc: 'pending' })).toEqual([]);
    expect(filterDirectory(rows, {})).toHaveLength(3);
  });
  it('sorts by created or last activity, then pages', () => {
    const byCreated = pageDirectory(rows, { sort: 'created', dir: 'desc', offset: 0, limit: 2 });
    expect(byCreated.total).toBe(3);
    expect(byCreated.rows.map((r) => r.phone)).toEqual(['••••3333', '••••2222']);
    const byActivity = pageDirectory(rows, { sort: 'lastActivity', dir: 'desc', offset: 0, limit: 3 });
    expect(byActivity.rows.map((r) => r.phone)).toEqual(['••••2222', '••••1111', '••••3333']);
    expect(pageDirectory(rows, { sort: 'lastActivity', dir: 'asc', offset: 0, limit: 1 }).rows[0].phone).toBe('••••3333');
  });
  it('summary counts every customer and those in their first days', () => {
    expect(directorySummary(rows)).toEqual({ total: 3, t0: 1 });
  });
});

describe('sendingTodayView', () => {
  const cap = (o: Partial<CapEvaluation>): CapEvaluation => ({
    withinCap: true,
    tier: 'T1',
    dailyCapCents: 299_900,
    perTransferCapCents: 299_900,
    todayUsedCents: 10_000,
    todayRemainingCents: 289_900,
    ...o,
  });
  it('carries the cap, used, left and the day of the window; never the reason', () => {
    expect(sendingTodayView(cap({}))).toEqual({ dailyCapCents: 299_900, usedCents: 10_000, remainingCents: 289_900, dayOfWindow: null });
    expect(sendingTodayView(cap({ tier: 'T0', dailyCapCents: 50_000, todayRemainingCents: 40_000, dayOfWindow: 2 }))).toEqual({
      dailyCapCents: 50_000,
      usedCents: 10_000,
      remainingCents: 40_000,
      dayOfWindow: 2,
    });
    const suspended = sendingTodayView(cap({ withinCap: false, tier: 'Suspended', dailyCapCents: 0, todayRemainingCents: 0, reason: 'verification_rejected' }));
    expect(suspended.remainingCents).toBe(0);
    expect(JSON.stringify(suspended)).not.toMatch(/reason|rejected|withinCap/);
  });
});
