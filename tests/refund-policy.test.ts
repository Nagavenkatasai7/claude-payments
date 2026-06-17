import { describe, it, expect } from 'vitest';
import { refundDisposition, isRecallEligible, isRefundable, RECALL_WINDOW_MS } from '@/lib/refund-policy';
import type { Transfer, TransferStatus, RefundStatus } from '@/lib/types';

const NOW = Date.parse('2026-06-17T12:00:00Z');

function transfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tx_1',
    phone: '15551230000',
    amountUsd: 200,
    feeUsd: 1.99,
    totalChargeUsd: 201.99,
    fxRate: 85,
    amountInr: 17000,
    recipientName: 'Mom',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'paid',
    createdAt: '2026-06-17T11:00:00Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 200,
    feeSource: 1.99,
    totalChargeSource: 201.99,
    ...overrides,
  };
}

describe('refundDisposition', () => {
  it('paid + no refund → refundable (ops-reviewed refund)', () => {
    expect(refundDisposition(transfer({ status: 'paid' }), NOW)).toEqual({ kind: 'refundable' });
    expect(isRefundable(transfer({ status: 'paid' }), NOW)).toBe(true);
  });

  it('delivered within 24h → recall_eligible with msLeft', () => {
    const deliveredAt = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago
    const d = refundDisposition(transfer({ status: 'delivered', deliveredAt }), NOW);
    expect(d.kind).toBe('recall_eligible');
    if (d.kind === 'recall_eligible') expect(d.msLeft).toBe(RECALL_WINDOW_MS - 60 * 60 * 1000);
    expect(isRecallEligible(transfer({ status: 'delivered', deliveredAt }), NOW)).toBe(true);
  });

  it('delivered exactly at the boundary → window passed (msLeft not > 0)', () => {
    const deliveredAt = new Date(NOW - RECALL_WINDOW_MS).toISOString();
    expect(refundDisposition(transfer({ status: 'delivered', deliveredAt }), NOW)).toEqual({ kind: 'recall_window_passed' });
  });

  it('delivered > 24h ago → recall_window_passed', () => {
    const deliveredAt = new Date(NOW - (RECALL_WINDOW_MS + 1000)).toISOString();
    expect(refundDisposition(transfer({ status: 'delivered', deliveredAt }), NOW)).toEqual({ kind: 'recall_window_passed' });
    expect(isRecallEligible(transfer({ status: 'delivered', deliveredAt }), NOW)).toBe(false);
  });

  it('delivered with MISSING deliveredAt → lenient: recall_eligible', () => {
    const d = refundDisposition(transfer({ status: 'delivered', deliveredAt: undefined }), NOW);
    expect(d.kind).toBe('recall_eligible');
  });

  it('awaiting_payment → awaiting_payment (nothing charged)', () => {
    expect(refundDisposition(transfer({ status: 'awaiting_payment' }), NOW)).toEqual({ kind: 'awaiting_payment' });
  });

  it('in_review → under_review', () => {
    expect(refundDisposition(transfer({ status: 'in_review' }), NOW)).toEqual({ kind: 'under_review' });
  });

  it('blocked → blocked; cancelled → cancelled', () => {
    expect(refundDisposition(transfer({ status: 'blocked' }), NOW)).toEqual({ kind: 'blocked' });
    expect(refundDisposition(transfer({ status: 'cancelled' }), NOW)).toEqual({ kind: 'cancelled' });
  });

  it('refund pipeline state takes precedence over transfer status', () => {
    const cases: Array<[RefundStatus, string]> = [
      ['requested', 'already_requested'],
      ['pending', 'in_progress'],
      ['failed', 'in_progress'],
      ['completed', 'completed'],
    ];
    for (const [refundStatus, kind] of cases) {
      // Even a delivered transfer reports its refund-pipeline state, not a recall offer.
      const d = refundDisposition(transfer({ status: 'delivered', deliveredAt: new Date(NOW).toISOString(), refundStatus }), NOW);
      expect(d.kind).toBe(kind);
    }
  });

  it('absent refundStatus is treated as none (paid → refundable)', () => {
    const t = transfer({ status: 'paid' });
    delete (t as { refundStatus?: RefundStatus }).refundStatus;
    expect(refundDisposition(t, NOW)).toEqual({ kind: 'refundable' });
  });

  it('defaults now to Date.now() when omitted (delivered just now is recall-eligible)', () => {
    const d = refundDisposition(transfer({ status: 'delivered', deliveredAt: new Date().toISOString() }));
    expect(d.kind).toBe('recall_eligible');
  });
});
