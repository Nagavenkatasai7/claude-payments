import { describe, it, expect } from 'vitest';
import { buildComplianceBlock, type ComplianceScreeningRef } from '@/lib/providers/http-payment-provider';
import type { Customer, Transfer } from '@/lib/types';

// Fix pack 5 T5 (P10): the EXACT key sets and key order of the signed
// instruction's `compliance` block, version 2. Pure: no DB, no clock.
// T12 (compliance.funding), T23 (originator address / date_of_birth) and T29
// (screening.lists) extend this file with their own cases; keep the order pins.

const NOW = new Date(Date.now());
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

const SENDER_HASH = 'a1'.repeat(32);
const RECIPIENT_HASH = 'b2'.repeat(32);
const SENDER_NAME = 'Schema Sender Person';
const RECIPIENT_NAME = 'Schema Recipient Person';

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    id: 'cbs_t1', phone: '15550000009', amountUsd: 200, feeUsd: 5, totalChargeUsd: 205,
    fxRate: 83, amountInr: 16600, recipientName: RECIPIENT_NAME, recipientPhone: '919800000009',
    payoutMethod: 'bank', payoutDestination: '123456789012|HDFC0001234', fundingMethod: 'bank_transfer',
    status: 'paid', complianceStatus: 'cleared', complianceReasons: [],
    createdAt: daysAgo(1), paidAt: daysAgo(1), partnerId: 'acme',
    sourceCountry: 'US', sourceCurrency: 'USD', destinationCountry: 'IN', destinationCurrency: 'INR',
    amountSource: 200, feeSource: 5, totalChargeSource: 205,
    ...over,
  } as Transfer;
}

function customer(over: Partial<Customer> = {}): Customer {
  return {
    senderPhone: '15550000009', firstSeenAt: daysAgo(30), kycStatus: 'verified',
    kycVerifiedAt: daysAgo(20), fullName: SENDER_NAME, idLast4: '1234', idDocType: 'passport',
    senderCountry: 'US', partnerId: 'acme', createdAt: daysAgo(30), updatedAt: daysAgo(1),
    ...over,
  } as Customer;
}

/** A reference as screeningRef builds it from evidence with one sender and one recipient party. */
function refFromEvidence(): ComplianceScreeningRef {
  const parties = [
    { role: 'sender' as const, inputHash: SENDER_HASH, matched: false, matchScore: 0 },
    { role: 'recipient' as const, inputHash: RECIPIENT_HASH, matched: false, matchScore: 0 },
  ];
  return {
    listSource: 'ofac-sdn', listVersion: 'v-schema', decision: 'clear', screenedAt: daysAgo(1),
    namesScreened: {
      sender: parties.filter((p) => p.role === 'sender').length,
      recipient: parties.filter((p) => p.role === 'recipient').length,
    },
  };
}

const TOP_UNROUTED = ['version', 'originator', 'beneficiary', 'purpose', 'purpose_code', 'kyc', 'screening', 'edd_required'];

describe('compliance block schema, version 2 (fix pack 5 T5, P10)', { retry: 0 }, () => {
  it('unrouted, no evidence: version 2; exact top-level keys; screening keys [status, reasons, screened_at]', () => {
    const block = buildComplianceBlock(transfer(), customer(), NOW, { kycGateActive: true });
    expect(block.version).toBe(2);
    expect(Object.keys(block)).toEqual(TOP_UNROUTED);
    expect(Object.keys(block.screening)).toEqual(['status', 'reasons', 'screened_at']);
    expect(Object.keys(block.originator!)).toEqual(['entity_type', 'name', 'country', 'phone', 'id_type', 'id_last4']);
    expect(Object.keys(block.beneficiary)).toEqual(['entity_type', 'name', 'relationship', 'country']);
    expect(Object.keys(block.kyc)).toEqual(['status', 'tier', 'verified_at']);
  });

  it('routed: keys [version, routed, originator, ...]; originator null', () => {
    const block = buildComplianceBlock(transfer({ settlementPartnerId: 'railp' }), customer(), NOW, { kycGateActive: true });
    expect(Object.keys(block)).toEqual(['version', 'routed', ...TOP_UNROUTED.slice(1)]);
    expect(block.routed).toBe(true);
    expect(block.originator).toBeNull();
    expect(block.version).toBe(2);
  });

  it('with evidence: screening keys [status, reasons, screened_at, list_source, list_version, decision, names_screened]; names_screened = { sender, recipient } integers', () => {
    const block = buildComplianceBlock(transfer(), customer(), NOW, { kycGateActive: true, screening: refFromEvidence() });
    expect(Object.keys(block)).toEqual(TOP_UNROUTED);
    expect(Object.keys(block.screening)).toEqual([
      'status', 'reasons', 'screened_at', 'list_source', 'list_version', 'decision', 'names_screened',
    ]);
    const counts = (block.screening as { names_screened: Record<string, unknown> }).names_screened;
    expect(Object.keys(counts)).toEqual(['sender', 'recipient']);
    expect(counts).toEqual({ sender: 1, recipient: 1 });
    expect(Number.isInteger(counts.sender)).toBe(true);
    expect(Number.isInteger(counts.recipient)).toBe(true);
  });

  it('names_screened carries counts only: the serialised block contains no party hash and no screened name', () => {
    const block = buildComplianceBlock(transfer({ settlementPartnerId: 'railp' }), customer(), NOW, {
      kycGateActive: true, screening: refFromEvidence(),
    });
    const raw = JSON.stringify((block.screening as { names_screened: unknown }).names_screened);
    expect(raw).toBe('{"sender":1,"recipient":1}');
    const whole = JSON.stringify(block);
    expect(whole).not.toContain(SENDER_HASH);
    expect(whole).not.toContain(RECIPIENT_HASH);
    expect(whole).not.toContain(SENDER_NAME);
  });

  it('version is 2 on every rail-independent input (business sender, no customer)', () => {
    const business = buildComplianceBlock(
      transfer({ transferType: 'b2b', senderEntityType: 'business', senderBusinessName: 'Globex Payer LLC' }),
      null, NOW,
    );
    expect(business.version).toBe(2);
    expect(Object.keys(business)).toEqual(TOP_UNROUTED);
    expect(buildComplianceBlock(transfer(), null, NOW).version).toBe(2);
  });
});
