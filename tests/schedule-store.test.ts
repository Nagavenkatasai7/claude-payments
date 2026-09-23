import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createScheduleStore } from '@/lib/schedule-store';
import { freshDb, seedPartner } from './helpers-db';
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

// Program-Fix 36 (schedules-02): status writes are column-targeted and
// CONDITIONAL, and the cron's lastRunAt bump touches only last_run_at — so a
// staff pause can never be resurrected by a stale whole-row save.
describe('schedule-store — setStatusIf / markRun (Program-Fix 36)', () => {
  async function rawRow(db: Awaited<ReturnType<typeof freshDb>>, id: string) {
    const r = await db.execute(
      sql`SELECT status, payout_destination_enc, last_run_at FROM schedules WHERE id = ${id}`,
    );
    return (r as unknown as { rows: Array<{ status: string; payout_destination_enc: string; last_run_at: string | null }> }).rows[0];
  }

  it('setStatusIf on an active row flips it and returns the row; a second identical call returns null', async () => {
    const db = await freshDb();
    const s = createScheduleStore(db);
    await s.saveSchedule(schedule('a'));
    const flipped = await s.setStatusIf('a', 'default', ['active'], 'paused');
    expect(flipped?.id).toBe('a');
    expect(flipped?.status).toBe('paused');
    expect((await s.getSchedule('a'))?.status).toBe('paused');
    expect(await s.setStatusIf('a', 'default', ['active'], 'paused')).toBeNull();
  });

  it('setStatusIf with the wrong partnerId returns null and writes nothing (tenant guard in the WHERE)', async () => {
    const db = await freshDb();
    await seedPartner(db, 'B');
    const s = createScheduleStore(db);
    await s.saveSchedule(schedule('a'));
    expect(await s.setStatusIf('a', 'B', ['active'], 'paused')).toBeNull();
    expect((await rawRow(db, 'a')).status).toBe('active');
  });

  it('setStatusIf accepts a multi-value from list (cancel from active OR paused)', async () => {
    const db = await freshDb();
    const s = createScheduleStore(db);
    await s.saveSchedule(schedule('a', 'paused'));
    const r = await s.setStatusIf('a', 'default', ['active', 'paused'], 'cancelled');
    expect(r?.status).toBe('cancelled');
  });

  it('listActiveSchedules excludes paused too', async () => {
    const s = await makeStore();
    await s.saveSchedule(schedule('a', 'active'));
    await s.saveSchedule(schedule('b', 'paused'));
    expect((await s.listActiveSchedules()).map((x) => x.id)).toEqual(['a']);
  });

  it('markRun changes only last_run_at: status and the encrypted destination bytes are untouched', async () => {
    const db = await freshDb();
    const s = createScheduleStore(db);
    await s.saveSchedule(schedule('a'));
    // A staff pause lands between the cron's read and its bump…
    await s.setStatusIf('a', 'default', ['active'], 'paused');
    const before = await rawRow(db, 'a');
    expect(before.last_run_at).toBeNull();
    const at = new Date('2026-05-21T16:00:00.000Z');
    await s.markRun('a', at);
    const after = await rawRow(db, 'a');
    expect(after.status).toBe('paused'); // …and is NOT resurrected
    // saveSchedule would re-encrypt with a fresh nonce; identical bytes prove
    // the write named only last_run_at.
    expect(after.payout_destination_enc).toBe(before.payout_destination_enc);
    expect((await s.getSchedule('a'))?.lastRunAt).toBe(at.toISOString());
  });
});
