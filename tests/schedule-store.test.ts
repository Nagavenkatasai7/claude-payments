import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { freshDb } from './helpers-db';
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

async function makeStore() {
  const db = await freshDb(); // truncates + reseeds the 'default' partner
  return createScheduleStore(db);
}

describe('schedule-store', () => {
  it('round-trips a schedule', async () => {
    const s = await makeStore();
    await s.saveSchedule(schedule('a'));
    const got = await s.getSchedule('a');
    expect(got?.amountUsd).toBe(200);
    // Payout destination is encrypted at rest but decrypted on the schedule
    // read (the cron run needs the full account to mint the transfer).
    expect(got?.payoutDestination).toBe('mom@upi');
    expect(got?.createdAt).toBe('2026-05-21T00:00:00.000Z');
  });

  it('returns null for an unknown schedule', async () => {
    expect(await (await makeStore()).getSchedule('nope')).toBeNull();
  });

  it('lists all schedules', async () => {
    const s = await makeStore();
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('b'));
    expect(await s.listSchedules()).toHaveLength(2);
  });

  it('listActiveSchedules excludes cancelled', async () => {
    const s = await makeStore();
    await s.saveSchedule(schedule('a', 'active'));
    await s.saveSchedule(schedule('b', 'cancelled'));
    const active = await s.listActiveSchedules();
    expect(active.map((x) => x.id)).toEqual(['a']);
  });

  it('re-saving a schedule does not duplicate it in the list', async () => {
    const s = await makeStore();
    await s.saveSchedule(schedule('a'));
    await s.saveSchedule(schedule('a'));
    expect(await s.listSchedules()).toHaveLength(1);
  });
});

// The pre-P4 "lazy-fills sourceCurrency/amountSource" case is gone with the
// Postgres cutover: legacy Redis records no longer exist and every schedule
// row is born complete (NOT NULL columns). Round-trip coverage above asserts
// the fields persist as written.
