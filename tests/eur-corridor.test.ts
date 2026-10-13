import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY_FOR_COUNTRY, type CountryCode } from '@/lib/types';
import { FALLBACK_FX_RATES } from '@/lib/rate';
import { BANK_FIELDS_BY_COUNTRY, validatePayoutFields } from '@/lib/payout-format';
import { DEFAULT_PARTNER_COUNTRIES } from '@/lib/defaults';
import { currencyForPhone, countryForPhone, countryForCurrency, allowedSendCurrencies, sourceCountryFor } from '@/lib/partner-currency';
import { SUPPORTED_DESTINATIONS } from '@/lib/destination-country';
import { listCorridors } from '@/lib/partner-api-service';
import type { Partner } from '@/lib/types';

// Owner, 2026-10-12: Europe and EUR on the portal and the platform, send AND receive.
// Eight euro countries first. EUR is the first currency that several countries share.
const EURO: ReadonlyArray<[CountryCode, string, string]> = [
  // [country, calling code, a sample national number]
  ['DE', '49', '15123456789'],
  ['FR', '33', '612345678'],
  ['NL', '31', '612345678'],
  ['IE', '353', '851234567'],
  ['IT', '39', '3123456789'],
  ['ES', '34', '612345678'],
  ['AT', '43', '6641234567'],
  ['BE', '32', '470123456'],
];

describe('Europe / EUR corridors', () => {
  it.each(EURO)('%s uses EUR, is a destination, and is served by the default tenant', (cc) => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY[cc]).toBe('EUR');
    expect(SUPPORTED_DESTINATIONS).toContain(cc);
    expect(DEFAULT_PARTNER_COUNTRIES).toContain(cc);
  });

  it.each(EURO)('a +%s… phone resolves to its country and EUR', (cc, code, local) => {
    expect(countryForPhone(`${code}${local}`)).toBe(cc);
    expect(currencyForPhone(`${code}${local}`)).toBe('EUR');
  });

  it('the existing calling codes still win (no new prefix shadows +1, +44, +91, +971, +852, +52)', () => {
    expect(countryForPhone('15551234567')).toBe('US');
    expect(countryForPhone('447911123456')).toBe('GB');
    expect(countryForPhone('919876543210')).toBe('IN');
    expect(countryForPhone('971501234567')).toBe('AE');
    expect(countryForPhone('85291234567')).toBe('HK');
    expect(countryForPhone('525512345678')).toBe('MX');
  });

  describe('countryForCurrency: a shared currency needs the phone', () => {
    it('a one-country currency ignores the phone', () => {
      expect(countryForCurrency('MXN')).toBe('MX');
      expect(countryForCurrency('GBP', '4915123456789')).toBe('GB');
    });
    it.each(EURO)('EUR with a %s phone is %s', (cc, code, local) => {
      expect(countryForCurrency('EUR', `${code}${local}`)).toBe(cc);
    });
    it('EUR with no phone, or a phone outside the euro area, falls back to the first euro country (DE)', () => {
      expect(countryForCurrency('EUR')).toBe('DE');
      expect(countryForCurrency('EUR', '15551234567')).toBe('DE');
    });
  });

  it('one EUR entry in the send currencies, however many euro countries the partner has', () => {
    const p = { countries: ['US', 'DE', 'FR', 'IN'] } as unknown as Partner;
    expect(allowedSendCurrencies(p)).toEqual(['USD', 'EUR', 'INR']);
  });

  it('partner API /corridors lists each euro country as its own source, never one EUR row', () => {
    const p = { id: 'p1', countries: ['US', 'DE', 'FR', 'IN'] } as unknown as Partner;
    const sources = listCorridors(p).corridors.map((c) => `${c.source_country}/${c.source_currency}`);
    expect(sources).toEqual(['US/USD', 'DE/EUR', 'FR/EUR']);
  });

  it('has a display-only EUR table rate (ECB fixing 2026-10-06) that is never priced', () => {
    expect(FALLBACK_FX_RATES.EUR).toMatchObject({ toUsd: 1.1269, source: 'fallback' });
    expect(FALLBACK_FX_RATES.EUR.toInr).toBeCloseTo(108.66, 2);
  });

  it.each(EURO)('%s payouts take one IBAN, marked as the account', (cc) => {
    expect(BANK_FIELDS_BY_COUNTRY[cc].map((f) => f.key)).toEqual(['iban']);
    expect(BANK_FIELDS_BY_COUNTRY[cc][0].isAccount).toBe(true);
  });

  it('an IBAN must start with the payout country code', () => {
    expect(validatePayoutFields('DE', { iban: 'DE89370400440532013000' }).ok).toBe(true);
    expect(validatePayoutFields('DE', { iban: 'de89 3704 0044 0532 0130 00' }).ok).toBe(true);
    expect(validatePayoutFields('DE', { iban: 'FR1420041010050500013M02606' }).ok).toBe(false);
    expect(validatePayoutFields('FR', { iban: 'FR1420041010050500013M02606' }).ok).toBe(true);
    expect(validatePayoutFields('IE', { iban: 'X' }).ok).toBe(false);
  });
});

describe('sourceCountryFor — the source country stays inside the partner (security review, 2026-10-13)', () => {
  const partner = (countries: CountryCode[]) => ({ id: 'p', name: 'P', countries, status: 'active' as const, createdAt: '', updatedAt: '' });

  it('a FR-only partner: a +1 sender paying EUR is FR (never the DE fallback), so the FR corridor rules apply', () => {
    expect(sourceCountryFor(partner(['US', 'FR']), 'EUR', '15551234567')).toBe('FR');
  });

  it('a DE-only partner: a +33 sender paying EUR is DE, the corridor the partner configures', () => {
    expect(sourceCountryFor(partner(['DE']), 'EUR', '33612345678')).toBe('DE');
  });

  it('the phone country wins when the partner serves it', () => {
    expect(sourceCountryFor(partner(['DE', 'FR', 'IT']), 'EUR', '393123456789')).toBe('IT');
  });

  it('single-country currencies and an unknown partner keep the old answer', () => {
    expect(sourceCountryFor(partner(['US', 'GB']), 'GBP', '447911123456')).toBe('GB');
    expect(sourceCountryFor(undefined, 'EUR', '33612345678')).toBe('FR');
    expect(sourceCountryFor(partner(['US']), 'EUR')).toBe('DE');
  });
});
