import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
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
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function sampleTransfer(): Transfer {
  return {
    id: 'abc12345',
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

describe('store', () => {
  it('round-trips a transfer', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(sampleTransfer());
    const loaded = await store.getTransfer('abc12345');
    expect(loaded?.recipientName).toBe('Mom');
  });

  it('returns null for an unknown transfer', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTransfer('missing')).toBeNull();
  });

  it('round-trips conversation history', async () => {
    const store = createStore(fakeRedis());
    await store.saveConversation('15551234567', [
      { role: 'user', content: 'hi' },
    ]);
    const conv = await store.getConversation('15551234567');
    expect(conv).toHaveLength(1);
    expect(conv[0].content).toBe('hi');
  });

  it('defaults a new user to zero transfers and increments', async () => {
    const store = createStore(fakeRedis());
    expect((await store.getUser('p')).transferCount).toBe(0);
    await store.incrementTransferCount('p');
    expect((await store.getUser('p')).transferCount).toBe(1);
  });

  it('marks a message seen only once', async () => {
    const store = createStore(fakeRedis());
    expect(await store.markMessageSeen('wamid.1')).toBe(true);
    expect(await store.markMessageSeen('wamid.1')).toBe(false);
  });

  it('trims conversation history to the last 40 messages', async () => {
    const store = createStore(fakeRedis());
    const many = Array.from({ length: 60 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }));
    await store.saveConversation('p', many);
    const conv = await store.getConversation('p');
    expect(conv).toHaveLength(40);
    expect(conv[conv.length - 1].content).toBe('m59');
  });

  it('listTransfers returns saved transfers newest first by createdAt', async () => {
    const store = createStore(fakeRedis());
    const oldest = makeTransfer({ id: 'old1', createdAt: '2026-01-01T00:00:00.000Z' });
    const middle = makeTransfer({ id: 'mid1', createdAt: '2026-03-01T00:00:00.000Z' });
    const newest = makeTransfer({ id: 'new1', createdAt: '2026-05-01T00:00:00.000Z' });
    // Save in random order
    await store.saveTransfer(middle);
    await store.saveTransfer(oldest);
    await store.saveTransfer(newest);
    const list = await store.listTransfers();
    expect(list).toHaveLength(3);
    expect(list[0].id).toBe('new1');
    expect(list[1].id).toBe('mid1');
    expect(list[2].id).toBe('old1');
  });

  it('re-saving the same transfer does not duplicate it in the index', async () => {
    const store = createStore(fakeRedis());
    const t = makeTransfer({ id: 'dup1' });
    await store.saveTransfer(t);
    await store.saveTransfer({ ...t, status: 'paid' });
    await store.saveTransfer({ ...t, status: 'delivered' });
    const list = await store.listTransfers();
    const matches = list.filter((x) => x.id === 'dup1');
    expect(matches).toHaveLength(1);
    expect(matches[0].status).toBe('delivered');
  });
});
