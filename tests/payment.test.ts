import { describe, it, expect } from 'vitest';
import {
  completePaymentStage1,
  completePaymentStage2,
  recipientTemplateParams,
} from '@/lib/payment';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

function awaitingTransfer(): Transfer {
  return {
    id: 'pay12345',
    phone: '15551234567',
    amountUsd: 500,
    feeUsd: 0,
    totalChargeUsd: 500,
    fxRate: 85.2,
    amountInr: 42600,
    recipientName: 'Mom',
    recipientPhone: '919876543210',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: '2026-05-21T00:00:00.000Z',
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
    amountSource: 500,
    feeSource: 0,
    totalChargeSource: 500,
  };
}

describe('completePaymentStage1', () => {
  it('sets status to paid and paidAt, returns sender messages', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(awaitingTransfer());

    const result = await completePaymentStage1(store, 'pay12345');

    expect(result.transfer.status).toBe('paid');
    expect(result.transfer.paidAt).toBeTruthy();
    expect(result.transfer.deliveredAt).toBeUndefined();

    expect(result.senderMessages).toHaveLength(1);
    expect(result.senderMessages[0]).toContain('$500.00');
    expect(result.senderMessages[0]).toContain('42,600');
    expect(result.senderMessages[0]).toContain('Mom');
    expect(result.senderMessages[0]).toContain('Transfer ID: pay12345');
    expect(result.senderMessages[0]).not.toContain('…'); // no trailing ellipsis
    expect(result.senderMessages[0]).toContain('within ~10 minutes');
  });

  it('is idempotent — if already paid, returns empty message arrays', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(awaitingTransfer());
    await completePaymentStage1(store, 'pay12345');

    const second = await completePaymentStage1(store, 'pay12345');
    expect(second.transfer.status).toBe('paid');
    expect(second.senderMessages).toHaveLength(0);
  });

  it('is idempotent — if already delivered, returns empty message arrays', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer({ ...awaitingTransfer(), status: 'delivered' });

    const result = await completePaymentStage1(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.senderMessages).toHaveLength(0);
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis());
    await expect(completePaymentStage1(store, 'missing')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('completePaymentStage2', () => {
  it('sets status to delivered and deliveredAt, returns sender messages', async () => {
    const store = createStore(fakeRedis());
    // Pre-seed a paid transfer
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay12345');

    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.deliveredAt).toBeTruthy();
    expect(result.transfer.paidAt).toBeTruthy();

    expect(result.senderMessages).toHaveLength(1);
    expect(result.senderMessages[0]).toContain('42,600');
    expect(result.senderMessages[0]).toContain('Mom');
    expect(result.senderMessages[0]).toContain('via UPI');       // default fixture payoutMethod 'upi'
    expect(result.senderMessages[0]).toContain('Transfer ID: pay12345');
  });

  it('uses "via bank" label for bank payout method', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer({
      ...awaitingTransfer(),
      payoutMethod: 'bank',
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.senderMessages[0]).toContain('via bank');
  });

  it('is idempotent — if already delivered, returns empty message arrays', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'delivered',
      paidAt: '2026-05-21T01:00:00.000Z',
      deliveredAt: '2026-05-21T01:02:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.senderMessages).toHaveLength(0);
  });

  it('does NOT deliver a cancelled transfer — returns empty messages', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'cancelled',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('cancelled');
    expect(result.senderMessages).toHaveLength(0);
  });

  it('sets paidAt if somehow unset when delivering', async () => {
    const store = createStore(fakeRedis());
    // Transfer is awaiting_payment (no paidAt)
    await store.saveTransfer(awaitingTransfer());

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.paidAt).toBeTruthy();
    expect(result.transfer.deliveredAt).toBeTruthy();
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis());
    await expect(completePaymentStage2(store, 'missing')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('recipientTemplateParams', () => {
  it('returns 4 params in order for a UPI transfer', () => {
    const transfer = awaitingTransfer();
    const params = recipientTemplateParams(transfer);

    expect(params).toHaveLength(4);
    expect(params[0]).toBe('Mom'); // recipient name
    expect(params[1]).toBe('42,600'); // formatted rupee amount
    expect(params[2]).toBe('+15551234567'); // sender phone with +
    expect(params[3]).toBe('UPI ID'); // payout method label
  });

  it('returns "bank account" for bank payout method', () => {
    const transfer = { ...awaitingTransfer(), payoutMethod: 'bank' as const };
    const params = recipientTemplateParams(transfer);

    expect(params).toHaveLength(4);
    expect(params[3]).toBe('bank account');
  });

  it('formats the rupee amount using en-IN locale', () => {
    const transfer = { ...awaitingTransfer(), amountInr: 100000 };
    const params = recipientTemplateParams(transfer);
    // en-IN formats 100000 as "1,00,000"
    expect(params[1]).toBe('1,00,000');
  });
});
