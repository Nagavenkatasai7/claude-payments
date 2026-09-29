import { describe, it, expect } from 'vitest';
import { isUnchangedPartnerSetEntry } from '@/lib/send-limits';
import { sendLimitSourceLabel } from '@/app/admin-dashboard/send-limits-card';
import type { SendLimitOverride } from '@/lib/types';

// UI redesign M3-12 follow-up: an admin re-save of the prefilled "Send limits" form must never
// convert a PARTNER-set customer entry into a SmartRemit (setScope 'platform') override, which
// would silently lock the partner out. isUnchangedPartnerSetEntry is the pure predicate the admin
// action runs against the row-locked previous value.

const DAY = 86_400_000;
const futureDate = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const endOfDay = (d: string) => `${d}T23:59:59.999Z`;

const PARTNER_SET: SendLimitOverride = {
  perTransferCapCents: 50_000,
  t1DailyCapCents: 150_000,
  setBy: 'pa-admin',
  setAt: '2026-09-01T00:00:00.000Z',
  setScope: 'partner',
};

describe('isUnchangedPartnerSetEntry', () => {
  it('true when a partner-set entry is re-posted with the same caps (setBy/setAt/setScope ignored)', () => {
    expect(isUnchangedPartnerSetEntry(PARTNER_SET, { perTransferCapCents: 50_000, t1DailyCapCents: 150_000 })).toBe(true);
  });

  it('true when the expiry round-trips through the date-only form field (end of that day, UTC)', () => {
    const d = futureDate(5);
    const prev = { ...PARTNER_SET, expiresAt: endOfDay(d) };
    expect(isUnchangedPartnerSetEntry(prev, { perTransferCapCents: 50_000, t1DailyCapCents: 150_000, expiresAt: endOfDay(d) })).toBe(true);
    // A stored expiry that is not end-of-day still compares by its UTC date, as the prefill posts it.
    const midday = { ...PARTNER_SET, expiresAt: `${d}T12:00:00.000Z` };
    expect(isUnchangedPartnerSetEntry(midday, { perTransferCapCents: 50_000, t1DailyCapCents: 150_000, expiresAt: endOfDay(d) })).toBe(true);
  });

  it('false when any cap or the expiry changes, or a field is added or dropped', () => {
    const base = { perTransferCapCents: 50_000, t1DailyCapCents: 150_000 };
    expect(isUnchangedPartnerSetEntry(PARTNER_SET, { ...base, perTransferCapCents: 60_000 })).toBe(false);
    expect(isUnchangedPartnerSetEntry(PARTNER_SET, { ...base, t1DailyCapCents: 140_000 })).toBe(false);
    expect(isUnchangedPartnerSetEntry(PARTNER_SET, { perTransferCapCents: 50_000 })).toBe(false);
    expect(isUnchangedPartnerSetEntry({ ...PARTNER_SET, t1DailyCapCents: undefined }, base)).toBe(false);
    expect(isUnchangedPartnerSetEntry(PARTNER_SET, { ...base, expiresAt: endOfDay(futureDate(3)) })).toBe(false);
    const d = futureDate(5);
    expect(isUnchangedPartnerSetEntry({ ...PARTNER_SET, expiresAt: endOfDay(d) }, base)).toBe(false);
    expect(isUnchangedPartnerSetEntry({ ...PARTNER_SET, expiresAt: endOfDay(d) }, { ...base, expiresAt: endOfDay(futureDate(6)) })).toBe(false);
    // A full datetime on the same UTC day (not what the date-only prefill posts) is a change.
    expect(isUnchangedPartnerSetEntry({ ...PARTNER_SET, expiresAt: endOfDay(d) }, { ...base, expiresAt: `${d}T10:00:00.000Z` })).toBe(false);
  });

  it('false for a clear, a missing entry, and every non-partner entry (platform, legacy, unknown scope)', () => {
    const same = { perTransferCapCents: 50_000, t1DailyCapCents: 150_000 };
    expect(isUnchangedPartnerSetEntry(PARTNER_SET, null)).toBe(false);
    expect(isUnchangedPartnerSetEntry(null, same)).toBe(false);
    expect(isUnchangedPartnerSetEntry(undefined, same)).toBe(false);
    expect(isUnchangedPartnerSetEntry({ ...PARTNER_SET, setScope: 'platform' }, same)).toBe(false);
    const legacy: SendLimitOverride = { perTransferCapCents: 50_000, t1DailyCapCents: 150_000, setBy: 'root' };
    expect(isUnchangedPartnerSetEntry(legacy, same)).toBe(false);
    expect(isUnchangedPartnerSetEntry({ ...PARTNER_SET, setScope: 'other' as never }, same)).toBe(false);
  });

  it('an unparseable stored expiry is never "unchanged" (fails toward the audited write)', () => {
    const d = futureDate(5);
    expect(
      isUnchangedPartnerSetEntry({ ...PARTNER_SET, expiresAt: 'garbage' }, { perTransferCapCents: 50_000, t1DailyCapCents: 150_000, expiresAt: endOfDay(d) }),
    ).toBe(false);
  });
});

describe('sendLimitSourceLabel (admin card provenance)', () => {
  it('a customer-level figure from a partner-set entry reads as set by the partner', () => {
    expect(sendLimitSourceLabel('customer', 'customer', PARTNER_SET)).toBe('set by the partner for this customer');
  });

  it('SmartRemit-set and legacy entries read as today', () => {
    expect(sendLimitSourceLabel('customer', 'customer', { ...PARTNER_SET, setScope: 'platform' })).toBe('customer override');
    expect(sendLimitSourceLabel('customer', 'customer', { perTransferCapCents: 500_000 })).toBe('customer override');
    expect(sendLimitSourceLabel('customer', 'customer', undefined)).toBe('customer override');
    expect(sendLimitSourceLabel('partner', 'customer', PARTNER_SET)).toBe('partner default');
    expect(sendLimitSourceLabel('platform', 'customer', PARTNER_SET)).toBe('platform');
  });

  it('the partner-level card never picks up the partner-set label', () => {
    expect(sendLimitSourceLabel('customer', 'partner', PARTNER_SET)).toBe('customer override');
    expect(sendLimitSourceLabel('partner', 'partner', PARTNER_SET)).toBe('partner default');
  });
});
