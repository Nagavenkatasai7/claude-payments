import { describe, it, expect } from 'vitest';
import { buildComplianceBlock } from '@/lib/providers/http-payment-provider';
import type { Customer, Transfer } from '@/lib/types';

// Program-Fix 31 PR B (rail-10): the additive `compliance` block the worker
// spreads into the signed settlement instruction. Pure: no DB, no clock.

const NOW = new Date('2026-09-23T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'ic_t1', phone: '15550000001', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: 'Ani', recipientPhone: '919800000001',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: daysAgo(1), paidAt: daysAgo(1), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

// A customer with EVERY sensitive field populated, so the "never on the wire"
// checks below cannot pass trivially.
function customer(over: Partial<Customer> = {}): Customer {
  return {
    senderPhone: '15550000001', firstSeenAt: daysAgo(30), kycStatus: 'verified',
    kycVerifiedAt: daysAgo(20), fullName: 'Test Sender Person',
    dateOfBirth: '1980-01-02', residentialAddress: '1 Secret Lane, Springfield',
    govIdType: 'passport', govIdNumber: 'X99887766', idLast4: '7766', idDocType: 'passport',
    email: 'enc:v1:emailblob', senderCountry: 'US', partnerId: 'acme',
    createdAt: daysAgo(30), updatedAt: daysAgo(1),
    ...over,
  } as Customer;
}

const FORBIDDEN_KEYS = ['payout', 'destination', 'dateOfBirth', 'date_of_birth', 'residentialAddress',
  'residential_address', 'address', 'govIdNumber', 'gov_id_number', 'email', 'dob'];

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.push(k); allKeys(x, out); }
  }
  return out;
}

