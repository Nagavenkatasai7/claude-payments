import { describe, it, expect } from 'vitest';
import { createScheduleStore } from '@/lib/schedule-store';
import { freshDb, seedPartner } from './helpers-db';
import type { Schedule } from '@/lib/types';

// Postgres cutover: the lazy partnerId fill (read-through to the owning
// customer, fallback to DEFAULT_PARTNER_ID) is GONE — legacy Redis schedule
// records no longer exist, and every row is born complete with a NOT NULL
// partnerId that has a real FK to partners. The three lazy-fill cases were
// deleted; what still applies is asserted below: partnerId persists exactly
// as written, for default and custom partners alike.

function schedule(id: string, partnerId: string): Schedule {
  return {
    id, phone: '15551112222', amountUsd: 100,
    recipientName: 'Mom', recipientPhone: '919876543210',
    payoutMethod: 'upi', payoutDestination: 'mom@upi', fundingMethod: 'bank_transfer',
    frequency: 'monthly', dayOfMonth: 2, status: 'active',
    createdAt: '2026-04-01T00:00:00.000Z',
    partnerId,
    sourceCurrency: 'USD',
    amountSource: 100,
  };
}

describe('schedule-store partnerId (born complete)', () => {
  it('persists a custom partnerId as written and returns it on read', async () => {
    const db = await freshDb();
    await seedPartner(db, 'acme'); // schedules.partner_id has a real FK
    const s = createScheduleStore(db);
    await s.saveSchedule(schedule('S1', 'acme'));
    expect((await s.getSchedule('S1'))?.partnerId).toBe('acme');
  });

  it('listSchedules returns the stored partnerId for every schedule', async () => {
    const db = await freshDb();
    await seedPartner(db, 'beta');
    const s = createScheduleStore(db);
    await s.saveSchedule(schedule('S2', 'beta'));
    await s.saveSchedule(schedule('S3', 'default'));
    const all = await s.listSchedules();
    const byId = new Map(all.map((x) => [x.id, x.partnerId]));
    expect(byId.get('S2')).toBe('beta');
    expect(byId.get('S3')).toBe('default');
  });

  it('rejects a schedule whose partnerId has no partner row (FK enforced)', async () => {
    const db = await freshDb();
    const s = createScheduleStore(db);
    await expect(s.saveSchedule(schedule('S4', 'ghost'))).rejects.toThrow();
  });
});
