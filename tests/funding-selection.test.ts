/**
 * Program-Fix 7 — which funding provider a transfer uses. Flag OFF (or no
 * partner Stripe config) ⇒ the mock, exactly as before. The non-custodial and
 * safety refusals are enforced HERE, not only in docs:
 *  - SmartRemit's own 'default' tenant never charges through Stripe (that
 *    would make SmartRemit the merchant of record — custodial);
 *  - a ROUTED transfer (settlementPartnerId) never charges through Stripe
 *    (funds at one licensee, payout at another);
 *  - a sandbox ('test') transfer and every B2B transfer keep today's path;
 *  - a Stripe config without a secret key fails closed.
 */
import { describe, it, expect } from 'vitest';
import {
  selectFundingProvider,
  refundProviderFor,
  MockFundingProvider,
} from '@/lib/providers/funding-provider';
import { StripeFundingProvider } from '@/lib/providers/stripe-funding-provider';
import type { Transfer } from '@/lib/types';

// Fix pack 5 T16 (P16): only a restricted key is ever used.
const KEY = ['rk', 'test', 'unitonly'].join('_');
const STRIPE = { providerType: 'stripe' as const, secretKey: KEY, webhookSecrets: ['w'] };

function t(o: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tx', phone: '1', amountUsd: 10, feeUsd: 0, totalChargeUsd: 10, fxRate: 1, amountInr: 10,
    recipientName: 'r', recipientPhone: '', payoutMethod: 'bank', payoutDestination: '',
    fundingMethod: 'bank_transfer', complianceStatus: 'cleared', complianceReasons: [],
    status: 'awaiting_payment', createdAt: '2026-01-01T00:00:00Z', sourceCountry: 'US',
    sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR', partnerId: 'acme',
    amountSource: 10, feeSource: 0, totalChargeSource: 10, ...o,
  };
}

describe('selectFundingProvider', () => {
  it('flag OFF ⇒ mock even with a full Stripe config', () => {
    const s = selectFundingProvider(t(), { enabled: false, config: STRIPE });
    expect(s.kind).toBe('mock');
    expect(s.kind === 'mock' && s.provider).toBeInstanceOf(MockFundingProvider);
  });

  it('flag ON but no partner config / other provider ⇒ mock', () => {
    expect(selectFundingProvider(t(), { enabled: true, config: null }).kind).toBe('mock');
    expect(selectFundingProvider(t(), { enabled: true, config: {} }).kind).toBe('mock');
  });

  it('flag ON + partner Stripe config ⇒ stripe', () => {
    const s = selectFundingProvider(t(), { enabled: true, config: STRIPE });
    expect(s.kind).toBe('stripe');
    expect(s.kind === 'stripe' && s.provider).toBeInstanceOf(StripeFundingProvider);
  });

  it('refuses Stripe on SmartRemit\'s own default tenant (never merchant of record)', () => {
    expect(selectFundingProvider(t({ partnerId: 'default' }), { enabled: true, config: STRIPE })).toEqual({
      kind: 'refused', reason: 'default_tenant',
    });
  });

  it('refuses Stripe on a routed transfer', () => {
    expect(selectFundingProvider(t({ settlementPartnerId: 'other' }), { enabled: true, config: STRIPE })).toEqual({
      kind: 'refused', reason: 'routed',
    });
  });

  it('refuses a Stripe config with no secret key (fail closed, never falls back to the mock)', () => {
    expect(selectFundingProvider(t(), { enabled: true, config: { providerType: 'stripe', secretKey: '' } })).toEqual({
      kind: 'refused', reason: 'unconfigured',
    });
  });

  it('fix pack 5 T16 (P16): an unrestricted or malformed key is refused with unrestricted_key', () => {
    const bad = [
      ['sk', 'test', 'x'].join('_'), ['sk', 'live', 'x'].join('_'), ['sk', 'org', 'x'].join('_'),
      ['pk', 'test', 'x'].join('_'), ['rk', 'x'].join('_'), ['rk', 'test', ''].join('_'),
      ['rk', 'test', 'a b'].join('_'), ' ' + ['rk', 'test', 'abc'].join('_'),
    ];
    for (const secretKey of bad) {
      expect(selectFundingProvider(t(), { enabled: true, config: { providerType: 'stripe', secretKey } })).toEqual({
        kind: 'refused', reason: 'unrestricted_key',
      });
    }
    for (const secretKey of [['rk', 'live', 'abc'].join('_'), ['rk', 'test', 'abc'].join('_')]) {
      expect(selectFundingProvider(t(), { enabled: true, config: { providerType: 'stripe', secretKey } }).kind).toBe('stripe');
    }
  });

  it('fix pack 5 T16: the default-tenant and routed refusals still win over the key check; flag off or no Stripe config never inspects the key', () => {
    const sk = { providerType: 'stripe' as const, secretKey: ['sk', 'test', 'x'].join('_') };
    expect(selectFundingProvider(t({ partnerId: 'default' }), { enabled: true, config: sk })).toEqual({ kind: 'refused', reason: 'default_tenant' });
    expect(selectFundingProvider(t({ settlementPartnerId: 'other' }), { enabled: true, config: sk })).toEqual({ kind: 'refused', reason: 'routed' });
    expect(selectFundingProvider(t(), { enabled: false, config: sk }).kind).toBe('mock');
    expect(selectFundingProvider(t({ environment: 'test' }), { enabled: true, config: sk }).kind).toBe('mock');
    expect(selectFundingProvider(t(), { enabled: true, config: {} }).kind).toBe('mock');
  });

  it('sandbox and B2B transfers keep the mock / partner-pulled path', () => {
    expect(selectFundingProvider(t({ environment: 'test' }), { enabled: true, config: STRIPE }).kind).toBe('mock');
    expect(selectFundingProvider(t({ transferType: 'b2b' }), { enabled: true, config: STRIPE }).kind).toBe('mock');
  });

  it('a transfer already bound to a Stripe intent stays on Stripe while the flag is ON', () => {
    const s = selectFundingProvider(t({ fundingProvider: 'stripe', fundingIntentRef: 'pi_1' }), { enabled: true, config: STRIPE });
    expect(s.kind).toBe('stripe');
  });

  it('a transfer already bound to a Stripe intent is REFUSED (not mocked) when the flag goes OFF', () => {
    expect(selectFundingProvider(t({ fundingProvider: 'stripe', fundingIntentRef: 'pi_1' }), { enabled: false, config: STRIPE })).toEqual({
      kind: 'refused', reason: 'disabled_with_intent',
    });
  });
});

describe('refundProviderFor', () => {
  it('routes by the TRANSFER\'s recorded provider, not the flag: stripe rows never get a mock refund ref', async () => {
    const p = refundProviderFor(t({ fundingProvider: 'stripe', fundingRef: 'pi_1' }));
    await expect(p.refund(t({ fundingProvider: 'stripe' }))).rejects.toThrow();
  });

  it('every other row keeps the mock refund (byte-identical)', async () => {
    const p = refundProviderFor(t({ fundingRef: 'mockfund-tx' }));
    expect(await p.refund(t())).toEqual({ refundRef: 'mockrefund-tx' });
  });
});
