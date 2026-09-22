import { describe, it, expect, beforeEach } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { freshDb } from './helpers-db';
import { blankPreFixScheduleDestinations } from '../scripts/blank-prefix-schedule-destinations';
import type { Db } from '@/db/client';
import type { Schedule } from '@/lib/types';

const DAY = 86_400_000;
const s = (id: string, dest: string, over: Partial<Schedule> = {}): Schedule => ({
  id, phone: '15551234567', amountUsd: 100, recipientName: 'Mom', recipientPhone: '919876543210',
  payoutMethod: 'upi', payoutDestination: dest, fundingMethod: 'bank_transfer', frequency: 'monthly',
  dayOfMonth: 5, status: 'active', createdAt: new Date(Date.now() - 2 * DAY).toISOString(), partnerId: 'default',
  sourceCurrency: 'USD', amountSource: 100, ...over,
});

describe('scripts/blank-prefix-schedule-destinations (fix 6 / ctx-01)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
    const store = createScheduleStore(db);
    await store.saveSchedule(s('pre', 'xxxx9012'));
    await store.saveSchedule(s('pre_cancelled', 'xxxx9012', { status: 'cancelled' }));
    await store.saveSchedule(s('pre_empty', ''));
    await store.saveSchedule(s('post', 'HDFC0001234 123456789012', { createdAt: new Date().toISOString() }));
  });

  it('DRY RUN (default) counts the pre-cutoff active schedules holding any destination and changes nothing', async () => {
    const r = await blankPreFixScheduleDestinations(db, { before: new Date(Date.now() - DAY), apply: false });
    expect(r).toEqual({ count: 1, ids: ['pre'], applied: false });
    expect((await createScheduleStore(db).getSchedule('pre'))?.payoutDestination).toBe('xxxx9012');
  });

  it('APPLY blanks exactly those to "" / bank — post-cutoff, cancelled and empty schedules untouched', async () => {
    const r = await blankPreFixScheduleDestinations(db, { before: new Date(Date.now() - DAY), apply: true });
    expect(r).toEqual({ count: 1, ids: ['pre'], applied: true });
    const store = createScheduleStore(db);
    expect(await store.getSchedule('pre')).toMatchObject({ payoutDestination: '', payoutMethod: 'bank' });
    expect((await store.getSchedule('pre_cancelled'))?.payoutDestination).toBe('xxxx9012');
    expect((await store.getSchedule('post'))?.payoutDestination).toBe('HDFC0001234 123456789012');
  });
});
