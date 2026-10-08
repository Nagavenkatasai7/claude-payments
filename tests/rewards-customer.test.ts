import { describe, it, expect } from 'vitest';
import { currentOfferLines, customerRewardLines, usdToSource } from '@/lib/rewards/customer';
import { etDateKey } from '@/lib/rewards/engine';
import { DEFAULT_CATALOG } from '@/lib/rewards/settings';
import type { Catalog, PartnerRewardSettings } from '@/lib/rewards/types';

// B3 rewards v1: the portal "My rewards" card. The customer sees ONLY the
// rewards that are on: available in the admin catalog, turned on by the
// partner, inside the catalog's current limits and (a festival) not ended.

const usd = (n: number) => `$${n.toFixed(2)}`;
const NOW = new Date();
const day = (offset: number) => etDateKey(new Date(NOW.getTime() + offset * 86_400_000));

const CATALOG: Catalog = {
  nth_transfer: { ...DEFAULT_CATALOG.nth_transfer, available: true },
  festival: { ...DEFAULT_CATALOG.festival, available: true, festivalNames: ['Diwali'] },
};

function settings(over: Partial<PartnerRewardSettings> = {}): PartnerRewardSettings {
  return {
    nth_transfer: { kind: 'nth_transfer', enabled: true, nth: 5 },
    festival: { kind: 'festival', enabled: true, festivalName: 'Diwali', startsOn: day(-1), endsOn: day(3), minAmountUsd: 100 },
    ...over,
  };
}

describe('currentOfferLines', () => {
  it('lists the festival first, then every Nth transfer', () => {
    const lines = currentOfferLines(CATALOG, settings(), NOW, usd);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Diwali offer, .+ to .+: no fee on transfers of \$100\.00 or more \(up to \$2\.99 off\)\.$/);
    expect(lines[1]).toBe('Every 5th transfer you send in a month has no fee (up to $2.99 off).');
  });

  it('a festival with no minimum says "any transfer"', () => {
    const lines = currentOfferLines(CATALOG, settings({
      festival: { kind: 'festival', enabled: true, festivalName: 'Diwali', startsOn: day(0), endsOn: day(0), minAmountUsd: 0 },
    }), NOW, usd);
    expect(lines[0]).toMatch(/no fee on any transfer \(up to \$2\.99 off\)\.$/);
  });

  it('hides what is off: not in the catalog, turned off by the partner, outside the limits or ended', () => {
    expect(currentOfferLines(DEFAULT_CATALOG, settings(), NOW, usd)).toEqual([]);
    expect(currentOfferLines(CATALOG, {
      nth_transfer: { kind: 'nth_transfer', enabled: false, nth: 5 },
      festival: undefined,
    }, NOW, usd)).toEqual([]);
    expect(currentOfferLines({ ...CATALOG, nth_transfer: { ...CATALOG.nth_transfer, nthMin: 6 } }, settings({ festival: undefined }), NOW, usd)).toEqual([]);
    expect(currentOfferLines(CATALOG, settings({
      nth_transfer: undefined,
      festival: { kind: 'festival', enabled: true, festivalName: 'Diwali', startsOn: day(-5), endsOn: day(-1), minAmountUsd: 0 },
    }), NOW, usd)).toEqual([]);
    // A festival name the admin took off the list is hidden too.
    expect(currentOfferLines({ ...CATALOG, festival: { ...CATALOG.festival, festivalNames: ['Holi'] } }, settings({ nth_transfer: undefined }), NOW, usd)).toEqual([]);
  });
});

describe('customerRewardLines', () => {
  it('lists the rewards the customer kept; released ones are left out', () => {
    const base = { month: '2026-10', createdAt: new Date(), giveBackUsd: 0, giveBackWithheld: false };
    expect(customerRewardLines([
      { ...base, transferId: 'a', kind: 'nth_transfer', discountUsd: 1.99, detail: { nth: 5 }, released: false },
      { ...base, transferId: 'b', kind: 'festival', discountUsd: 2.99, detail: { festivalName: 'Diwali' }, released: true },
      { ...base, transferId: 'c', kind: 'first_transfer', discountUsd: 1.99, detail: {}, released: false },
    ], usd)).toEqual([
      { transferId: 'a', text: 'Reward: 5th transfer this month (saved $1.99).' },
      { transferId: 'c', text: 'Reward: first transfer free (saved $1.99).' },
    ]);
  });
});

describe('usdToSource', () => {
  it('a USD transfer keeps the amount; another currency uses the transfer’s own ratio, rounded to cents', () => {
    expect(usdToSource(1.99, 'USD', 100, 100)).toBe(1.99);
    expect(usdToSource(2.5, 'GBP', 80, 100)).toBe(2);
    expect(usdToSource(1.99, 'EUR', 92.5, 100)).toBe(1.84);
    expect(usdToSource(1.99, 'GBP', undefined, 100)).toBe(1.99); // no source amount: USD figure
    expect(usdToSource(1.99, 'GBP', 80, 0)).toBe(1.99);
  });
});
