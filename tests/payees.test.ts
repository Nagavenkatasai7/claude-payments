import { describe, it, expect } from 'vitest';
import { nextPayeeStatus, parsePayeeInput, screenPayee } from '@/lib/payees';

// Batch B2: a payee is a company in India the partner works with. Bank details
// (account holder, IFSC, account number) are checked here, sealed by the repo,
// and never edited. Sanctions screening covers BOTH names, at add, approve and pay.

const good = {
  legalName: 'Sunrise Public School Trust',
  accountHolder: 'Sunrise Public School',
  ifsc: 'HDFC0001234',
  accountNumber: '50100123456789',
  accountNumberConfirm: '50100123456789',
};

describe('parsePayeeInput', () => {
  it('composes the IN destination (IFSC then account) and its last 4', () => {
    expect(parsePayeeInput(good)).toEqual({
      ok: true,
      value: {
        legalName: 'Sunrise Public School Trust',
        accountHolder: 'Sunrise Public School',
        payoutDestination: 'HDFC0001234 50100123456789',
        last4: '6789',
      },
    });
  });

  it('every field is required and checked', () => {
    const r = parsePayeeInput({ legalName: '', accountHolder: '', ifsc: 'HDFC123', accountNumber: '12', accountNumberConfirm: '12' });
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['accountHolder', 'accountNumber', 'ifsc', 'legalName']);
  });

  it('the account number must be typed twice, the same', () => {
    const r = parsePayeeInput({ ...good, accountNumberConfirm: '50100123456788' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.accountNumberConfirm).toBeTruthy();
  });

  it('a masked value is never an account', () => {
    expect(parsePayeeInput({ ...good, accountNumber: '****6789', accountNumberConfirm: '****6789' }).ok).toBe(false);
  });

  it('names with brackets or control characters are refused', () => {
    expect(parsePayeeInput({ ...good, legalName: 'School <b>' }).ok).toBe(false);
    expect(parsePayeeInput({ ...good, accountHolder: 'a\u0000b' }).ok).toBe(false);
  });
});

describe('screenPayee (both names, the mock watchlist)', () => {
  it('clear', async () => {
    expect((await screenPayee({ legalName: good.legalName, accountHolder: good.accountHolder })).verdict).toBe('clear');
  });
  it('a watchlist hit on either name is a match', async () => {
    expect((await screenPayee({ legalName: 'Test Blocked', accountHolder: good.accountHolder })).verdict).toBe('match');
    expect((await screenPayee({ legalName: good.legalName, accountHolder: 'Test Blocked' })).verdict).toBe('match');
  });
  it('returns evidence without names', async () => {
    const r = await screenPayee({ legalName: good.legalName, accountHolder: good.accountHolder });
    expect(JSON.stringify(r.evidence)).not.toContain('Sunrise');
  });
});

describe('nextPayeeStatus', () => {
  it('approve: pending or suspended → approved', () => {
    expect(nextPayeeStatus('pending', 'approve')).toBe('approved');
    expect(nextPayeeStatus('suspended', 'approve')).toBe('approved');
    expect(nextPayeeStatus('approved', 'approve')).toBeNull();
    expect(nextPayeeStatus('rejected', 'approve')).toBeNull();
  });
  it('reject: pending or suspended → rejected (final)', () => {
    expect(nextPayeeStatus('pending', 'reject')).toBe('rejected');
    expect(nextPayeeStatus('suspended', 'reject')).toBe('rejected');
    expect(nextPayeeStatus('approved', 'reject')).toBeNull();
  });
  it('suspend: approved → suspended', () => {
    expect(nextPayeeStatus('approved', 'suspend')).toBe('suspended');
    expect(nextPayeeStatus('pending', 'suspend')).toBeNull();
  });
});
