import { describe, it, expect } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import type { Transfer } from '@/lib/types';
import { easternDate } from '@/lib/dates';

function sampleTransfer(id: string, createdAt: string): Transfer {
  return {
    id,
    phone: '15551234567',
    amountUsd: 500,
    feeUsd: 0,
    totalChargeUsd: 500,
    fxRate: 85,
    amountInr: 42500,
    recipientName: 'Mom',
    recipientPhone: '919133001840',
    payoutMethod: 'upi',
    payoutDestination: 'mom@upi',
    fundingMethod: 'bank_transfer',
    complianceStatus: 'cleared',
    complianceReasons: [],
    status: 'awaiting_payment',
    createdAt,
    sourceCountry: 'US',
    sourceCurrency: 'USD',
    destinationCountry: 'IN',
    destinationCurrency: 'INR',
    partnerId: 'default',
  };
}

describe('store transfers index', () => {
  it('listTransfers returns saved transfers newest-first', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('b', '2026-05-21T03:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('c', '2026-05-21T02:00:00.000Z'));
    const ids = (await store.listTransfers()).map((t) => t.id);
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('re-saving a transfer does not duplicate it in the index', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    await store.saveTransfer(sampleTransfer('a', '2026-05-21T01:00:00.000Z'));
    expect(await store.listTransfers()).toHaveLength(1);
  });
});

describe('store transfer count', () => {
  it('defaults to 0 and increments atomically', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTransferCount('p')).toBe(0);
    await store.incrementTransferCount('p');
    await store.incrementTransferCount('p');
    expect(await store.getTransferCount('p')).toBe(2);
  });

  it('counts are isolated per phone', async () => {
    const store = createStore(fakeRedis());
    await store.incrementTransferCount('p1');
    expect(await store.getTransferCount('p1')).toBe(1);
    expect(await store.getTransferCount('p2')).toBe(0);
  });
});

describe('store velocity counter', () => {
  it('defaults today count to 0 and increments', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getTodayTransferCount('p')).toBe(0);
    await store.incrementTodayTransferCount('p');
    await store.incrementTodayTransferCount('p');
    expect(await store.getTodayTransferCount('p')).toBe(2);
  });

  it('velocity is isolated per phone', async () => {
    const store = createStore(fakeRedis());
    await store.incrementTodayTransferCount('p1');
    expect(await store.getTodayTransferCount('p1')).toBe(1);
    expect(await store.getTodayTransferCount('p2')).toBe(0);
  });

  it('uses an eastern-date-keyed velocity key', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    await store.incrementTodayTransferCount('p');
    expect(redis.dump.has(`velocity:p:${easternDate(Date.now())}`)).toBe(true);
  });
});

describe('store', () => {
  it('round-trips a transfer', async () => {
    const store = createStore(fakeRedis());
    await store.saveTransfer(sampleTransfer('abc12345', '2026-05-21T00:00:00.000Z'));
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
