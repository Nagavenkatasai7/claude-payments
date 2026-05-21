import { describe, it, expect } from 'vitest';
import { completePayment } from '@/lib/payment';
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
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    status: 'awaiting_payment',
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('completePayment', () => {
  it('marks the transfer delivered and returns two messages', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(awaitingTransfer());

    const result = await completePayment(store, 'pay12345');

    expect(result.transfer.status).toBe('delivered');
    expect(result.transfer.paidAt).toBeTruthy();
    expect(result.transfer.deliveredAt).toBeTruthy();
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toContain('42,600');
    expect(result.messages[1]).toContain('Mom');
  });

  it('is idempotent — a second call returns no new messages', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(awaitingTransfer());
    await completePayment(store, 'pay12345');
    const second = await completePayment(store, 'pay12345');
    expect(second.transfer.status).toBe('delivered');
    expect(second.messages).toHaveLength(0);
  });

  it('throws for an unknown transfer', async () => {
    const store = createStore(fakeRedis());
    await expect(completePayment(store, 'missing')).rejects.toThrow(
      /not found/i,
    );
  });
});
