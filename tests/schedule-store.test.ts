import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { createStore } from '@/lib/store';
import { createCustomerStore } from '@/lib/customer-store';
import { fakeRedis } from './helpers';
import type { Schedule } from '@/lib/types';

function schedule(id: string, status: Schedule['status'] = 'active'): Schedule {
  return {
    id, phone: '15551234567', amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 2, status,
    createdAt: '2026-05-21T00:00:00.000Z',
    partnerId: 'default',
    sourceCurrency: 'USD',
    amountSource: 200,
  };
}

function makeStore() {
  const redis = fakeRedis();
  const store = createStore(redis);
  const cs = createCustomerStore(redis, store);
  return createScheduleStore(redis, cs);
}

describe('schedule-store', () => {
  it('round-trips a schedule', async () => {
    const s = makeStore();
    await s.saveSchedule(schedule('a'));
    expect((await s.getSchedule('a'))?.amountUsd).toBe(200);
  });

  it('returns null for an unknown schedule', async () => {
    expect(await makeStore().getSchedule('nope')).toBeNull();
  });

  it('lists all schedules', async () => {
    const s = makeStore();
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('b'));
    expect(await s.listSchedules()).toHaveLength(2);
  });

  it('listActiveSchedules excludes cancelled', async () => {
    const s = makeStore();
    await s.saveSchedule(schedule('a', 'active'));
    await s.saveSchedule(schedule('b', 'cancelled'));
    const active = await s.listActiveSchedules();
    expect(active.map((x) => x.id)).toEqual(['a']);
  });

  it('re-saving a schedule does not duplicate it in the index', async () => {
    const s = makeStore();
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('a'));
    expect(await s.listSchedules()).toHaveLength(1);
  });
});

describe('schedule-store P4 lazy-fills', () => {
  it('P4: lazy-fills sourceCurrency/amountSource for pre-P4 schedules', async () => {
    const redis = fakeRedis();
    await redis.set('schedule:s1', JSON.stringify({
      id: 's1', phone: '15551230000', amountUsd: 100, recipientName: 'Asha',
      recipientPhone: '919876543210', payoutMethod: 'upi', payoutDestination: 'asha@upi',
      fundingMethod: 'bank_transfer', frequency: 'monthly', dayOfMonth: 1,
      status: 'active', createdAt: '2026-01-01T00:00:00Z', partnerId: 'default',
    }));
    await redis.sadd('schedules:ids', 's1');
    const store = createScheduleStore(redis, createCustomerStore(redis, createStore(redis)));
    const s = await store.getSchedule('s1');
    expect(s?.sourceCurrency).toBe('USD');
    expect(s?.amountSource).toBe(100);
  });
});
