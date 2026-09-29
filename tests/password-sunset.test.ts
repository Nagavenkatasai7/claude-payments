/**
 * M2-14 Task 14.2: the legacy /account password-sunset banner date. The env
 * CUSTOMER_PASSWORD_SUNSET holds the sunset date itself (launch + 30 days, set
 * by the owner at enablement) as an ISO date. Unset or invalid ⇒ no banner.
 */
import { describe, it, expect } from 'vitest';
import { passwordSunsetLabel } from '@/lib/password-sunset';

describe('passwordSunsetLabel', () => {
  it('unset or blank ⇒ null (the banner is hidden)', () => {
    expect(passwordSunsetLabel(undefined)).toBeNull();
    expect(passwordSunsetLabel('')).toBeNull();
    expect(passwordSunsetLabel('   ')).toBeNull();
  });

  it('a valid ISO date ⇒ a long English date, in UTC (no server/client timezone drift)', () => {
    expect(passwordSunsetLabel('2026-11-06')).toBe('November 6, 2026');
    expect(passwordSunsetLabel(' 2026-12-31 ')).toBe('December 31, 2026');
    expect(passwordSunsetLabel('2027-01-01')).toBe('January 1, 2027');
  });

  it('anything that is not a real YYYY-MM-DD date ⇒ null', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '06/11/2026', 'November 6', '2026-11-06T00:00:00Z', 'soon', '2026-1-6']) {
      expect(passwordSunsetLabel(bad), bad).toBeNull();
    }
  });
});
