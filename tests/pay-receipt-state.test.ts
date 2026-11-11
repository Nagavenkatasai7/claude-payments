import { describe, it, expect } from 'vitest';
import type { Transfer } from '@/lib/types';
import { payReceiptState } from '@/lib/pay-receipt-state';

/**
 * Fix pack 6 T11 (P11): the paid pay page's status table, first match wins. Pure.
 */

const OPAQUE = 'Ab_9-Cd_E-fG0hIjKlMnOp';
const LEGACY = 'ab12cd34';
const PAID_AT = new Date(Date.now() - 60_000).toISOString();

type Row = Parameters<typeof payReceiptState>[0];
const row = (o: Partial<Row> = {}): Row => ({
  id: OPAQUE,
  status: 'paid',
  complianceStatus: 'cleared',
  ...o,
});

describe('payReceiptState (pack 6 P11)', () => {
  it('awaiting_payment -> form', () => {
    expect(payReceiptState(row({ status: 'awaiting_payment' }))).toBe('form');
  });

  it('cancelled 22-char with paidAt -> cancelled_charged', () => {
    expect(payReceiptState(row({ status: 'cancelled', paidAt: PAID_AT }))).toBe('cancelled_charged');
  });

  it("cancelled 22-char with refundStatus 'pending' and no paidAt -> cancelled_charged", () => {
    expect(payReceiptState(row({ status: 'cancelled', refundStatus: 'pending' }))).toBe('cancelled_charged');
  });

  it("cancelled with refundStatus 'completed' -> refunded", () => {
    expect(payReceiptState(row({ status: 'cancelled', refundStatus: 'completed', paidAt: PAID_AT }))).toBe('refunded');
    expect(payReceiptState(row({ status: 'cancelled', refundStatus: 'completed' }))).toBe('refunded');
  });

  it("cancelled, no paidAt, refundStatus absent or 'none' -> null (the dead-link sheet)", () => {
    expect(payReceiptState(row({ status: 'cancelled' }))).toBeNull();
    expect(payReceiptState(row({ status: 'cancelled', refundStatus: 'none' }))).toBeNull();
  });

  it('cancelled legacy 8-char id, charged -> null', () => {
    expect(payReceiptState(row({ id: LEGACY, status: 'cancelled', paidAt: PAID_AT }))).toBeNull();
    expect(payReceiptState(row({ id: LEGACY, status: 'cancelled', refundStatus: 'completed' }))).toBeNull();
  });

  it("environment 'test', any non-awaiting status -> legacy_complete", () => {
    for (const status of ['paid', 'in_review', 'delivered', 'blocked'] as const) {
      expect(payReceiptState(row({ status, environment: 'test' }))).toBe('legacy_complete');
    }
    expect(payReceiptState(row({ status: 'paid', environment: 'test', refundStatus: 'completed' }))).toBe('legacy_complete');
  });

  it('legacy 8-char id, any paid/in_review/delivered/blocked status -> legacy_complete', () => {
    for (const status of ['paid', 'in_review', 'delivered', 'blocked'] as const) {
      expect(payReceiptState(row({ id: LEGACY, status }))).toBe('legacy_complete');
    }
  });

  it("refundStatus 'completed' wins over every later row -> refunded", () => {
    expect(payReceiptState(row({ status: 'paid', refundStatus: 'completed', fundingState: 'returned' }))).toBe('refunded');
    expect(payReceiptState(row({ status: 'blocked', refundStatus: 'completed' }))).toBe('refunded');
    expect(payReceiptState(row({ status: 'in_review', refundStatus: 'completed', complianceStatus: 'blocked' }))).toBe('refunded');
    expect(payReceiptState(row({ status: 'delivered', refundStatus: 'completed' }))).toBe('refunded');
  });

  it("fundingState 'returned' on paid / in_review / delivered -> held_no_receipt", () => {
    for (const status of ['paid', 'in_review', 'delivered'] as const) {
      expect(payReceiptState(row({ status, fundingState: 'returned' }))).toBe('held_no_receipt');
    }
  });

  it('blocked without paidAt -> not_completed', () => {
    expect(payReceiptState(row({ status: 'blocked' }))).toBe('not_completed');
  });

  it('blocked with paidAt -> held_no_receipt', () => {
    expect(payReceiptState(row({ status: 'blocked', paidAt: PAID_AT }))).toBe('held_no_receipt');
  });

  it("in_review with complianceStatus 'blocked' -> held_no_receipt", () => {
    expect(payReceiptState(row({ status: 'in_review', complianceStatus: 'blocked' }))).toBe('held_no_receipt');
  });

  it('in_review -> held_receipt', () => {
    expect(payReceiptState(row({ status: 'in_review', complianceStatus: 'flagged', paidAt: PAID_AT }))).toBe('held_receipt');
    expect(payReceiptState(row({ status: 'in_review' }))).toBe('held_receipt');
  });

  it('22-char paid / delivered -> complete_receipt', () => {
    expect(payReceiptState(row({ status: 'paid', paidAt: PAID_AT }))).toBe('complete_receipt');
    expect(payReceiptState(row({ status: 'delivered', paidAt: PAID_AT }))).toBe('complete_receipt');
  });

  it("refundStatus 'requested'/'pending'/'failed' on a paid row does not change the state", () => {
    for (const refundStatus of ['requested', 'pending', 'failed'] as const) {
      expect(payReceiptState(row({ status: 'paid', paidAt: PAID_AT, refundStatus }))).toBe('complete_receipt');
    }
  });

  it('accepts a whole Transfer (the Pick is structural)', () => {
    const t = { ...row(), phone: '15551234567' } as unknown as Transfer;
    expect(payReceiptState(t)).toBe('complete_receipt');
  });
});
