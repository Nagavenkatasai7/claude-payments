import { describe, it, expect, vi } from 'vitest';
import { createStore } from '@/lib/store';
import { cancelTransfer, assignTransfer, resendPaymentLink } from '@/lib/dashboard-ops';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

function makeTransfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
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
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('cancelTransfer', () => {
  it('sets status to cancelled for awaiting_payment', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(makeTransfer({ id: 'c1', status: 'awaiting_payment' }));
    await cancelTransfer(store, 'c1');
    const loaded = await store.getTransfer('c1');
    expect(loaded?.status).toBe('cancelled');
  });

  it('sets status to cancelled for paid', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(makeTransfer({ id: 'c2', status: 'paid' }));
    await cancelTransfer(store, 'c2');
    const loaded = await store.getTransfer('c2');
    expect(loaded?.status).toBe('cancelled');
  });

  it('is a no-op for delivered transfers', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(makeTransfer({ id: 'c3', status: 'delivered' }));
    await cancelTransfer(store, 'c3');
    const loaded = await store.getTransfer('c3');
    expect(loaded?.status).toBe('delivered');
  });

  it('is a no-op for already cancelled transfers', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(makeTransfer({ id: 'c4', status: 'cancelled' }));
    await cancelTransfer(store, 'c4');
    const loaded = await store.getTransfer('c4');
    expect(loaded?.status).toBe('cancelled');
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis());
    await expect(cancelTransfer(store, 'missing')).rejects.toThrow('Transfer not found');
  });
});

describe('assignTransfer', () => {
  it('sets assignedTo and adminNote on the transfer', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(makeTransfer({ id: 'a1' }));
    await assignTransfer(store, 'a1', 'alice@example.com', 'High priority');
    const loaded = await store.getTransfer('a1');
    expect(loaded?.assignedTo).toBe('alice@example.com');
    expect(loaded?.adminNote).toBe('High priority');
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis());
    await expect(assignTransfer(store, 'missing', 'alice', 'note')).rejects.toThrow('Transfer not found');
  });
});

describe('resendPaymentLink', () => {
  it('calls sendText with the correct phone and URL containing the transfer id', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(makeTransfer({ id: 'r1', phone: '15559876543' }));

    const sendText = vi.fn().mockResolvedValue(undefined);
    await resendPaymentLink(store, sendText, 'r1');

    expect(sendText).toHaveBeenCalledOnce();
    const [toArg, textArg] = sendText.mock.calls[0] as [string, string];
    expect(toArg).toBe('15559876543');
    expect(textArg).toContain('r1');
    expect(textArg).toContain('/pay/r1');
  });

  it('throws for a missing transfer', async () => {
    const store = createStore(fakeRedis());
    const sendText = vi.fn().mockResolvedValue(undefined);
    await expect(resendPaymentLink(store, sendText, 'missing')).rejects.toThrow('Transfer not found');
  });
});
