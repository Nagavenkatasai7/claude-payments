import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { createCustomerStore } from '@/lib/customer-store';
import { createStore } from '@/lib/store';
import { fakeRedis } from './helpers';

describe('schedule-store lazy-fill partnerId', () => {
  it('reads partnerId from the owning customer when missing on the raw record', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await customerStore.saveCustomer({
      senderPhone: '15551112222',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'acme',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    // Legacy raw schedule (no partnerId on disk).
    await redis.set('schedule:LEG1', JSON.stringify({
      id: 'LEG1',
      phone: '15551112222',
      amountUsd: 100,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'LEG1');

    const s = createScheduleStore(redis, customerStore);
    const got = await s.getSchedule('LEG1');
    expect(got?.partnerId).toBe('acme');

    // Read must NOT have persisted the lazy-fill (Redis raw still missing).
    const raw = JSON.parse((await redis.get('schedule:LEG1'))!);
    expect(raw.partnerId).toBeUndefined();
  });

  it('falls back to DEFAULT_PARTNER_ID when the owning customer cannot be found', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await redis.set('schedule:LEG2', JSON.stringify({
      id: 'LEG2',
      phone: '15559999999',
      amountUsd: 100,
      recipientName: 'X',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'x@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'LEG2');

    const s = createScheduleStore(redis, customerStore);
    const got = await s.getSchedule('LEG2');
    expect(got?.partnerId).toBe('default');
  });

  it('listSchedules returns lazy-filled partnerId for every schedule', async () => {
    const redis = fakeRedis();
    const store = createStore(redis);
    const customerStore = createCustomerStore(redis, store);
    await customerStore.saveCustomer({
      senderPhone: '15553334444',
      firstSeenAt: '2026-01-01T00:00:00Z',
      kycStatus: 'verified',
      senderCountry: 'US',
      partnerId: 'beta',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    await redis.set('schedule:LEG3', JSON.stringify({
      id: 'LEG3',
      phone: '15553334444',
      amountUsd: 50,
      recipientName: 'Mom',
      recipientPhone: '919876543210',
      payoutMethod: 'upi',
      payoutDestination: 'mom@upi',
      fundingMethod: 'bank_transfer',
      frequency: 'monthly',
      dayOfMonth: 2,
      status: 'active',
      createdAt: '2026-04-01T00:00:00Z',
    }));
    await redis.sadd('schedules:ids', 'LEG3');

    const s = createScheduleStore(redis, customerStore);
    const all = await s.listSchedules();
    expect(all).toHaveLength(1);
    expect(all[0].partnerId).toBe('beta');
  });
});
