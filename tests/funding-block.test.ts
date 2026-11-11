import { describe, it, expect } from 'vitest';
import {
  buildComplianceBlock,
  buildSettlementInstruction,
  fundingBlockFor,
} from '@/lib/providers/http-payment-provider';
import type { Customer, Transfer } from '@/lib/types';

// Fix pack 5 T12 (P14): compliance.funding, built purely from the row.
// The B2B top-level `funding` key and buildSettlementInstruction stay
// byte-identical (golden strings captured from the code BEFORE T12).

const NOW = new Date(Date.now());

// Fixed timestamps here are not compared with any time window: they only make
// the golden strings stable.
function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'fb_t1', phone: '15550000021', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Fund Block Recipient', recipientPhone: '919800000021',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: '2026-01-01T00:00:00.000Z', paidAt: '2026-01-01T00:00:00.000Z', partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

const b2bAch = (over: Partial<Transfer> = {}) => transfer({
  id: 'fb_ach', transferType: 'b2b', fundingMethod: 'ach_pull', achTokenRef: 'achtok_secret_1',
  senderEntityType: 'business', recipientEntityType: 'business',
  senderBusinessName: 'Payer Co', recipientBusinessName: 'Payee Co', clientReference: 'PO-1',
  ...over,
});
const b2bBank = (over: Partial<Transfer> = {}) => transfer({
  id: 'fb_bank', transferType: 'b2b', fundingMethod: 'bank_pull', achTokenRef: 'banktok_secret_2',
  senderEntityType: 'business', recipientEntityType: 'business',
  senderBusinessName: 'Payer Co', recipientBusinessName: 'Payee Co',
  sourceCountry: 'GB', sourceCurrency: 'GBP', amountSource: 150, totalChargeSource: 160,
  ...over,
});

const GOLDEN_CONSUMER = '{"reference":"fb_t1","partner_id":"acme","corridor":{"source":"US","destination":"IN"},"payout":{"rail":"bank","destination":"123456789012|HDFC0001234"},"recipient":{"name":"Fund Block Recipient","phone":"919800000021"},"amount":{"source":200,"currency":"USD","destination":16600,"destination_currency":"INR","fx_rate":83},"client_reference":"ORD-9"}';
const GOLDEN_ACH = '{"reference":"fb_ach","partner_id":"acme","corridor":{"source":"US","destination":"IN"},"payout":{"rail":"bank","destination":"123456789012|HDFC0001234"},"recipient":{"name":"Fund Block Recipient","phone":"919800000021"},"amount":{"source":200,"currency":"USD","destination":16600,"destination_currency":"INR","fx_rate":83},"client_reference":"PO-1","funding":{"method":"ach_debit","token":"achtok_secret_1"},"parties":{"sender_entity_type":"business","recipient_entity_type":"business","sender_business_name":"Payer Co","recipient_business_name":"Payee Co"}}';
const GOLDEN_BANK = '{"reference":"fb_bank","partner_id":"acme","corridor":{"source":"GB","destination":"IN"},"payout":{"rail":"bank","destination":"123456789012|HDFC0001234"},"recipient":{"name":"Fund Block Recipient","phone":"919800000021"},"amount":{"source":150,"currency":"GBP","destination":16600,"destination_currency":"INR","fx_rate":83},"funding":{"method":"bank_debit","token":"banktok_secret_2","amount":160,"currency":"GBP","country":"GB"},"parties":{"sender_entity_type":"business","recipient_entity_type":"business","sender_business_name":"Payer Co","recipient_business_name":"Payee Co"}}';

function customer(): Customer {
  return {
    senderPhone: '15550000021', firstSeenAt: '2026-01-01T00:00:00.000Z', kycStatus: 'verified',
    kycVerifiedAt: '2026-01-01T00:00:00.000Z', fullName: 'Fund Block Sender',
    dateOfBirth: '1980-01-02', residentialAddress: '1 Secret Lane', idLast4: '4321', idDocType: 'passport',
    senderCountry: 'US', partnerId: 'acme', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  } as Customer;
}

