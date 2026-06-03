import { describe, it, expect } from 'vitest';
import { isSendVerified, SEND_GATE_REASON } from '@/lib/kyc-gate';
import type { Customer } from '@/lib/types';

const c = (kycStatus: Customer['kycStatus']): Customer =>
  ({
    senderPhone: 'p',
    firstSeenAt: '',
    kycStatus,
    senderCountry: 'US',
    partnerId: 'default',
    createdAt: '',
    updatedAt: '',
  }) as Customer;

describe('isSendVerified', () => {
  it('only kycStatus "verified" may send — grandfathered may NOT (must onboard)', () => {
    expect(isSendVerified(c('verified'))).toBe(true);
    expect(isSendVerified(c('grandfathered'))).toBe(false); // Phase 3: must onboard
    expect(isSendVerified(c('pending'))).toBe(false);
    expect(isSendVerified(c('not_started'))).toBe(false);
    expect(isSendVerified(c('rejected'))).toBe(false);
  });

  it('a missing customer is not verified', () => {
    expect(isSendVerified(undefined)).toBe(false);
    expect(isSendVerified(null)).toBe(false);
  });

  it('exposes the machine-readable reason string', () => {
    expect(SEND_GATE_REASON).toBe('kyc_required');
  });
});
