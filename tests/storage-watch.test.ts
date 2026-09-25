import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { freshDb } from './helpers-db';
import type { Db } from '@/db/client';
import {
  STORAGE_ALARMS_MB,
  bytesToMb,
  storageAlarmLevel,
  measureDatabaseBytes,
  checkStorageCap,
} from '@/lib/storage-watch';

// partner-demo R3a (owner decision C1): the Neon Free storage cap-watch. The
// daily cron measures sum(pg_database_size) and raises ONE deduped ops.alert
// per crossed threshold (300 MB, 400 MB) per UTC day; the ops page shows MB used.

const MB = 1_000_000; // decimal megabytes, the unit the brief measured in

describe('storageAlarmLevel / bytesToMb (pure)', () => {
  it('pins the owner-approved thresholds', () => {
    expect(STORAGE_ALARMS_MB).toEqual([300, 400]);
  });

  it('is 0 below 300 MB, 300 from 300 MB, 400 from 400 MB (highest crossed only)', () => {
    expect(storageAlarmLevel(0)).toBe(0);
    expect(storageAlarmLevel(34_258_944)).toBe(0);
    expect(storageAlarmLevel(300 * MB - 1)).toBe(0);
    expect(storageAlarmLevel(300 * MB)).toBe(300);
    expect(storageAlarmLevel(399 * MB)).toBe(300);
    expect(storageAlarmLevel(400 * MB)).toBe(400);
    expect(storageAlarmLevel(2_000 * MB)).toBe(400);
  });

  it('converts bytes to decimal MB with one decimal', () => {
    expect(bytesToMb(34_258_944)).toBe(34.3);
    expect(bytesToMb(0)).toBe(0);
  });
});

describe('measureDatabaseBytes / checkStorageCap (PGlite)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await freshDb();
  });

  async function alertRows() {
    const r = await db.execute(sql`SELECT kind, payload, dedupe_key FROM outbox WHERE kind = 'ops.alert' ORDER BY id`);
    return (r as unknown as { rows: Array<{ kind: string; payload: { message: string }; dedupe_key: string }> }).rows;
  }

  it('measures a positive size from pg_database', async () => {
    const bytes = await measureDatabaseBytes(db);
    expect(Number.isFinite(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
  });

  it('below 300 MB: no alert row', async () => {
    const now = new Date('2026-09-25T13:00:00.000Z');
    const r = await checkStorageCap(db, now, { measure: async () => 120 * MB });
    expect(r).toEqual({ bytes: 120 * MB, mb: 120, level: 0, alerted: false });
    expect(await alertRows()).toEqual([]);
  });

  it('at 300 MB: one ops.alert, deduped per UTC day (the 13:00 run, the 17:00 catch-up, a re-run)', async () => {
    const measure = async () => 312 * MB;
    const first = await checkStorageCap(db, new Date('2026-09-25T13:00:00.000Z'), { measure });
    expect(first).toMatchObject({ level: 300, alerted: true, mb: 312 });
    expect((await checkStorageCap(db, new Date('2026-09-25T17:00:00.000Z'), { measure })).alerted).toBe(false);
    expect((await checkStorageCap(db, new Date('2026-09-25T23:59:00.000Z'), { measure })).alerted).toBe(false);
    const rows = await alertRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupe_key).toBe('storagecap:300:2026-09-25');
    expect(rows[0].payload).toEqual({ message: expect.stringContaining('312') });
    expect(Object.keys(rows[0].payload)).toEqual(['message']);
    // A new UTC day while still above the line ⇒ a new reminder.
    expect((await checkStorageCap(db, new Date('2026-09-26T13:00:00.000Z'), { measure })).alerted).toBe(true);
    expect(await alertRows()).toHaveLength(2);
  });

  it('at 400 MB: only the 400 alert (not also 300), naming the pre-approved Neon Launch upgrade', async () => {
    const r = await checkStorageCap(db, new Date('2026-09-25T13:00:00.000Z'), { measure: async () => 401 * MB });
    expect(r).toMatchObject({ level: 400, alerted: true });
    const rows = await alertRows();
    expect(rows.map((x) => x.dedupe_key)).toEqual(['storagecap:400:2026-09-25']);
    expect(rows[0].payload.message).toMatch(/Launch/);
  });

  it('crossing 400 on a day that already raised 300 still raises the 400 alert', async () => {
    const now = new Date('2026-09-25T13:00:00.000Z');
    await checkStorageCap(db, now, { measure: async () => 350 * MB });
    const r = await checkStorageCap(db, new Date('2026-09-25T17:00:00.000Z'), { measure: async () => 405 * MB });
    expect(r.alerted).toBe(true);
    expect((await alertRows()).map((x) => x.dedupe_key)).toEqual(['storagecap:300:2026-09-25', 'storagecap:400:2026-09-25']);
  });
});
