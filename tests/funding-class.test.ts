import { describe, it, expect } from 'vitest';
import { fundingClassOf, fundingModeMatches, isRoutedRow, refundWithoutCharge } from '@/lib/funding-class';
import type { FundingModeRecord } from '@/lib/live-controls';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T12 (P12): how the sender's money was collected, read from
// transfers.funding_provider (and the intent / ref columns), never from the
// 'mockfund-' prefix of a reference. Pure.

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'fc_t1', phone: '15550000011', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Ani', recipientPhone: '919800000011',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: daysAgo(1), paidAt: daysAgo(1), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

describe('fundingClassOf (fix pack 5 T12, P12)', { retry: 0 }, () => {
  it('sandbox first: a test row is sandbox whatever its provider or ref', () => {
    expect(fundingClassOf(transfer({ environment: 'test' }))).toBe('sandbox');
    expect(fundingClassOf(transfer({ environment: 'test', fundingProvider: 'stripe', fundingIntentRef: 'pi_1' }))).toBe('sandbox');
    expect(fundingClassOf(transfer({ environment: 'test', fundingProvider: 'mock', fundingRef: 'mockfund-x' }))).toBe('sandbox');
    expect(fundingClassOf(transfer({ environment: 'test', fundingMethod: 'ach_pull', transferType: 'b2b' }))).toBe('sandbox');
  });

  it('partner-pulled before any provider: ach_pull and bank_pull are partner_pull', () => {
    expect(fundingClassOf(transfer({ fundingMethod: 'ach_pull', transferType: 'b2b' }))).toBe('partner_pull');
    expect(fundingClassOf(transfer({ fundingMethod: 'bank_pull', transferType: 'b2b' }))).toBe('partner_pull');
    expect(fundingClassOf(transfer({ fundingMethod: 'bank_pull', fundingRef: 'mockfund-y', environment: 'live' }))).toBe('partner_pull');
    expect(fundingClassOf(transfer({ fundingMethod: 'ach_pull', fundingProvider: 'stripe' }))).toBe('partner_pull');
  });

  it('stripe: provider stripe, or an intent bound with the provider absent', () => {
    expect(fundingClassOf(transfer({ fundingProvider: 'stripe' }))).toBe('stripe');
    expect(fundingClassOf(transfer({ fundingProvider: 'stripe', fundingIntentRef: 'pi_1', fundingState: 'pending' }))).toBe('stripe');
    expect(fundingClassOf(transfer({ fundingIntentRef: 'pi_2' }))).toBe('stripe');
    expect(fundingClassOf(transfer({ fundingProvider: 'mock', fundingIntentRef: 'pi_3' }))).toBe('stripe');
  });

  it('mock: provider mock, or provider absent with a fundingRef (an older build charged it)', () => {
    expect(fundingClassOf(transfer({ fundingProvider: 'mock', fundingRef: 'mockfund-fc_t1' }))).toBe('mock');
    expect(fundingClassOf(transfer({ fundingProvider: 'mock' }))).toBe('mock');
    expect(fundingClassOf(transfer({ fundingRef: 'mockfund-fc_t1' }))).toBe('mock');
    expect(fundingClassOf(transfer({ fundingRef: 'mockfund-fc_t1', environment: 'live' }))).toBe('mock');
  });

  it('never the prefix: stripe with a mockfund- ref is stripe; no provider with a pi_ ref is mock', () => {
    expect(fundingClassOf(transfer({ fundingProvider: 'stripe', fundingRef: 'mockfund-x' }))).toBe('stripe');
    expect(fundingClassOf(transfer({ fundingRef: 'pi_123' }))).toBe('mock');
  });

  it('partner_collected: no provider, no ref, no intent (a Partner API confirm)', () => {
    expect(fundingClassOf(transfer())).toBe('partner_collected');
    expect(fundingClassOf(transfer({ environment: 'live', fundingMethod: 'debit_card' }))).toBe('partner_collected');
  });
});

// Fix pack 5 T14 (P17 match rule, G14b): the OWNER's recorded funding mode.
describe('fundingModeMatches (T14)', () => {
  const rec = (mode: FundingModeRecord['mode']): FundingModeRecord => ({ mode, setBy: 'ops', setAt: daysAgo(1) });
  it('partner_pull matches any record and none', () => {
    expect(fundingModeMatches('partner_pull', undefined)).toBe(true);
    expect(fundingModeMatches('partner_pull', rec('partner_collected'))).toBe(true);
    expect(fundingModeMatches('partner_pull', rec('partner_psp'))).toBe(true);
  });
  it('stripe needs partner_psp', () => {
    expect(fundingModeMatches('stripe', rec('partner_psp'))).toBe(true);
    expect(fundingModeMatches('stripe', rec('partner_collected'))).toBe(false);
  });
  it('partner_collected needs partner_collected', () => {
    expect(fundingModeMatches('partner_collected', rec('partner_collected'))).toBe(true);
    expect(fundingModeMatches('partner_collected', rec('partner_psp'))).toBe(false);
  });
  it('a missing record mismatches every non-pull class', () => {
    for (const c of ['stripe', 'partner_collected', 'mock', 'sandbox'] as const) expect(fundingModeMatches(c, undefined)).toBe(false);
  });
});

// Review round 1 RF1: on a ROUTED row the owner collected the money but the
// settlement partner's rail would get the reverse, so the class is refused there
// until the owner decides who returns the money.
describe('refundWithoutCharge (T15, review round 1 RF1)', { retry: 0 }, () => {
  const pc = (over: Partial<Transfer> = {}) =>
    ({ environment: 'live', fundingMethod: 'bank_transfer', partnerId: 'acme', ...over }) as Transfer;
  it('true only for a real-money partner-collected row that is not routed', () => {
    expect(refundWithoutCharge(pc(), true)).toBe(true);
    expect(refundWithoutCharge(pc(), false)).toBe(false);
    expect(refundWithoutCharge(pc({ fundingRef: 'mockfund-x' }), true)).toBe(false);
  });
  it('a routed row (settlementPartnerId set and not the owner) is refused; settlementPartnerId = the owner is not routed', () => {
    expect(refundWithoutCharge(pc({ settlementPartnerId: 'railp' }), true)).toBe(false);
    expect(refundWithoutCharge(pc({ settlementPartnerId: 'acme' }), true)).toBe(true);
    expect(isRoutedRow(pc({ settlementPartnerId: 'railp' }))).toBe(true);
    expect(isRoutedRow(pc({ settlementPartnerId: 'acme' }))).toBe(false);
    expect(isRoutedRow(pc())).toBe(false);
  });
});