describe('fundingBlockFor (fix pack 5 T12, P14)', { retry: 0 }, () => {
  it('fundingBlockFor per class: exact block for each class', () => {
    const demo = { mode: 'demo', provider: 'mock', reference: null, status: 'captured', amount: 205, currency: 'USD' };
    expect(fundingBlockFor(transfer({ environment: 'test', fundingProvider: 'stripe', fundingRef: 'pi_9' }))).toEqual(demo);
    expect(fundingBlockFor(transfer({ fundingProvider: 'mock', fundingRef: 'mockfund-fb_t1' }))).toEqual(demo);
    expect(fundingBlockFor(transfer({ fundingRef: 'mockfund-fb_t1' }))).toEqual(demo);

    expect(fundingBlockFor(transfer({ fundingProvider: 'stripe', fundingIntentRef: 'pi_1', fundingRef: 'pi_1', fundingState: 'succeeded' })))
      .toEqual({ mode: 'partner_psp', provider: 'stripe', reference: 'pi_1', status: 'succeeded', amount: 205, currency: 'USD' });
    expect(fundingBlockFor(transfer({ fundingProvider: 'stripe', fundingIntentRef: 'pi_2', fundingState: 'pending' })))
      .toEqual({ mode: 'partner_psp', provider: 'stripe', reference: 'pi_2', status: 'pending', amount: 205, currency: 'USD' });
    expect(fundingBlockFor(transfer({ fundingIntentRef: 'pi_3' })))
      .toEqual({ mode: 'partner_psp', provider: 'stripe', reference: 'pi_3', status: 'pending', amount: 205, currency: 'USD' });

    expect(fundingBlockFor(transfer({ settlementPartnerId: 'rail_b', fundingProvider: 'stripe', fundingRef: 'pi_1', fundingIntentRef: 'pi_1', fundingState: 'succeeded' })))
      .toEqual({ mode: 'partner_psp', provider: 'stripe', reference: null, status: 'succeeded', amount: 205, currency: 'USD' });

    expect(fundingBlockFor(transfer()))
      .toEqual({ mode: 'partner_collected', provider: 'partner', reference: null, status: 'partner_confirmed', amount: 205, currency: 'USD' });

    expect(fundingBlockFor(b2bAch()))
      .toEqual({ mode: 'partner_pull', provider: 'partner', reference: null, status: 'partner_pull', amount: 205, currency: 'USD' });
    expect(fundingBlockFor(b2bBank()))
      .toEqual({ mode: 'partner_pull', provider: 'partner', reference: null, status: 'partner_pull', amount: 160, currency: 'GBP' });
  });

  it('amount falls back to totalChargeUsd and currency to USD when the source fields are absent', () => {
    const t = transfer({ totalChargeSource: undefined, sourceCurrency: undefined } as unknown as Partial<Transfer>);
    expect(fundingBlockFor(t)).toMatchObject({ amount: 205, currency: 'USD' });
  });

  it('no personal data: no phone, name, account digits, token or client secret in any class', () => {
    const pii = {
      phone: '15550000777', recipientPhone: '919800000777', recipientName: 'Secret Recipient Name',
      recipientLegalName: 'Secret Legal Name', senderBusinessName: 'Secret Payer Biz', recipientBusinessName: 'Secret Payee Biz',
      payoutDestination: '998877665544|HDFC0009999', achTokenRef: 'tok_secret_pii', clientReference: 'ORD-SECRET',
    } as Partial<Transfer>;
    const cases = [
      transfer({ ...pii, environment: 'test' }),
      transfer({ ...pii, fundingProvider: 'mock', fundingRef: 'mockfund-x' }),
      transfer({ ...pii, fundingProvider: 'stripe', fundingIntentRef: 'pi_ok', fundingState: 'pending' }),
      transfer({ ...pii }),
      transfer({ ...pii, transferType: 'b2b', fundingMethod: 'ach_pull' }),
      transfer({ ...pii, transferType: 'b2b', fundingMethod: 'bank_pull' }),
    ];
    for (const t of cases) {
      const raw = JSON.stringify(fundingBlockFor(t));
      for (const v of ['15550000777', '919800000777', 'Secret', '998877665544', 'HDFC0009999', 'tok_secret_pii', 'ORD-SECRET', 'secret', 'client_secret']) {
        expect(raw).not.toContain(v);
      }
    }
  });

  it('buildComplianceBlock carries funding in P10 order', () => {
    for (const t of [transfer(), transfer({ settlementPartnerId: 'rail_b', fundingProvider: 'stripe', fundingRef: 'pi_1' }), b2bBank()]) {
      const block = buildComplianceBlock(t, customer(), NOW, { kycGateActive: true });
      expect(Object.keys(block).slice(-3)).toEqual(['screening', 'funding', 'edd_required']);
      expect(block.funding).toEqual(fundingBlockFor(t));
    }
  });

  it('buildSettlementInstruction is byte-identical (golden, captured before T12)', () => {
    expect(JSON.stringify(buildSettlementInstruction(transfer({ clientReference: 'ORD-9' })))).toBe(GOLDEN_CONSUMER);
    expect(JSON.stringify(buildSettlementInstruction(b2bAch()))).toBe(GOLDEN_ACH);
    expect(JSON.stringify(buildSettlementInstruction(b2bBank()))).toBe(GOLDEN_BANK);
    // A funded row (mock or Stripe) does not change the instruction either.
    expect(JSON.stringify(buildSettlementInstruction(transfer({ clientReference: 'ORD-9', fundingProvider: 'mock', fundingRef: 'mockfund-fb_t1' }))))
      .toBe(GOLDEN_CONSUMER);
  });
});