describe('buildComplianceBlock (pure, Program-Fix 31)', { retry: 0 }, () => {
  it('a cleared, verified individual: version 1, originator identity (id_last4 only), beneficiary, purpose, kyc T1, screening', () => {
    const block = buildComplianceBlock(
      transfer({ recipientLegalName: 'Anita Legal', relationship: 'parent', purpose: 'family_support' }),
      customer(), NOW, { kycGateActive: true },
    );
    expect(block).toEqual({
      version: 1,
      originator: {
        entity_type: 'individual', name: 'Test Sender Person', country: 'US', phone: '15550000001',
        id_type: 'passport', id_last4: '7766',
      },
      beneficiary: { entity_type: 'individual', name: 'Anita Legal', relationship: 'parent', country: 'IN' },
      purpose: 'family_support',
      purpose_code: null,
      kyc: { status: 'verified', tier: 'T1', verified_at: daysAgo(20) },
      screening: { status: 'cleared', reasons: [], screened_at: daysAgo(1) },
      edd_required: false,
    });
  });

  it('never carries payout / destination / DOB / address / full ID number / email — by key or by value', () => {
    const block = buildComplianceBlock(transfer(), customer(), NOW, { kycGateActive: true });
    const keys = allKeys(block);
    for (const k of FORBIDDEN_KEYS) expect(keys).not.toContain(k);
    const raw = JSON.stringify(block);
    for (const v of ['1980-01-02', 'Secret Lane', 'X99887766', 'emailblob', '123456789012', 'HDFC0001234']) {
      expect(raw).not.toContain(v);
    }
  });

  it('display name is used for the beneficiary only when no legal name was captured', () => {
    const block = buildComplianceBlock(transfer(), customer(), NOW, { kycGateActive: true });
    expect(block.beneficiary).toEqual({ entity_type: 'individual', name: 'Ani', relationship: null, country: 'IN' });
    expect(block.purpose).toBeNull();
    expect(block.purpose_code).toBeNull();
  });

  it('T0 inside the observation window; tier is null when the KYC gate is unknown', () => {
    const fresh = customer({ firstSeenAt: daysAgo(1), kycStatus: 'not_started', kycVerifiedAt: undefined });
    expect(buildComplianceBlock(transfer(), fresh, NOW, { kycGateActive: true }).kyc)
      .toEqual({ status: 'not_started', tier: 'T0', verified_at: null });
    expect(buildComplianceBlock(transfer(), customer(), NOW).kyc.tier).toBeNull();
  });

  it('a delegated-KYC partner (gate off) never labels an unverified sender Suspended', () => {
    const old = customer({ kycStatus: 'not_started', kycVerifiedAt: undefined });
    expect(buildComplianceBlock(transfer(), old, NOW, { kycGateActive: false }).kyc.tier).toBe('T1');
    expect(buildComplianceBlock(transfer(), old, NOW, { kycGateActive: true }).kyc.tier).toBe('Suspended');
  });

  it('no customer row: the instruction still carries a block with originator.name null (never blocked)', () => {
    const block = buildComplianceBlock(transfer(), null, NOW, { kycGateActive: true });
    expect(block.originator).toEqual({
      entity_type: 'individual', name: null, country: 'US', phone: '15550000001', id_type: null, id_last4: null,
    });
    expect(block.kyc).toEqual({ status: null, tier: null, verified_at: null });
  });

  it('B2B business sender: originator is the business (name = senderBusinessName, no personal ID); business payee', () => {
    const block = buildComplianceBlock(
      transfer({
        transferType: 'b2b', senderEntityType: 'business', recipientEntityType: 'business',
        senderBusinessName: 'Globex Payer LLC', recipientBusinessName: 'Seller Pvt Ltd',
      }),
      customer(), NOW, { kycGateActive: true },
    );
    expect(block.originator).toEqual({
      entity_type: 'business', name: 'Globex Payer LLC', country: 'US', phone: '15550000001', id_type: null, id_last4: null,
    });
    expect(block.beneficiary).toMatchObject({ entity_type: 'business', name: 'Seller Pvt Ltd' });
    expect(JSON.stringify(block)).not.toContain('Test Sender Person');
  });

  it('ROUTED (settlementPartnerId set): originator null + routed true; no sender identity anywhere in the block', () => {
    const block = buildComplianceBlock(transfer({ settlementPartnerId: 'railp' }), customer(), NOW, { kycGateActive: true });
    expect(block.originator).toBeNull();
    expect(block.routed).toBe(true);
    const raw = JSON.stringify(block);
    expect(raw).not.toContain('Test Sender Person');
    expect(raw).not.toContain('15550000001');
    expect(raw).not.toContain('7766');
  });

  it('an unrouted block carries no routed key', () => {
    expect('routed' in buildComplianceBlock(transfer(), customer(), NOW, { kycGateActive: true })).toBe(false);
  });

  it('omitOriginator (the worker fail-open path): originator null, the rest still built from the transfer', () => {
    const block = buildComplianceBlock(transfer({ eddRequired: true, purpose: 'gift' }), null, NOW, { omitOriginator: true });
    expect(block.originator).toBeNull();
    expect(block.purpose).toBe('gift');
    expect(block.edd_required).toBe(true);
    expect('routed' in block).toBe(false);
  });

  it('screening: flagged reasons pass through; fix 14 evidence adds list source/version/decision + its screenedAt', () => {
    const t = transfer({ complianceStatus: 'flagged', complianceReasons: ['Large transfer amount.'] });
    const block = buildComplianceBlock(t, customer(), NOW, {
      kycGateActive: true,
      screening: { listSource: 'ofac-sdn', listVersion: '2026-09-01', decision: 'clear', screenedAt: daysAgo(2) },
    });
    expect(block.screening).toEqual({
      status: 'flagged', reasons: ['Large transfer amount.'], screened_at: daysAgo(2),
      list_source: 'ofac-sdn', list_version: '2026-09-01', decision: 'clear',
    });
  });

  it('screening: no evidence ⇒ list fields are OMITTED (never a guessed list name)', () => {
    const block = buildComplianceBlock(transfer(), customer(), NOW, { kycGateActive: true });
    expect(Object.keys(block.screening).sort()).toEqual(['reasons', 'screened_at', 'status']);
  });
});
