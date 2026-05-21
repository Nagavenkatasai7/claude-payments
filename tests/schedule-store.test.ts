import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { fakeRedis } from './helpers';
import type { Schedule } from '@/lib/types';

function schedule(id: string, status: Schedule['status'] = 'active'): Schedule {
  return {
    id, phone: '15551234567', amountUsd: 200,
    recipientName: 'Mom', recipientPhone: '919133001840',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 2, status,
    createdAt: '2026-05-21T00:00:00.000Z',
  };
}

describe('schedule-store', () => {
  it('round-trips a schedule', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a'));
    expect((await s.getSchedule('a'))?.amountUsd).toBe(200);
  });

  it('returns null for an unknown schedule', async () => {
    expect(await createScheduleStore(fakeRedis()).getSchedule('nope')).toBeNull();
  });

  it('lists all schedules', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('b'));
    expect(await s.listSchedules()).toHaveLength(2);
  });

  it('listActiveSchedules excludes cancelled', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a', 'active'));
    await s.saveSchedule(schedule('b', 'cancelled'));
    const active = await s.listActiveSchedules();
    expect(active.map((x) => x.id)).toEqual(['a']);
  });

  it('re-saving a schedule does not duplicate it in the index', async () => {
    const s = createScheduleStore(fakeRedis());
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('a'));
    expect(await s.listSchedules()).toHaveLength(1);
  });
});
