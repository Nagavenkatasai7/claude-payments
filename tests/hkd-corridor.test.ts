import { describe, it, expect } from 'vitest';
import { DEFAULT_CURRENCY_FOR_COUNTRY } from '@/lib/types';
import { FALLBACK_FX_RATES } from '@/lib/rate';
import { BANK_FIELDS_BY_COUNTRY } from '@/lib/payout-format';
import { DEFAULT_PARTNER_COUNTRIES } from '@/lib/defaults';
import { currencyForPhone, countryForPhone, countryForCurrency } from '@/lib/partner-currency';

describe('HKD / Hong Kong is a first-class corridor', () => {
  it('maps the country to its home currency', () => {
    expect(DEFAULT_CURRENCY_FOR_COUNTRY.HK).toBe('HKD');
  });

  it('resolves a +852 phone to HK / HKD', () => {
    expect(countryForPhone('85291234567')).toBe('HK');
    expect(currencyForPhone('85291234567')).toBe('HKD');
  });

  it('resolves HKD back to its country', () => {
    expect(countryForCurrency('HKD')).toBe('HK');
  });

  it('has an offline fallback rate (HKD is USD-pegged ≈ 7.8/USD)', () => {
    expect(FALLBACK_FX_RATES.HKD).toBeDefined();
    expect(FALLBACK_FX_RATES.HKD.toUsd).toBeCloseTo(0.128, 2);
  });

  it('defines HK bank fields (bank code + branch code + account)', () => {
    const keys = BANK_FIELDS_BY_COUNTRY.HK.map((f) => f.key);
    expect(keys).toEqual(['bankCode', 'branchCode', 'accountNumber']);
  });

  it('the default tenant serves HK (unambiguous +852 calling code)', () => {
    expect(DEFAULT_PARTNER_COUNTRIES).toContain('HK');
  });
});
