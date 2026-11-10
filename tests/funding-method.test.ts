// Pack 2 review round 3 (S2: M2, M6) and round 4 (S4: N1, P1): ONE pure
// answer to "what happened to the sender's money" for the sanctions block
// notices and the match alerts.
import { describe, it, expect } from 'vitest';
import { isPartnerPulled, senderChargeState } from '@/lib/funding-method';
import type { FundingMethod, TransferStatus } from '@/lib/types';

describe('isPartnerPulled', () => {
  it('is true for ach_pull and bank_pull only', () => {
    expect(isPartnerPulled('ach_pull')).toBe(true);
    expect(isPartnerPulled('bank_pull')).toBe(true);
    expect(isPartnerPulled('credit_card')).toBe(false);
    expect(isPartnerPulled('debit_card')).toBe(false);
    expect(isPartnerPulled('bank_transfer')).toBe(false);
  });
});

describe('senderChargeState', () => {
  const CUSTODIAL: FundingMethod[] = ['credit_card', 'debit_card', 'bank_transfer'];
  const PULLED: FundingMethod[] = ['ach_pull', 'bank_pull'];
  const ALL_STATUSES: TransferStatus[] = ['awaiting_payment', 'paid', 'in_review', 'delivered', 'cancelled', 'blocked'];
  // The statuses a row reaches only after a payment was confirmed: in_review
  // (beginHold: markInReviewIfAwaiting, the held "payment received" message),
  // paid and delivered.
  const RECEIVED: TransferStatus[] = ['in_review', 'paid', 'delivered'];
  const NOT_RECEIVED: TransferStatus[] = ['awaiting_payment', 'cancelled', 'blocked'];

  type Row = [string, FundingMethod, string | null | undefined, TransferStatus, ReturnType<typeof senderChargeState>];
  const table: Row[] = [
    // A charge reference on a custodial method: charged, whatever the status.
    ...CUSTODIAL.flatMap((m) => ALL_STATUSES.map((s): Row => [`${m} ref ${s}`, m, 'pi_1', s, 'charged'])),
    // No charge reference, custodial, a payment was confirmed (the Partner-API confirm): partner_collected.
    ...CUSTODIAL.flatMap((m) => RECEIVED.flatMap((s): Row[] => [
      [`${m} null ${s}`, m, null, s, 'partner_collected'],
      [`${m} undefined ${s}`, m, undefined, s, 'partner_collected'],
      [`${m} empty ${s}`, m, '', s, 'partner_collected'],
    ])),
    // No charge reference and no confirmed payment: none.
    ...CUSTODIAL.flatMap((m) => NOT_RECEIVED.map((s): Row => [`${m} null ${s}`, m, null, s, 'none'])),
    // Partner-pulled: SmartRemit captures nothing, whatever the status or ref.
    ...PULLED.flatMap((m) => ALL_STATUSES.flatMap((s): Row[] => [
      [`${m} null ${s}`, m, null, s, 'none'],
      [`${m} ref ${s}`, m, 'pull_1', s, 'none'],
    ])),
  ];

  it.each(table)('%s', (_label, fundingMethod, fundingRef, status, want) => {
    expect(senderChargeState({ fundingMethod, fundingRef, status })).toBe(want);
  });

  // The Partner-API confirm call is the partner's attestation that it
  // collected the funds, so a confirm-stage block of an awaiting row says so.
  it.each([
    ['credit_card', null, 'partner_collected'],
    ['bank_transfer', null, 'partner_collected'],
    ['bank_transfer', 'pi_1', 'charged'],
    ['ach_pull', null, 'none'],
    ['bank_pull', 'pull_1', 'none'],
  ] as const)('partnerConfirmed: %s ref %s on an awaiting row is %s', (fundingMethod, fundingRef, want) => {
    expect(senderChargeState({ fundingMethod, fundingRef, status: 'awaiting_payment' }, { partnerConfirmed: true })).toBe(want);
  });
});
