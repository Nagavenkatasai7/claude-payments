import { describe, it, expect } from 'vitest';
import { B2B_BILL_TTL_DAYS, billExpiryCutoff, isBillExpired } from '@/lib/b2b-bill-expiry';

// Program-Fix 44 (P3, b2b-04): an unpaid bill dies B2B_BILL_TTL_DAYS after it
// was created. Derived from created_at (no column, no migration).
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2030-03-15T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe('b2b bill expiry', () => {
  it('the TTL is 30 days', () => {
    expect(B2B_BILL_TTL_DAYS).toBe(30);
  });

  it('an unpaid bill 29 days old is live', () => {
    expect(isBillExpired({ status: 'unpaid', createdAt: ago(29 * DAY) }, NOW)).toBe(false);
  });

  it('an unpaid bill exactly 30 days old is still live (boundary: strictly older expires)', () => {
    expect(isBillExpired({ status: 'unpaid', createdAt: ago(30 * DAY) }, NOW)).toBe(false);
  });

  it('an unpaid bill one millisecond past 30 days is expired', () => {
    expect(isBillExpired({ status: 'unpaid', createdAt: ago(30 * DAY + 1) }, NOW)).toBe(true);
  });

  it('a non-unpaid bill never reads as expired (paid, voided, disputed keep their own state)', () => {
    for (const status of ['paid', 'voided', 'disputed'] as const) {
      expect(isBillExpired({ status, createdAt: ago(365 * DAY) }, NOW)).toBe(false);
    }
  });

  it('an unparseable createdAt fails closed (expired)', () => {
    expect(isBillExpired({ status: 'unpaid', createdAt: 'not-a-date' }, NOW)).toBe(true);
  });

  it('billExpiryCutoff is now minus the TTL (the SQL lower bound, inclusive)', () => {
    expect(billExpiryCutoff(NOW).toISOString()).toBe(ago(30 * DAY));
  });
});
