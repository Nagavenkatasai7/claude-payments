import { describe, it, expect } from 'vitest';
import { isSendVerified, SEND_GATE_REASON, sendGateActive } from '@/lib/kyc-gate';
import type { Customer, Partner } from '@/lib/types';

const now = '2026-06-08T00:00:00Z';
const partner = (over: Partial<Partner>): Partner => ({
  id: 'p',
  name: 'P',
  countries: ['US'],
  status: 'active',
  createdAt: now,
  updatedAt: now,
  ...over,
});

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

describe('sendGateActive (WL1 per-partner gate)', () => {
  it('default / null / undefined partner ⇒ gate ON (unchanged)', () => {
    expect(sendGateActive(null)).toBe(true);
    expect(sendGateActive(undefined)).toBe(true);
    expect(sendGateActive(partner({ id: 'default' }))).toBe(true);
  });

  it("'ours' can NEVER skip the gate — stays ON even with requireKycBeforeSend:false", () => {
    expect(sendGateActive(partner({ kycMode: 'ours', requireKycBeforeSend: false }))).toBe(true);
  });

  it("'delegated' ⇒ gate OFF (partner runs KYC); opting back in flips it ON", () => {
    expect(sendGateActive(partner({ kycMode: 'delegated' }))).toBe(false);
    expect(sendGateActive(partner({ kycMode: 'delegated', requireKycBeforeSend: true }))).toBe(true);
  });
});
