import { getDb, type DbOrTx } from '@/db/client';
import { createScheduleRepo } from '@/db/repos/schedule-repo';
import type { Schedule } from './types';

// schedule-store — CUT OVER to Postgres (Stage 2a). Same module path + surface
// (getSchedule / saveSchedule / listSchedules / listActiveSchedules); payout
// destinations are encrypted at rest. Fresh start: the pre-P3/P4 lazy-fill
// shims (partnerId-from-customer, USD defaults) are gone — every schedule row
// is born complete.
export type { Schedule };

export function createScheduleStore(db: DbOrTx) {
  return createScheduleRepo(db);
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>;

let cached: ScheduleStore | null = null;

export function getScheduleStore(): ScheduleStore {
  if (!cached) cached = createScheduleStore(getDb());
  return cached;
}
