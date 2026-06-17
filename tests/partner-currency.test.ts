import { describe, it, expect } from 'vitest';
import {
  allowedSendCurrencies,
  resolveSendCurrency,
  countryForCurrency,
  currencyForPhone,
  countryForPhone,
  destinationCountryForRecipientPhone,
} from '@/lib/partner-currency';
import { QuoteError } from '@/lib/fx';
import { DEFAULT_PARTNER_COUNTRIES } from '@/lib/defaults';
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
  it('maps countries to currencies incl. INR (India is a valid source now), dedupes', () => {
    expect(allowedSendCurrencies(partner(['US', 'GB', 'IN']))).toEqual(['USD', 'GBP', 'INR']);
  });
  it('an India-only partner sends in INR', () => {
    expect(allowedSendCurrencies(partner(['IN']))).toEqual(['INR']);
  });
  it('falls back to USD when the partner has no countries at all', () => {
    expect(allowedSendCurrencies(partner([]))).toEqual(['USD']);
  });
  it('handles 3 send countries in stable order', () => {
    expect(allowedSendCurrencies(partner(['US', 'GB', 'CA']))).toEqual(['USD', 'GBP', 'CAD']);
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
  it('single allowed + no request → returns the single currency (not throw)', () => {
    expect(resolveSendCurrency(partner(['US']), undefined)).toBe('USD');
  });
  it('trims whitespace around the requested currency', () => {
    expect(resolveSendCurrency(partner(['US', 'GB']), ' gbp ')).toBe('GBP');
  });
});

describe('countryForCurrency', () => {
  it('reverse-maps currency to ISO country', () => {
    expect(countryForCurrency('USD')).toBe('US');
    expect(countryForCurrency('GBP')).toBe('GB');
  });
  it('reverse-maps INR to IN', () => {
    expect(countryForCurrency('INR')).toBe('IN');
  });
});

describe('countryForPhone', () => {
  it('US number → US', () => {
    expect(countryForPhone('15551234567')).toBe('US');
  });
  it('AE number (971 prefix) → AE', () => {
    expect(countryForPhone('971501234567')).toBe('AE');
  });
  it('GB number → GB', () => {
    expect(countryForPhone('447911123456')).toBe('GB');
  });
  it('IN number → IN', () => {
    expect(countryForPhone('919876543210')).toBe('IN');
  });
  it('empty string → undefined', () => {
    expect(countryForPhone('')).toBeUndefined();
  });
  it('unknown calling code → undefined', () => {
    expect(countryForPhone('886123')).toBeUndefined();
  });
});

describe('currencyForPhone', () => {
  it('US number → USD', () => {
    expect(currencyForPhone('15551234567')).toBe('USD');
  });
  it('AE number (971 prefix) → AED', () => {
    expect(currencyForPhone('971501234567')).toBe('AED');
  });
  it('GB number → GBP', () => {
    expect(currencyForPhone('447911123456')).toBe('GBP');
  });
  it('IN number → INR', () => {
    expect(currencyForPhone('919876543210')).toBe('INR');
  });
  it('empty string → undefined', () => {
    expect(currencyForPhone('')).toBeUndefined();
  });
  it('non-digit string → undefined', () => {
    expect(currencyForPhone('abc')).toBeUndefined();
  });
  it('unknown calling code → undefined', () => {
    expect(currencyForPhone('886123')).toBeUndefined();
  });
  it('greedy match: 971... → AED (not fallthrough to 9)', () => {
    // 9 is not in the map, 97 is not in the map, 971 → AE → AED
    expect(currencyForPhone('971501234567')).toBe('AED');
  });
});

describe('resolveSendCurrency with senderPhone', () => {
  const multiPartner = partner(['US', 'AE', 'GB']);

  it('multi-currency + senderPhone AE, no request → returns AED', () => {
    expect(resolveSendCurrency(multiPartner, undefined, '971501234567')).toBe('AED');
  });
  it('multi-currency + senderPhone US, no request → returns USD', () => {
    expect(resolveSendCurrency(multiPartner, undefined, '15551234567')).toBe('USD');
  });
  it('explicit requested GBP overrides AE phone default', () => {
    expect(resolveSendCurrency(multiPartner, 'GBP', '971501234567')).toBe('GBP');
  });
  it('phone currency not in allowed + no request → throws QuoteError', () => {
    // partner only has US and AE; GB phone → GBP not in allowed → should throw
    const usAePartner = partner(['US', 'AE']);
    expect(() => resolveSendCurrency(usAePartner, undefined, '447911123456')).toThrow(QuoteError);
  });
  it('single-currency partner ignores senderPhone (regression: phone never overrides)', () => {
    // partner(['US']) → USD always; GB phone must not change this
    expect(resolveSendCurrency(partner(['US']), undefined, '447911123456')).toBe('USD');
  });
});

describe('destinationCountryForRecipientPhone (any-to-any payout country)', () => {
  it('US recipient → US', () => {
    expect(destinationCountryForRecipientPhone('15551234567')).toBe('US');
  });
  it('IN recipient → IN', () => {
    expect(destinationCountryForRecipientPhone('919876543210')).toBe('IN');
  });
  it('GB recipient → GB', () => {
    expect(destinationCountryForRecipientPhone('447911123456')).toBe('GB');
  });
  it('bare local 10-digit (no country code) → undefined (⇒ the agent asks)', () => {
    expect(destinationCountryForRecipientPhone('9876543210')).toBeUndefined();
  });
  it('unknown calling code → undefined', () => {
    expect(destinationCountryForRecipientPhone('886123456')).toBeUndefined();
  });
});

describe('any-to-any default partner (the source-detection fix)', () => {
  const defaultPartner = partner(DEFAULT_PARTNER_COUNTRIES);

  it('the default partner is multi-currency (no single-currency bypass)', () => {
    expect(allowedSendCurrencies(defaultPartner).length).toBeGreaterThan(1);
  });
  it('+91 sender on the default partner → INR (was USD before the fix)', () => {
    expect(resolveSendCurrency(defaultPartner, undefined, '919876543210')).toBe('INR');
  });
  it('+44 sender on the default partner → GBP', () => {
    expect(resolveSendCurrency(defaultPartner, undefined, '447911123456')).toBe('GBP');
  });
  it('+1 sender on the default partner still → USD (regression)', () => {
    expect(resolveSendCurrency(defaultPartner, undefined, '15551234567')).toBe('USD');
  });
});
