import { describe, it, expect } from 'vitest';
import { CANCEL_REFUSAL, decideStaffCancel, showsStaffCancel } from '@/lib/dashboard-cancel-policy';
import type { FundingMethod, TransferStatus } from '@/lib/types';

// Phase 1 Task 5 / Program-Fix 9 / money-05. Staff Cancel commits NO effect
// (no refund, no reversal, no rail message), so it may only VOID an unfunded
// draft. This pure rule is shared by the server guard (dashboard-ops
// cancelTransfer), the transactions list and the B2B page.

const CUSTODIAL: FundingMethod[] = ['credit_card', 'debit_card', 'bank_transfer'];
const PULLED: FundingMethod[] = ['ach_pull', 'bank_pull'];

describe('decideStaffCancel', () => {
  it('VOIDS an unfunded draft: awaiting_payment with no fundingRef, for every funding method', () => {
    for (const fundingMethod of [...CUSTODIAL, ...PULLED]) {
      expect(decideStaffCancel({ status: 'awaiting_payment', fundingMethod })).toEqual({ kind: 'void' });
    }
  });

  it('REFUSES every in_review hold, charged or NOT: a hold is a compliance decision, so Reject (admin) is the path', () => {
    for (const fundingMethod of [...CUSTODIAL, ...PULLED]) {
      expect(decideStaffCancel({ status: 'in_review', fundingMethod }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.inReview });
    }
    expect(decideStaffCancel({ status: 'in_review', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' }))
      .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.inReview });
  });

  it('REFUSES every PAID custodial transfer, charged or not: steers to Refund (the rail was already told to pay out)', () => {
    for (const fundingMethod of CUSTODIAL) {
      expect(decideStaffCancel({ status: 'paid', fundingMethod, fundingRef: 'mockfund-x' }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.paid });
      expect(decideStaffCancel({ status: 'paid', fundingMethod }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.paid });
    }
  });

  it('REFUSES every PAID partner-pulled transfer: steers to Reverse (the signed instruction is live)', () => {
    for (const fundingMethod of PULLED) {
      expect(decideStaffCancel({ status: 'paid', fundingMethod }))
        .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.paidPartnerPulled });
    }
  });

  it('REFUSES a CHARGED awaiting_payment row: the funding-resume sweep settles or holds it', () => {
    expect(decideStaffCancel({ status: 'awaiting_payment', fundingMethod: 'debit_card', fundingRef: 'mockfund-x' }))
      .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.chargedAwaiting });
  });

  it('REFUSES blocked: a terminal compliance state is never rewritten', () => {
    expect(decideStaffCancel({ status: 'blocked', fundingMethod: 'credit_card' }))
      .toEqual({ kind: 'refuse', reason: CANCEL_REFUSAL.blocked });
  });

  it('is a NO-OP on delivered and cancelled (a second click is silent, never an error)', () => {
    expect(decideStaffCancel({ status: 'delivered', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' })).toEqual({ kind: 'noop' });
    expect(decideStaffCancel({ status: 'cancelled', fundingMethod: 'ach_pull' })).toEqual({ kind: 'noop' });
  });

  it('decides every TransferStatus (tsc forces a case for any new status; nothing falls through to void)', () => {
    const all: TransferStatus[] = ['awaiting_payment', 'paid', 'in_review', 'delivered', 'cancelled', 'blocked'];
    const voided = all.filter((status) => decideStaffCancel({ status, fundingMethod: 'credit_card' }).kind === 'void');
    expect(voided).toEqual(['awaiting_payment']);
  });
});

describe('CANCEL_REFUSAL: the copy contract', () => {
  it('names the action that actually returns money or decides the hold', () => {
    expect(CANCEL_REFUSAL.paid).toMatch(/use Refund/i);
    expect(CANCEL_REFUSAL.paidPartnerPulled).toMatch(/use Reverse/i);
    expect(CANCEL_REFUSAL.inReview).toMatch(/use Reject/i);
    expect(CANCEL_REFUSAL.inReview).toMatch(/admin/i);
    expect(CANCEL_REFUSAL.chargedAwaiting).toMatch(/already been charged/i);
    expect(CANCEL_REFUSAL.blocked).toMatch(/blocked/i);
    expect(CANCEL_REFUSAL.changed).toMatch(/changed concurrently/i);
  });

  it('is staff-safe: no digit runs, no email, nothing that could carry PII', () => {
    for (const msg of Object.values(CANCEL_REFUSAL)) expect(msg).not.toMatch(/@|\d{4,}/);
  });
});

describe('showsStaffCancel: the transactions list offers Cancel only where the server would void it', () => {
  it('true ONLY for an uncharged awaiting_payment row (paid rows lose the button: money-05)', () => {
    expect(showsStaffCancel({ status: 'awaiting_payment', fundingMethod: 'credit_card' })).toBe(true);
    expect(showsStaffCancel({ status: 'awaiting_payment', fundingMethod: 'ach_pull' })).toBe(true);
    expect(showsStaffCancel({ status: 'awaiting_payment', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' })).toBe(false);
    expect(showsStaffCancel({ status: 'paid', fundingMethod: 'credit_card', fundingRef: 'mockfund-x' })).toBe(false);
    expect(showsStaffCancel({ status: 'paid', fundingMethod: 'ach_pull' })).toBe(false);
    // holds are decided on the Compliance page (Release / Reject), never by Cancel
    expect(showsStaffCancel({ status: 'in_review', fundingMethod: 'credit_card' })).toBe(false);
    expect(showsStaffCancel({ status: 'in_review', fundingMethod: 'bank_pull' })).toBe(false);
    for (const status of ['delivered', 'cancelled', 'blocked'] as const) {
      expect(showsStaffCancel({ status, fundingMethod: 'credit_card' })).toBe(false);
    }
  });
});
