import { describe, it, expect } from 'vitest';
import { gateOffOnLiveRail, isSendVerified, SEND_GATE_REASON, sendGateActive } from '@/lib/kyc-gate';
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
  it('default / null / undefined partner ⇒ gate OFF (verification is partner OPT-IN)', () => {
    expect(sendGateActive(null)).toBe(false);
    expect(sendGateActive(undefined)).toBe(false);
    expect(sendGateActive(partner({ id: 'default' }))).toBe(false);
  });

  it("the gate is ON only when explicitly configured — in EITHER mode", () => {
    expect(sendGateActive(partner({ kycMode: 'ours', requireKycBeforeSend: true }))).toBe(true);
    expect(sendGateActive(partner({ kycMode: 'delegated', requireKycBeforeSend: true }))).toBe(true);
    expect(sendGateActive(partner({ kycMode: 'ours', requireKycBeforeSend: false }))).toBe(false);
  });

  it("'delegated' ⇒ gate OFF (partner runs KYC); opting back in flips it ON", () => {
    expect(sendGateActive(partner({ kycMode: 'delegated' }))).toBe(false);
    expect(sendGateActive(partner({ kycMode: 'delegated', requireKycBeforeSend: true }))).toBe(true);
  });
});

describe('gateOffOnLiveRail (Program-Fix 35: partner page warning, read-only)', () => {
  const rail = (providerType?: string) => ({ payment: providerType === undefined ? {} : { providerType } });

  it('gate OFF + a non-mock settlement provider → true', () => {
    expect(gateOffOnLiveRail(partner({}), rail('http'))).toBe(true);
    expect(gateOffOnLiveRail(partner({ requireKycBeforeSend: false }), rail('simulator'))).toBe(true);
    expect(gateOffOnLiveRail(partner({ kycMode: 'delegated' }), rail('http'))).toBe(true);
  });

  it('gate OFF on the mock (or unset / blank) provider → false', () => {
    expect(gateOffOnLiveRail(partner({}), rail('mock'))).toBe(false);
    expect(gateOffOnLiveRail(partner({}), rail(undefined))).toBe(false);
    expect(gateOffOnLiveRail(partner({}), rail(''))).toBe(false);
  });

  it('gate ON never warns, whatever the rail', () => {
    expect(gateOffOnLiveRail(partner({ requireKycBeforeSend: true }), rail('http'))).toBe(false);
    expect(gateOffOnLiveRail(partner({ requireKycBeforeSend: true }), rail('mock'))).toBe(false);
  });

  it('a missing partner is gate OFF (the resolver default)', () => {
    expect(gateOffOnLiveRail(null, rail('http'))).toBe(true);
  });
});
