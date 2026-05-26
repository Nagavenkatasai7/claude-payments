import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SENDER_COUNTRY,
  DEFAULT_SOURCE_COUNTRY,
  DEFAULT_SOURCE_CURRENCY,
  DEFAULT_DESTINATION_COUNTRY,
  DEFAULT_DESTINATION_CURRENCY,
} from '@/lib/defaults';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';

describe('P1 default constants', () => {
  it('senderCountry / source defaults are US / USD', () => {
    expect(DEFAULT_SENDER_COUNTRY).toBe('US');
    expect(DEFAULT_SOURCE_COUNTRY).toBe('US');
    expect(DEFAULT_SOURCE_CURRENCY).toBe('USD');
  });

  it('destination defaults are IN / INR (v1 payout is India only)', () => {
    expect(DEFAULT_DESTINATION_COUNTRY).toBe('IN');
    expect(DEFAULT_DESTINATION_CURRENCY).toBe('INR');
  });

  it('DEFAULT_CURRENCY_FOR_COUNTRY maps every supported country to its ISO 4217 currency', () => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.US).toBe('USD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.CA).toBe('CAD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.GB).toBe('GBP');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.AE).toBe('AED');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.SG).toBe('SGD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.AU).toBe('AUD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.NZ).toBe('NZD');
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.IN).toBe('INR');
  });

  it('every default sender/source country has an entry in DEFAULT_CURRENCY_FOR_COUNTRY', () => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY[DEFAULT_SENDER_COUNTRY]).toBe(DEFAULT_SOURCE_CURRENCY);
    expect(DEFAULT_CURRENCY_FOR_COUNTRY[DEFAULT_DESTINATION_COUNTRY]).toBe(DEFAULT_DESTINATION_CURRENCY);
  });
});
