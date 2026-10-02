import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '@/db/client';
import { schedules } from '@/db/schema';
import { isScheduleId } from '@/lib/portal-schedules';
import type { PartnerScheduleRecord } from '@/lib/partner-schedules';
import type { CurrencyCode, PartnerId, ScheduleFrequency, ScheduleStatus } from '@/lib/types';

// partner-schedule-reads (merge plan 2a): the /partner Schedules page's READS. Read-only. The
// partner id comes FIRST and is REQUIRED (the session tenant from requirePartnerStaff, never request
// input) and is in every WHERE. An explicit column list WITHOUT payout_destination_enc: only the
// stored last 4 is read, so nothing is decrypted for this page. (The shared schedule-repo's
// listSchedules scans every tenant and decrypts; it is not used here.)

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

function requireTenant(partnerId: PartnerId): void {
  if (typeof partnerId !== 'string' || partnerId.length === 0) throw new Error('partner-schedule-reads: a tenant is required');
}

const COLUMNS = {
  id: schedules.id,
  phone: schedules.phone,
  amountSource: schedules.amountSource,
  sourceCurrency: schedules.sourceCurrency,
  recipientName: schedules.recipientName,
  payoutMethod: schedules.payoutMethod,
  payoutDestinationLast4: schedules.payoutDestinationLast4,
  frequency: schedules.frequency,
  dayOfMonth: schedules.dayOfMonth,
  dayOfWeek: schedules.dayOfWeek,
  status: schedules.status,
  endDate: schedules.endDate,
  lastRunAt: schedules.lastRunAt,
  createdAt: schedules.createdAt,
};

type Row = {
  id: string;
  phone: string;
  amountSource: string;
  sourceCurrency: string;
  recipientName: string;
  payoutMethod: string;
  payoutDestinationLast4: string;
  frequency: string;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  status: string;
  endDate: string | null;
  lastRunAt: Date | null;
  createdAt: Date;
};

function toRecord(r: Row): PartnerScheduleRecord {
  const s: PartnerScheduleRecord = {
    id: r.id,
    phone: r.phone,
    amountSource: Number(r.amountSource),
    sourceCurrency: r.sourceCurrency as CurrencyCode,
    recipientName: r.recipientName,
    payoutMethod: r.payoutMethod,
    payoutDestinationLast4: r.payoutDestinationLast4,
    frequency: r.frequency as ScheduleFrequency,
    status: r.status as ScheduleStatus,
    createdAt: r.createdAt.toISOString(),
  };
  if (r.dayOfMonth !== null) s.dayOfMonth = r.dayOfMonth;
  if (r.dayOfWeek !== null) s.dayOfWeek = r.dayOfWeek;
  if (r.endDate) s.endDate = r.endDate;
  if (r.lastRunAt) s.lastRunAt = r.lastRunAt.toISOString();
  return s;
}

/** THIS tenant's schedules, newest first, capped. */
export async function listPartnerSchedules(db: DbOrTx, partnerId: PartnerId, opts: { limit?: number } = {}): Promise<PartnerScheduleRecord[]> {
  requireTenant(partnerId);
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT) || 1), MAX_LIMIT);
  const rows = await db.select(COLUMNS).from(schedules).where(eq(schedules.partnerId, partnerId)).orderBy(desc(schedules.createdAt), desc(schedules.id)).limit(limit);
  return rows.map(toRecord);
}

/** One of THIS tenant's schedules, or null for a missing, foreign or malformed id. */
export async function getPartnerSchedule(db: DbOrTx, partnerId: PartnerId, id: unknown): Promise<PartnerScheduleRecord | null> {
  requireTenant(partnerId);
  if (!isScheduleId(id)) return null;
  const rows = await db.select(COLUMNS).from(schedules).where(and(eq(schedules.id, id), eq(schedules.partnerId, partnerId))).limit(1);
  return rows[0] ? toRecord(rows[0]) : null;
}

export const PARTNER_SCHEDULES_LIMIT = DEFAULT_LIMIT;
