import { describe, it, expect } from 'vitest';
import { getSenderDefaultsNote } from '@/lib/sender-defaults';
import type { Customer } from '@/lib/types';

const base: Customer = {
  senderPhone: '15551234567',
  firstSeenAt: '2026-01-01T00:00:00.000Z',
  kycStatus: 'verified',
  senderCountry: 'US',
  partnerId: 'default',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('getSenderDefaultsNote', () => {
  it('returns a note naming a recent funding method', () => {
    const note = getSenderDefaultsNote({
      ...base,
      lastFundingMethod: 'bank_transfer',
      lastFundingMethodAt: new Date().toISOString(),
    });
    expect(note).toContain('[SENDER DEFAULTS]');
    expect(note.toLowerCase()).toContain('bank transfer');
  });
  it('returns "" for a customer with no remembered method (dormancy)', () => {
    expect(getSenderDefaultsNote(base)).toBe('');
  });
  it('returns "" for a null customer (new/history-less)', () => {
    expect(getSenderDefaultsNote(null)).toBe('');
  });
  it('returns "" when the default is older than 90 days (stale ⇒ ask)', () => {
    const stale = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    const note = getSenderDefaultsNote({
      ...base,
      lastFundingMethod: 'debit_card',
      lastFundingMethodAt: stale,
    });
    expect(note).toBe('');
  });
  it('leaks no partner/compliance/PII terms', () => {
    const note = getSenderDefaultsNote({
      ...base,
      lastFundingMethod: 'credit_card',
      lastFundingMethodAt: new Date().toISOString(),
    }).toLowerCase();
    for (const term of ['partner', 'corridor', 'compliance', 'watchlist', 'sanctions', 'provider']) {
      expect(note).not.toContain(term);
    }
  });
});
