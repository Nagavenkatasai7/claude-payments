import { describe, it, expect } from 'vitest';
import {
  isAbandoned,
  summarize,
  ABANDONED_THRESHOLD_MS,
} from '@/lib/dashboard';
import type { Transfer } from '@/lib/types';

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    id: overrides.id,
    phone: '15551234567',
    amountUsd: 100,
    feeUsd: 2.5,
    totalChargeUsd: 102.5,
    fxRate: 85,
    amountInr: 8500,
    recipientName: 'Test User',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'test@upi',
    fundingMethod: 'credit_card',
    status: 'awaiting_payment',
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// Use a fixed "now" in Eastern time so tests are timezone-independent.
// 2026-05-21T14:00:00Z is 10:00 AM Eastern (UTC-4, EDT)
const NOW = Date.parse('2026-05-21T14:00:00.000Z');
// createdAt "today" in Eastern time: 2026-05-21T12:00:00Z → 8 AM EDT
const TODAY_ISO = '2026-05-21T12:00:00.000Z';
// createdAt "yesterday" in Eastern time: 2026-05-20T12:00:00Z
const YESTERDAY_ISO = '2026-05-20T12:00:00.000Z';

describe('isAbandoned', () => {
  it('returns true when awaiting_payment and past threshold', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({ id: 'a1', createdAt: new Date(old).toISOString() });
    expect(isAbandoned(t, NOW)).toBe(true);
  });

  it('returns false when awaiting_payment but within threshold', () => {
    const recent = NOW - ABANDONED_THRESHOLD_MS + 1000;
    const t = makeTransfer({
      id: 'a2',
      createdAt: new Date(recent).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });

  it('returns false for paid status even if old', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({
      id: 'a3',
      status: 'paid',
      createdAt: new Date(old).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });

  it('returns false for delivered status even if old', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({
      id: 'a4',
      status: 'delivered',
      createdAt: new Date(old).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });

  it('returns false for cancelled status even if old', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const t = makeTransfer({
      id: 'a5',
      status: 'cancelled',
      createdAt: new Date(old).toISOString(),
    });
    expect(isAbandoned(t, NOW)).toBe(false);
  });
});

describe('summarize', () => {
  it('counts only today transfers for countToday', () => {
    const transfers = [
      makeTransfer({ id: 's1', createdAt: TODAY_ISO }),
      makeTransfer({ id: 's2', createdAt: TODAY_ISO }),
      makeTransfer({ id: 's3', createdAt: YESTERDAY_ISO }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.countToday).toBe(2);
  });

  it('sums volumeToday for all of today regardless of status', () => {
    const transfers = [
      makeTransfer({ id: 'v1', createdAt: TODAY_ISO, amountUsd: 100 }),
      makeTransfer({ id: 'v2', createdAt: TODAY_ISO, amountUsd: 200, status: 'paid' }),
      makeTransfer({ id: 'v3', createdAt: YESTERDAY_ISO, amountUsd: 50 }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.volumeToday).toBe(300);
  });

  it('sums commissionToday only for paid/delivered transfers today', () => {
    const transfers = [
      // awaiting — should NOT count
      makeTransfer({ id: 'c1', createdAt: TODAY_ISO, feeUsd: 1.0, status: 'awaiting_payment' }),
      // paid today — should count
      makeTransfer({ id: 'c2', createdAt: TODAY_ISO, feeUsd: 2.5, status: 'paid' }),
      // delivered today — should count
      makeTransfer({ id: 'c3', createdAt: TODAY_ISO, feeUsd: 3.0, status: 'delivered' }),
      // cancelled today — should NOT count
      makeTransfer({ id: 'c4', createdAt: TODAY_ISO, feeUsd: 5.0, status: 'cancelled' }),
      // paid yesterday — should NOT count for today
      makeTransfer({ id: 'c5', createdAt: YESTERDAY_ISO, feeUsd: 10.0, status: 'paid' }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.commissionToday).toBe(5.5);
  });

  it('sums commissionAllTime for paid/delivered across all days', () => {
    const transfers = [
      makeTransfer({ id: 'at1', createdAt: TODAY_ISO, feeUsd: 2.5, status: 'paid' }),
      makeTransfer({ id: 'at2', createdAt: YESTERDAY_ISO, feeUsd: 10.0, status: 'delivered' }),
      makeTransfer({ id: 'at3', createdAt: YESTERDAY_ISO, feeUsd: 5.0, status: 'awaiting_payment' }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.commissionAllTime).toBe(12.5);
  });

  it('counts needsAttention as abandoned awaiting_payment transfers', () => {
    const old = NOW - ABANDONED_THRESHOLD_MS - 1;
    const recent = NOW - ABANDONED_THRESHOLD_MS + 1000;
    const transfers = [
      // old and awaiting — should count
      makeTransfer({ id: 'n1', createdAt: new Date(old).toISOString(), status: 'awaiting_payment' }),
      // old and awaiting — should count
      makeTransfer({ id: 'n2', createdAt: new Date(old).toISOString(), status: 'awaiting_payment' }),
      // recent and awaiting — should NOT count
      makeTransfer({ id: 'n3', createdAt: new Date(recent).toISOString(), status: 'awaiting_payment' }),
      // old but paid — should NOT count
      makeTransfer({ id: 'n4', createdAt: new Date(old).toISOString(), status: 'paid' }),
    ];
    const summary = summarize(transfers, NOW);
    expect(summary.needsAttention).toBe(2);
  });

  it('rounds money to 2 decimal places', () => {
    const transfers = [
      makeTransfer({ id: 'r1', createdAt: TODAY_ISO, feeUsd: 1.005, status: 'paid' }),
      makeTransfer({ id: 'r2', createdAt: TODAY_ISO, feeUsd: 1.004, status: 'paid' }),
    ];
    const summary = summarize(transfers, NOW);
    // 1.005 + 1.004 = 2.009 → Math.round(200.9) / 100 = 2.01
    expect(summary.commissionToday).toBe(2.01);
  });

  it('returns zeros for empty transfers list', () => {
    const summary = summarize([], NOW);
    expect(summary.commissionToday).toBe(0);
    expect(summary.volumeToday).toBe(0);
    expect(summary.countToday).toBe(0);
    expect(summary.needsAttention).toBe(0);
    expect(summary.commissionAllTime).toBe(0);
  });
});
