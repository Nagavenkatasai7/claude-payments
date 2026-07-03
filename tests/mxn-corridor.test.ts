import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';
import { FALLBACK_FX_RATES } from '@/lib/rate';
import { BANK_FIELDS_BY_COUNTRY, validatePayoutFields } from '@/lib/payout-format';
import { DEFAULT_PARTNER_COUNTRIES } from '@/lib/defaults';
import { currencyForPhone, countryForPhone, countryForCurrency } from '@/lib/partner-currency';

describe('MXN / Mexico is a first-class corridor', () => {
  it('maps the country to its home currency', () => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.MX).toBe('MXN');
  });

  it('resolves a +52 phone to MX / MXN', () => {
    expect(countryForPhone('525512345678')).toBe('MX');
    expect(currencyForPhone('525512345678')).toBe('MXN');
  });

  it('resolves MXN back to its country', () => {
    expect(countryForCurrency('MXN')).toBe('MX');
  });

  it('has an offline fallback rate (MXN ≈ 18.5/USD)', () => {
    expect(FALLBACK_FX_RATES.MXN).toBeDefined();
    expect(FALLBACK_FX_RATES.MXN.toUsd).toBeCloseTo(0.054, 3);
  });

  it('defines MX bank fields (the single 18-digit CLABE, marked as the account)', () => {
    expect(BANK_FIELDS_BY_COUNTRY.MX.map((f) => f.key)).toEqual(['clabe']);
    expect(BANK_FIELDS_BY_COUNTRY.MX[0]).toMatchObject({ label: 'CLABE', digits: 18, isAccount: true });
  });

  it('validates the CLABE: exactly 18 digits pass; 17 digits fail', () => {
    const ok = validatePayoutFields('MX', { clabe: '002010077777777771' });
    expect(ok.ok).toBe(true);
    const short = validatePayoutFields('MX', { clabe: '00201007777777777' });
    expect(short.ok).toBe(false);
  });

  it('the default tenant serves MX (unambiguous +52 calling code)', () => {
    expect(DEFAULT_PARTNER_COUNTRIES).toContain('MX');
  });
});
