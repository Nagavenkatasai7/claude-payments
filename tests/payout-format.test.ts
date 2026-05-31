import { describe, it, expect } from 'vitest';
import {
  BANK_FIELDS_BY_COUNTRY,
  validatePayoutFields,
  composePayoutDestination,
} from '@/lib/payout-format';
import type { CountryCode } from '@/lib/types';

describe('BANK_FIELDS_BY_COUNTRY', () => {
  it('defines a field list for every supported destination country', () => {
    const countries: CountryCode[] = ['US', 'CA', 'GB', 'AE', 'SG', 'AU', 'NZ', 'IN'];
    for (const c of countries) {
      expect(Array.isArray(BANK_FIELDS_BY_COUNTRY[c])).toBe(true);
      expect(BANK_FIELDS_BY_COUNTRY[c].length).toBeGreaterThan(0);
      // Every field has a key + label
      for (const f of BANK_FIELDS_BY_COUNTRY[c]) {
        expect(typeof f.key).toBe('string');
        expect(f.key.length).toBeGreaterThan(0);
        expect(typeof f.label).toBe('string');
        expect(f.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('mirrors the old prompt block field shapes', () => {
    expect(BANK_FIELDS_BY_COUNTRY.US.map((f) => f.key)).toEqual(['routingNumber', 'accountNumber']);
    expect(BANK_FIELDS_BY_COUNTRY.CA.map((f) => f.key)).toEqual(['transitNumber', 'institutionNumber', 'accountNumber']);
    expect(BANK_FIELDS_BY_COUNTRY.GB.map((f) => f.key)).toEqual(['sortCode', 'accountNumber']);
    expect(BANK_FIELDS_BY_COUNTRY.AE.map((f) => f.key)).toEqual(['iban']);
    expect(BANK_FIELDS_BY_COUNTRY.SG.map((f) => f.key)).toEqual(['bankCode', 'accountNumber']);
    expect(BANK_FIELDS_BY_COUNTRY.AU.map((f) => f.key)).toEqual(['bsb', 'accountNumber']);
    expect(BANK_FIELDS_BY_COUNTRY.NZ.map((f) => f.key)).toEqual(['accountNumber']);
    expect(BANK_FIELDS_BY_COUNTRY.IN.map((f) => f.key)).toEqual(['accountNumber', 'ifsc']);
  });

  it('encodes fixed digit-length rules where the old prompt specified them', () => {
    const usRouting = BANK_FIELDS_BY_COUNTRY.US.find((f) => f.key === 'routingNumber')!;
    expect(usRouting.digits).toBe(9);
    const gbSort = BANK_FIELDS_BY_COUNTRY.GB.find((f) => f.key === 'sortCode')!;
    expect(gbSort.digits).toBe(6);
    const auBsb = BANK_FIELDS_BY_COUNTRY.AU.find((f) => f.key === 'bsb')!;
    expect(auBsb.digits).toBe(6);
  });
});

describe('validatePayoutFields', () => {
  it('US: accepts a 9-digit routing + account, returns the composed destination', () => {
    const r = validatePayoutFields('US', { routingNumber: '021000021', accountNumber: '123456789' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.payoutDestination).toContain('021000021');
    expect(r.payoutDestination).toContain('123456789');
  });

  it('US: rejects a routing number that is not exactly 9 digits', () => {
    const r = validatePayoutFields('US', { routingNumber: '0210', accountNumber: '123456789' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.routingNumber).toBeDefined();
  });

  it('GB: rejects a sort code that is not 6 digits', () => {
    const r = validatePayoutFields('GB', { sortCode: '1234', accountNumber: '12345678' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.sortCode).toBeDefined();
  });

  it('GB: accepts a 6-digit sort code (hyphens/spaces tolerated)', () => {
    const r = validatePayoutFields('GB', { sortCode: '12-34-56', accountNumber: '12345678' });
    expect(r.ok).toBe(true);
  });

  it('AU: rejects a BSB that is not 6 digits', () => {
    const r = validatePayoutFields('AU', { bsb: '123', accountNumber: '123456' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.bsb).toBeDefined();
  });

  it('AE: accepts an IBAN', () => {
    const r = validatePayoutFields('AE', { iban: 'AE070331234567890123456' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.payoutDestination).toContain('AE070331234567890123456');
  });

  it('IN: accepts account + IFSC', () => {
    const r = validatePayoutFields('IN', { accountNumber: '123456789012', ifsc: 'HDFC0001234' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.payoutDestination).toContain('123456789012');
    expect(r.payoutDestination).toContain('HDFC0001234');
  });

  it('reports a per-field error for every missing required field', () => {
    const r = validatePayoutFields('IN', { accountNumber: '', ifsc: '' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.accountNumber).toBeDefined();
    expect(r.errors.ifsc).toBeDefined();
  });

  it('trims surrounding whitespace before validating', () => {
    const r = validatePayoutFields('US', { routingNumber: '  021000021 ', accountNumber: ' 123456789 ' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.payoutDestination).not.toContain('  ');
  });
});

describe('composePayoutDestination', () => {
  it('produces a single string from the supplied fields in field order', () => {
    const s = composePayoutDestination('US', { routingNumber: '021000021', accountNumber: '123456789' });
    expect(typeof s).toBe('string');
    expect(s).toContain('021000021');
    expect(s).toContain('123456789');
  });

  it('keeps the account number as the LONGEST digit run so accountLast4 finds it', () => {
    // US routing(9) + account(11): the account must be the longest run.
    const s = composePayoutDestination('US', { routingNumber: '021000021', accountNumber: '12345678901' });
    const runs = s.match(/\d+/g)!;
    const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest).toBe('12345678901');
    expect(longest.slice(-4)).toBe('8901');
  });

  it('IN: account number (longest run) wins over the IFSC numeric tail', () => {
    const s = composePayoutDestination('IN', { accountNumber: '987654321012', ifsc: 'HDFC0001234' });
    const runs = s.match(/\d+/g)!;
    const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
    expect(longest).toBe('987654321012');
    expect(longest.slice(-4)).toBe('1012');
  });

  it('AE: IBAN composes to a string containing the whole IBAN', () => {
    const s = composePayoutDestination('AE', { iban: 'AE070331234567890123456' });
    expect(s).toContain('AE070331234567890123456');
  });

  it('round-trips through validatePayoutFields → composePayoutDestination identically', () => {
    const fields = { routingNumber: '021000021', accountNumber: '123456789' };
    const v = validatePayoutFields('US', fields);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error('expected ok');
    expect(v.payoutDestination).toBe(composePayoutDestination('US', fields));
  });
});
