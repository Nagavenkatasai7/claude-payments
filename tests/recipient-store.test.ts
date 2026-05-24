import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';
import { createTransfer } from '@/lib/transfer-create';
import { resetRateCacheForTests } from '@/lib/rate';

const SENDER = '15551234567';
const OTHER = '15559999999';

function mom(at: string) {
  return {
    name: 'Mom',
    recipientPhone: '919876543210',
    payoutMethod: 'upi' as const,
    payoutDestination: 'mom@upi',
    lastUsedAt: at,
  };
}

function brother(at: string) {
  return {
    name: 'Brother',
    recipientPhone: '919999999999',
    payoutMethod: 'bank' as const,
    payoutDestination: 'ACC123 IFSC456',
    lastUsedAt: at,
  };
}

describe('recipient store', () => {
  it('returns [] when no recipients are saved', async () => {
    const store = createStore(fakeRedis());
    expect(await store.listRecipients(SENDER, 3)).toEqual([]);
  });

  it('upsertRecipient saves a recipient that listRecipients then returns', async () => {
    const store = createStore(fakeRedis());
    await store.upsertRecipient(SENDER, mom('2026-05-23T12:00:00Z'));
    expect(await store.listRecipients(SENDER, 3)).toEqual([
      mom('2026-05-23T12:00:00Z'),
    ]);
  });

  it('upsertRecipient updates lastUsedAt on the same recipientPhone', async () => {
    const store = createStore(fakeRedis());
    await store.upsertRecipient(SENDER, mom('2026-05-23T12:00:00Z'));
    await store.upsertRecipient(SENDER, {
      ...mom('2026-05-23T13:00:00Z'),
      payoutDestination: 'mommy@upi',
    });
    const list = await store.listRecipients(SENDER, 3);
    expect(list).toHaveLength(1);
    expect(list[0].payoutDestination).toBe('mommy@upi');
    expect(list[0].lastUsedAt).toBe('2026-05-23T13:00:00Z');
  });

  it('listRecipients returns top-N sorted by lastUsedAt descending', async () => {
    const store = createStore(fakeRedis());
    await store.upsertRecipient(SENDER, mom('2026-05-23T10:00:00Z'));
    await store.upsertRecipient(SENDER, brother('2026-05-23T12:00:00Z'));
    const list = await store.listRecipients(SENDER, 3);
    expect(list.map((r) => r.name)).toEqual(['Brother', 'Mom']);
  });

  it('listRecipients limits to N', async () => {
    const store = createStore(fakeRedis());
    await store.upsertRecipient(SENDER, mom('2026-05-23T10:00:00Z'));
    await store.upsertRecipient(SENDER, brother('2026-05-23T12:00:00Z'));
    const list = await store.listRecipients(SENDER, 1);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Brother');
  });

  it('two senders do not see each others recipients', async () => {
    const store = createStore(fakeRedis());
    await store.upsertRecipient(SENDER, mom('2026-05-23T12:00:00Z'));
    expect(await store.listRecipients(OTHER, 3)).toEqual([]);
  });
});

describe('last-inbound tracking', () => {
  it('getLastInboundAt returns null before any inbound', async () => {
    const store = createStore(fakeRedis());
    expect(await store.getLastInboundAt(SENDER)).toBeNull();
  });

  it('recordInboundNow then getLastInboundAt returns a present value', async () => {
    const store = createStore(fakeRedis());
    await store.recordInboundNow(SENDER);
    expect(await store.getLastInboundAt(SENDER)).not.toBeNull();
  });
});

describe('createTransfer side-effects', () => {
  beforeEach(() => {
    resetRateCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ rates: { INR: 85.2 } }),
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('upserts the recipient after a successful transfer', async () => {
    const store = createStore(fakeRedis());
    await createTransfer(store, {
      phone: '15551234567',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
    });
    const saved = await store.listRecipients('15551234567', 3);
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Mom');
    expect(saved[0].recipientPhone).toBe('919876543210');
    expect(saved[0].payoutDestination).toBe('mom@upi');
  });

  it('idempotently bumps lastUsedAt on a repeat transfer to the same recipient', async () => {
    const store = createStore(fakeRedis());
    const input = {
      phone: '15551234567',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi' as const,
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer' as const,
    };
    await createTransfer(store, input);
    const firstList = await store.listRecipients('15551234567', 3);
    const firstAt = firstList[0].lastUsedAt;

    await new Promise((r) => setTimeout(r, 10));
    await createTransfer(store, input);
    const secondList = await store.listRecipients('15551234567', 3);

    expect(secondList).toHaveLength(1);
    expect(secondList[0].lastUsedAt > firstAt).toBe(true);
  });
});
