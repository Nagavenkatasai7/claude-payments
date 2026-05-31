import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_LANG,
  TEMPLATE_TRANSFER_DELIVERED_SENDER,
  TEMPLATE_SCHEDULED_PAYMENT_READY,
  TEMPLATE_PAYMENT_REMINDER,
  TEMPLATE_TRANSFER_IN_REVIEW,
  TEMPLATE_TRANSFER_RELEASED,
  TEMPLATE_TRANSFER_CANCELLED,
  TEMPLATE_VERIFICATION_REMINDER,
  formatSourceAmount,
  transferDeliveredSenderParams,
  scheduledPaymentReadyParams,
  paymentReminderParams,
  transferInReviewParams,
  transferReleasedParams,
  transferCancelledParams,
  verificationReminderParams,
} from '@/lib/whatsapp-templates';
import type { Schedule, Transfer } from '@/lib/types';

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: 'tx_a1b2c3',
    phone: '15551234567',
    amountUsd: 50,
    feeUsd: 0,
    totalChargeUsd: 50,
    fxRate: 83,
    amountInr: 4150,
    recipientName: 'Priya',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: '••••6789',
    fundingMethod: 'debit_card',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-05-30T00:00:00.000Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 50,
    feeSource: 0,
    totalChargeSource: 50,
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched_1',
    phone: '15551234567',
    amountUsd: 100,
    recipientName: 'Priya',
    recipientPhone: '919876543210',
    payoutMethod: 'bank',
    payoutDestination: '••••6789',
    fundingMethod: 'debit_card',
    frequency: 'monthly',
    status: 'active',
    createdAt: '2026-05-30T00:00:00.000Z',
    partnerId: 'default',
    sourceCurrency: 'USD',
    amountSource: 100,
    ...overrides,
  };
}

describe('template constants (docs/meta-whatsapp-config.md §3)', () => {
  it('uses the exact §3 template names', () => {
    expect(TEMPLATE_TRANSFER_DELIVERED_SENDER).toBe('transfer_delivered_sender'); // §3.2
    expect(TEMPLATE_SCHEDULED_PAYMENT_READY).toBe('scheduled_payment_ready');     // §3.3
    expect(TEMPLATE_PAYMENT_REMINDER).toBe('payment_reminder');                   // §3.4
    expect(TEMPLATE_TRANSFER_IN_REVIEW).toBe('transfer_in_review');               // §3.5
    expect(TEMPLATE_TRANSFER_RELEASED).toBe('transfer_released');                 // §3.6
    expect(TEMPLATE_TRANSFER_CANCELLED).toBe('transfer_cancelled');               // §3.7
    expect(TEMPLATE_VERIFICATION_REMINDER).toBe('verification_reminder');         // §3.8
  });

  it('all new templates use language code "en"', () => {
    expect(TEMPLATE_LANG).toBe('en');
  });
});

describe('formatSourceAmount', () => {
  it('formats USD with 2 decimal places and grouping', () => {
    expect(formatSourceAmount(50, 'USD')).toBe('$50.00');
    expect(formatSourceAmount(100, 'USD')).toBe('$100.00');
    expect(formatSourceAmount(1000, 'USD')).toBe('$1,000.00');
  });

  it('formats GBP with the £ symbol', () => {
    expect(formatSourceAmount(50, 'GBP')).toBe('£50.00');
  });

  it('falls back to "<n.nn> CODE" for an invalid currency code (Intl throws)', () => {
    // A non-3-letter code is rejected by Intl.NumberFormat and hits the catch
    // branch — mirrors the module-private formatSourceCharge contract in payment.ts.
    expect(formatSourceAmount(50, 'zz')).toBe('50.00 zz');
  });
});

