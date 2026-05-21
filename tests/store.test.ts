import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';

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
});
