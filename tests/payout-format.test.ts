import { describe, it, expect } from 'vitest';
import {
  BANK_FIELDS_BY_COUNTRY,
  validatePayoutFields,
  composePayoutDestination,
  accountLast4,
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

// ── FIX 3: free-form field FORMAT validation (IFSC / IBAN / account min-digits) ──
describe('validatePayoutFields — IFSC format (Fix 3)', () => {
  it('rejects an IFSC of "X" (too short, wrong shape)', () => {
    const r = validatePayoutFields('IN', { accountNumber: '123456789012', ifsc: 'X' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.ifsc).toBeDefined();
  });

  it('rejects an IFSC of "HDFC123" (no 0 in 5th position, wrong length)', () => {
    const r = validatePayoutFields('IN', { accountNumber: '123456789012', ifsc: 'HDFC123' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.ifsc).toBeDefined();
  });

  it('rejects an IFSC whose 5th char is not "0"', () => {
    const r = validatePayoutFields('IN', { accountNumber: '123456789012', ifsc: 'HDFCX001234' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.ifsc).toBeDefined();
  });

  it('accepts a valid 11-char IFSC (HDFC0001234)', () => {
    const r = validatePayoutFields('IN', { accountNumber: '123456789012', ifsc: 'HDFC0001234' });
    expect(r.ok).toBe(true);
  });

  it('accepts a valid IFSC case-insensitively', () => {
    const r = validatePayoutFields('IN', { accountNumber: '123456789012', ifsc: 'hdfc0001234' });
    expect(r.ok).toBe(true);
  });
});

describe('validatePayoutFields — IBAN format (Fix 3)', () => {
  it('rejects a too-short IBAN', () => {
    const r = validatePayoutFields('AE', { iban: 'AE07' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.iban).toBeDefined();
  });

  it('rejects an IBAN that does not start with two letters + two digits', () => {
    const r = validatePayoutFields('AE', { iban: '12070331234567890123456' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.iban).toBeDefined();
  });

  it('accepts a well-formed AE IBAN', () => {
    const r = validatePayoutFields('AE', { iban: 'AE070331234567890123456' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.payoutDestination).toContain('AE070331234567890123456');
  });
});

describe('validatePayoutFields — account-number min-digits (Fix 3)', () => {
  it('rejects a 5-digit account number ("12345")', () => {
    const r = validatePayoutFields('US', { routingNumber: '021000021', accountNumber: '12345' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.accountNumber).toBeDefined();
  });

  it('rejects a non-numeric account-number scribble ("X")', () => {
    const r = validatePayoutFields('US', { routingNumber: '021000021', accountNumber: 'X' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.accountNumber).toBeDefined();
  });

  it('accepts an 8-digit US account number ("12345678")', () => {
    const r = validatePayoutFields('US', { routingNumber: '021000021', accountNumber: '12345678' });
    expect(r.ok).toBe(true);
  });

  it('accepts a 9-digit IN account number', () => {
    const r = validatePayoutFields('IN', { accountNumber: '123456789', ifsc: 'HDFC0001234' });
    expect(r.ok).toBe(true);
  });

  it('accepts a hyphenated NZ account number (>= 6 digits after stripping)', () => {
    const r = validatePayoutFields('NZ', { accountNumber: '01-0123-0123456-00' });
    expect(r.ok).toBe(true);
  });

  it('still reports the required error (not the min-digits error) for a blank account', () => {
    const r = validatePayoutFields('US', { routingNumber: '021000021', accountNumber: '' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.accountNumber).toContain('required');
  });
});

describe('accountLast4 — account-aware (LAST digit run, Fix 4)', () => {
  it('US routing(9) + account(8): returns the ACCOUNT tail, not the routing tail', () => {
    // composePayoutDestination places the account LAST, so the last digit run is
    // the account. Previously the LONGEST run (the 9-digit routing) was used,
    // which surfaced the routing tail "6789" instead of the account tail "5678".
    const dest = composePayoutDestination('US', { routingNumber: '123456789', accountNumber: '12345678' });
    expect(accountLast4(dest)).toBe('5678');
    expect(accountLast4(dest)).not.toBe('6789');
  });

  it('IN account + IFSC: account is last among the composed fields', () => {
    const dest = composePayoutDestination('IN', { accountNumber: '987654321012', ifsc: 'HDFC0001234' });
    // account is placed last, so its tail is returned (not the IFSC numeric tail)
    expect(accountLast4(dest)).toBe('1012');
  });

  it('AE IBAN: single run, returns its tail', () => {
    const dest = composePayoutDestination('AE', { iban: 'AE070331234567890123456' });
    expect(accountLast4(dest)).toBe('3456');
  });

  it('returns "" when there are no digits at all', () => {
    expect(accountLast4('mom@okhdfc')).toBe('');
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

// HK is the Phase-1 cross-border seller corridor: bank code (3) + branch code (3)
// + account number. The account is composed LAST so accountLast4 targets it.
describe('HK payout fields (cross-border seller corridor)', () => {
  it('defines bank code (3) + branch code (3) + account number, in order', () => {
    expect(BANK_FIELDS_BY_COUNTRY.HK.map((f) => f.key)).toEqual(['bankCode', 'branchCode', 'accountNumber']);
    expect(BANK_FIELDS_BY_COUNTRY.HK.find((f) => f.key === 'bankCode')!.digits).toBe(3);
    expect(BANK_FIELDS_BY_COUNTRY.HK.find((f) => f.key === 'branchCode')!.digits).toBe(3);
  });

  it('accepts a valid HK bank/branch/account and composes account-last', () => {
    const r = validatePayoutFields('HK', { bankCode: '024', branchCode: '388', accountNumber: '12345678' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.payoutDestination).toBe('024 388 12345678');
    // The account number is the LAST run of digits → last4 targets it.
    expect(accountLast4(r.payoutDestination)).toBe('5678');
  });

  it('rejects a bank code / branch code that is not exactly 3 digits', () => {
    const r = validatePayoutFields('HK', { bankCode: '24', branchCode: '388', accountNumber: '12345678' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.bankCode).toBeDefined();
  });

  it('rejects a too-short account number', () => {
    const r = validatePayoutFields('HK', { bankCode: '024', branchCode: '388', accountNumber: '123' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.errors.accountNumber).toBeDefined();
  });
});