describe('transferDeliveredSenderParams (§3.2 — [amount, recipient, id])', () => {
  it('returns exactly [source amount, recipient name, transfer id] in order', () => {
    const params = transferDeliveredSenderParams(makeTransfer());
    expect(params).toEqual(['$50.00', 'Priya', 'tx_a1b2c3']);
  });

  it('uses the source-side charge + currency (non-USD)', () => {
    const params = transferDeliveredSenderParams(
      makeTransfer({ totalChargeSource: 80, sourceCurrency: 'GBP' }),
    );
    expect(params[0]).toBe('£80.00');
  });

  it('falls back to totalChargeUsd when totalChargeSource is undefined', () => {
    const t = makeTransfer({ totalChargeUsd: 73 });
    delete (t as Partial<Transfer>).totalChargeSource;
    const params = transferDeliveredSenderParams(t);
    expect(params[0]).toBe('$73.00');
  });
});

describe('scheduledPaymentReadyParams (§3.3 — body [name, amount, recipient] + URL button token)', () => {
  it('returns bodyParams [senderName, amount, recipient] in order', () => {
    const result = scheduledPaymentReadyParams(makeSchedule(), 'tx_a1b2c3', 'Anand');
    expect(result.bodyParams).toEqual(['Anand', '$100.00', 'Priya']);
  });

  it('uses the passed-in transferId as the URL button token (NOT schedule.id)', () => {
    const result = scheduledPaymentReadyParams(makeSchedule({ id: 'sched_1' }), 'tx_xyz', 'Anand');
    expect(result.buttonToken).toBe('tx_xyz');
    expect(result.buttonToken).not.toBe('sched_1');
  });

  it('button token is path-safe (no "/" — protects the dynamic-URL suffix rule)', () => {
    const result = scheduledPaymentReadyParams(makeSchedule(), 'tx_a1b2c3', 'Anand');
    expect(result.buttonToken).not.toContain('/');
  });

  it('uses amountSource/sourceCurrency for the amount', () => {
    const result = scheduledPaymentReadyParams(
      makeSchedule({ amountSource: 250, sourceCurrency: 'GBP' }),
      'tx_1',
      'Anand',
    );
    expect(result.bodyParams[1]).toBe('£250.00');
  });

  it('falls back to amountUsd/USD when amountSource is undefined', () => {
    const s = makeSchedule({ amountUsd: 99 });
    delete (s as Partial<Schedule>).amountSource;
    const result = scheduledPaymentReadyParams(s, 'tx_1', 'Anand');
    expect(result.bodyParams[1]).toBe('$99.00');
  });
});

describe('paymentReminderParams (§3.4 — body [name, amount, recipient] + URL button token)', () => {
  it('returns bodyParams [senderName, amount, recipient] in order', () => {
    const result = paymentReminderParams(makeTransfer(), 'Anand');
    expect(result.bodyParams).toEqual(['Anand', '$50.00', 'Priya']);
  });

  it('uses transfer.id as the URL button token', () => {
    const result = paymentReminderParams(makeTransfer({ id: 'tx_reminder' }), 'Anand');
    expect(result.buttonToken).toBe('tx_reminder');
  });
});

describe.each([
  ['transferInReviewParams §3.5', transferInReviewParams],
  ['transferReleasedParams §3.6', transferReleasedParams],
  ['transferCancelledParams §3.7', transferCancelledParams],
])('%s — [name, amount, recipient]', (_label, builder) => {
  it('returns exactly [senderName, formatted source amount, recipientName]', () => {
    const params = builder(makeTransfer({ totalChargeSource: 1000 }), 'Anand');
    expect(params).toEqual(['Anand', '$1,000.00', 'Priya']);
  });

  it('uses the source-side currency', () => {
    const params = builder(
      makeTransfer({ totalChargeSource: 200, sourceCurrency: 'GBP' }),
      'Anand',
    );
    expect(params).toEqual(['Anand', '£200.00', 'Priya']);
  });
});

describe('verificationReminderParams (§3.8 — body [name] + URL button token)', () => {
  it('returns bodyParams [senderName] (length 1)', () => {
    const result = verificationReminderParams('Anand', 'sess_xyz');
    expect(result.bodyParams).toEqual(['Anand']);
  });

  it('uses the session token as the URL button token', () => {
    const result = verificationReminderParams('Anand', 'sess_xyz');
    expect(result.buttonToken).toBe('sess_xyz');
  });
});
