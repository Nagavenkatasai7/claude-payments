import { describe, it, expect } from 'vitest';
import {
  allowedSendCurrencies,
  resolveSendCurrency,
  countryForCurrency,
} from '@/lib/partner-currency';
import { QuoteError } from '@/lib/fx';
import type { Partner } from '@/lib/types';

function partner(countries: Partner['countries']): Partner {
  return {
    id: 'p', name: 'P', countries, status: 'active',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('allowedSendCurrencies', () => {
  it("['US'] → ['USD']", () => {
    expect(allowedSendCurrencies(partner(['US']))).toEqual(['USD']);
  });
  it('maps multiple countries, drops payout-side IN, dedupes', () => {
    expect(allowedSendCurrencies(partner(['US', 'GB', 'IN']))).toEqual(['USD', 'GBP']);
  });
  it('falls back to USD when no send countries', () => {
    expect(allowedSendCurrencies(partner(['IN']))).toEqual(['USD']);
  });
});

describe('resolveSendCurrency', () => {
  it('single allowed → returns it, ignoring any requested override (dormant path)', () => {
    expect(resolveSendCurrency(partner(['US']), 'GBP')).toBe('USD');
  });
  it('multiple allowed + valid request → returns the request', () => {
    expect(resolveSendCurrency(partner(['US', 'GB']), 'gbp')).toBe('GBP');
  });
  it('multiple allowed + missing/invalid request → throws QuoteError', () => {
    expect(() => resolveSendCurrency(partner(['US', 'GB']), undefined)).toThrow(QuoteError);
    expect(() => resolveSendCurrency(partner(['US', 'GB']), 'EUR')).toThrow(/which currency/i);
  });
});

describe('countryForCurrency', () => {
  it('reverse-maps currency to ISO country', () => {
    expect(countryForCurrency('USD')).toBe('US');
    expect(countryForCurrency('GBP')).toBe('GB');
  });
});
