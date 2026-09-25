import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';

// storage-watch — partner-demo R3a, owner decision C1 (2026-09-24): the Neon
// Free plan caps logical storage at 0.5 GB. Alarm at 300 MB and at 400 MB; the
// Neon Launch upgrade is pre-approved at 400 MB.
//
//  - measureDatabaseBytes: READ-ONLY, sum(pg_database_size) over the databases
//    this role may connect to (validated against Neon's logical_size in the R3
//    brief). Used by the /admin-dashboard/ops "Database storage" card.
//  - checkStorageCap: the ENQUEUER. Called ONLY from the daily /api/cron route
//    (which pokes the worker afterwards; never the per-minute worker, R4's
//    compute budget). Raises one deduped ops.alert for the HIGHEST crossed
//    threshold, keyed `storagecap:<threshold>:<UTC day>`: the 13:00 run, the
//    17:00 catch-up and manual re-runs collapse to one alert, and a lasting
//    breach re-alerts once a day. The payload is `{ message }` with sizes only.
//
// Units: DECIMAL megabytes (1 MB = 1,000,000 bytes), matching the brief's
// measurements and Neon's GB; it is also the earlier (conservative) trigger.

export const STORAGE_ALARMS_MB = [300, 400] as const;
export type StorageAlarmLevel = 0 | (typeof STORAGE_ALARMS_MB)[number];

const BYTES_PER_MB = 1_000_000;

/** Decimal MB, one decimal place. */
export function bytesToMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/** The highest crossed threshold (MB), or 0 below the first. */
export function storageAlarmLevel(bytes: number): StorageAlarmLevel {
  let level: StorageAlarmLevel = 0;
  for (const mb of STORAGE_ALARMS_MB) if (bytes >= mb * BYTES_PER_MB) level = mb;
  return level;
}

/** Total on-disk size of every database this role can connect to, in bytes. */
export async function measureDatabaseBytes(db: DbOrTx): Promise<number> {
  const r = await db.execute(sql`
    SELECT COALESCE(SUM(pg_database_size(datname)), 0)::bigint AS bytes
    FROM pg_database
    WHERE has_database_privilege(datname, 'CONNECT')`);
  const rows = (r as unknown as { rows: Array<{ bytes: string | number | bigint }> }).rows;
  return Number(rows[0]?.bytes ?? 0);
}

export interface StorageCapResult {
  bytes: number;
  mb: number;
  level: StorageAlarmLevel;
  /** A NEW ops.alert row was enqueued by this call. */
  alerted: boolean;
}

export interface StorageCapDeps {
  /** Test seam: the size source (default measureDatabaseBytes). */
  measure?: (db: DbOrTx) => Promise<number>;
}

export async function checkStorageCap(db: DbOrTx, now: Date, deps: StorageCapDeps = {}): Promise<StorageCapResult> {
  const bytes = await (deps.measure ?? measureDatabaseBytes)(db);
  const mb = bytesToMb(bytes);
  const level = storageAlarmLevel(bytes);
  if (level === 0) return { bytes, mb, level, alerted: false };
  const day = now.toISOString().slice(0, 10);
  const action =
    level === 400
      ? 'The Neon Launch upgrade is pre-approved at this level: upgrade the plan now.'
      : 'Plan the Neon Launch upgrade (pre-approved at 400 MB).';
  const alerted = await createOutboxRepo(db).enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: the database is using ${mb} MB of the Neon Free 0.5 GB cap ` +
        `(alarm at ${level} MB). ${action}`,
    },
    { dedupeKey: `storagecap:${level}:${day}` },
  );
  return { bytes, mb, level, alerted };
}
