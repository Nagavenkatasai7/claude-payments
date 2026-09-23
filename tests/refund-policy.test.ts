import { describe, it, expect } from 'vitest';
import { refundDisposition, isRecallEligible, isRefundable, RECALL_WINDOW_MS, CANCEL_WINDOW_MS } from '@/lib/refund-policy';
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

// Program-Fix 15 PR C: the Reg E 30-minute cancellation window (12 CFR
// 1005.34). Keyed on CHARGE time (the stage1:<id> row's created_at, supplied
// by the caller); paid_at is only the fallback hint. Relative dates only.
describe('refundDisposition — cancellable (Program-Fix 15 PR C)', { retry: 0 }, () => {
  const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

  it('paid, charged 10 min ago, refund none → cancellable with msLeft', () => {
    const d = refundDisposition(transfer({ status: 'paid', paidAt: minsAgo(60) }), NOW, minsAgo(10));
    expect(d).toEqual({ kind: 'cancellable', msLeft: 20 * 60_000 });
    expect(CANCEL_WINDOW_MS).toBe(30 * 60_000);
  });

  it('isRefundable stays true for cancellable (the refund request still works)', () => {
    const t = transfer({ status: 'paid' });
    expect(refundDisposition(t, NOW, minsAgo(5)).kind).toBe('cancellable');
    expect(isRefundable(t, NOW, minsAgo(5))).toBe(true);
  });

  it('refund already requested inside the window → still cancellable', () => {
    const d = refundDisposition(transfer({ status: 'paid', refundStatus: 'requested' }), NOW, minsAgo(1));
    expect(d.kind).toBe('cancellable');
  });

  it('refund pending / completed / failed inside the window → the refund pipeline state wins', () => {
    expect(refundDisposition(transfer({ status: 'paid', refundStatus: 'pending' }), NOW, minsAgo(1)).kind).toBe('in_progress');
    expect(refundDisposition(transfer({ status: 'paid', refundStatus: 'failed' }), NOW, minsAgo(1)).kind).toBe('in_progress');
    expect(refundDisposition(transfer({ status: 'paid', refundStatus: 'completed' }), NOW, minsAgo(1)).kind).toBe('completed');
  });

  it('exactly 30 min after the charge → refundable as today (the window is open strictly before)', () => {
    expect(refundDisposition(transfer({ status: 'paid' }), NOW, minsAgo(30))).toEqual({ kind: 'refundable' });
  });

  it('chargedAt absent → falls back to paid_at', () => {
    expect(refundDisposition(transfer({ status: 'paid', paidAt: minsAgo(29) }), NOW).kind).toBe('cancellable');
    expect(refundDisposition(transfer({ status: 'paid', paidAt: minsAgo(31) }), NOW).kind).toBe('refundable');
  });

  it('no charge time and no paid_at → refundable (never a guessed window)', () => {
    expect(refundDisposition(transfer({ status: 'paid', paidAt: undefined }), NOW)).toEqual({ kind: 'refundable' });
  });

  it('an explicit chargedAt wins over a later paid_at (a released hold resets paid_at)', () => {
    const t = transfer({ status: 'paid', paidAt: minsAgo(2) });
    expect(refundDisposition(t, NOW, minsAgo(45)).kind).toBe('refundable');
  });

  it('in_review inside the window → under_review (C4: never auto-cancelled)', () => {
    expect(refundDisposition(transfer({ status: 'in_review', paidAt: minsAgo(1) }), NOW, minsAgo(1))).toEqual({ kind: 'under_review' });
  });

  it('delivered inside the window → never cancellable', () => {
    const d = refundDisposition(transfer({ status: 'delivered', deliveredAt: minsAgo(1), paidAt: minsAgo(2) }), NOW, minsAgo(2));
    expect(d.kind).toBe('recall_eligible');
  });

  it('a B2B transfer is never cancellable (not a consumer sender under 1005.30)', () => {
    const d = refundDisposition(transfer({ status: 'paid', transferType: 'b2b' }), NOW, minsAgo(1));
    expect(d).toEqual({ kind: 'refundable' });
  });

  it('a future charge time (clock skew) is treated as inside the window, capped at the full window', () => {
    const d = refundDisposition(transfer({ status: 'paid' }), NOW, new Date(NOW + 60_000).toISOString());
    expect(d).toEqual({ kind: 'cancellable', msLeft: CANCEL_WINDOW_MS });
  });
});
