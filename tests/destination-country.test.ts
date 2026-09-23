import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';
import {
  SUPPORTED_DESTINATIONS,
  destinationListText,
  parseDestinationCountry,
} from '@/lib/destination-country';

// Program-Fix 33: ONE country authority. Every valid-code set and every schema
// list derives from the keys of DEFAULT_CURRENCY_FOR_COUNTRY — never hand-typed.
describe('destination-country — the single country authority (Program-Fix 33)', () => {
  it('SUPPORTED_DESTINATIONS is exactly the keys of DEFAULT_CURRENCY_FOR_COUNTRY (10)', () => {
    expect(SUPPORTED_DESTINATIONS).toEqual(Object.keys(DEFAULT_CURRENCY_FOR_COUNTRY));
    expect(SUPPORTED_DESTINATIONS).toHaveLength(10);
    expect(SUPPORTED_DESTINATIONS).toContain('MX');
    expect(SUPPORTED_DESTINATIONS).toContain('HK');
  });

  it('parses a supported code case-insensitively and trims', () => {
    expect(parseDestinationCountry('mx')).toBe('MX');
    expect(parseDestinationCountry(' hk ')).toBe('HK');
    expect(parseDestinationCountry('IN')).toBe('IN');
  });

  it('absent or blank gives undefined (the caller decides the default)', () => {
    expect(parseDestinationCountry(undefined)).toBeUndefined();
    expect(parseDestinationCountry(null)).toBeUndefined();
    expect(parseDestinationCountry('')).toBeUndefined();
    expect(parseDestinationCountry('   ')).toBeUndefined();
  });

  it('anything else gives null — an unknown destination is an error, never India', () => {
    expect(parseDestinationCountry('ZZ')).toBeNull();
    expect(parseDestinationCountry('Mexico')).toBeNull();
    expect(parseDestinationCountry('INR')).toBeNull();
    expect(parseDestinationCountry(91)).toBeNull();
    expect(parseDestinationCountry({ code: 'IN' })).toBeNull();
  });

  it('destinationListText lists all ten codes for schema and error copy', () => {
    const text = destinationListText();
    for (const code of Object.keys(DEFAULT_CURRENCY_FOR_COUNTRY)) expect(text).toContain(code);
    expect(text).toBe(Object.keys(DEFAULT_CURRENCY_FOR_COUNTRY).join(', '));
  });
});
