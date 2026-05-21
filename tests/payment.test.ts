import { describe, it, expect } from 'vitest';
import {
  completePaymentStage1,
  completePaymentStage2,
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
    status: 'awaiting_payment',
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('completePaymentStage1', () => {
  it('sets status to paid and paidAt, returns sender and recipient messages', async () => {
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

    expect(result.recipientMessages).toHaveLength(1);
    expect(result.recipientMessages[0]).toContain('42,600');
    expect(result.recipientMessages[0]).toContain('Mom');
    expect(result.recipientMessages[0]).toContain('UPI ID');
  });

  it('says bank account for bank payout method', async () => {
    const store = createStore(fakeRedis());
    const t = { ...awaitingTransfer(), payoutMethod: 'bank' as const };
    await store.saveTransfer(t);

    const result = await completePaymentStage1(store, 'pay12345');
    expect(result.recipientMessages[0]).toContain('bank account');
  });

  it('is idempotent — if already paid, returns empty message arrays', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(awaitingTransfer());
    await completePaymentStage1(store, 'pay12345');

    const second = await completePaymentStage1(store, 'pay12345');
    expect(second.transfer.status).toBe('paid');
    expect(second.senderMessages).toHaveLength(0);
    expect(second.recipientMessages).toHaveLength(0);
  });

  it('is idempotent — if already delivered, returns empty message arrays', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer({ ...awaitingTransfer(), status: 'delivered' });

    const result = await completePaymentStage1(store, 'pay12345');
    expect(result.transfer.status).toBe('delivered');
    expect(result.senderMessages).toHaveLength(0);
    expect(result.recipientMessages).toHaveLength(0);
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis());
    await expect(completePaymentStage1(store, 'missing')).rejects.toThrow(
      /not found/i,
    );
  });
});

describe('completePaymentStage2', () => {
  it('sets status to delivered and deliveredAt, returns sender and recipient messages', async () => {
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

    expect(result.recipientMessages).toHaveLength(1);
    expect(result.recipientMessages[0]).toContain('42,600');
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
    expect(result.recipientMessages).toHaveLength(0);
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
    expect(result.recipientMessages).toHaveLength(0);
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

  it('recipient messages mention the rupee amount', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer({
      ...awaitingTransfer(),
      status: 'paid',
      paidAt: '2026-05-21T01:00:00.000Z',
    });

    const result = await completePaymentStage2(store, 'pay12345');
    expect(result.recipientMessages[0]).toContain('42,600');
  });
});
