import { asc, eq } from 'drizzle-orm';
import { schedules } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { last4, openOptional } from './mappers';
import { encryptField } from '@/lib/field-crypto';
import type {
  CurrencyCode,
  FundingMethod,
  PayoutMethod,
  Schedule,
  ScheduleFrequency,
  ScheduleStatus,
} from '@/lib/types';

// schedule-repo — mirrors schedule-store (getSchedule / saveSchedule /
// listSchedules / listActiveSchedules). Payout destinations encrypted at rest
// (recurring sends carry full bank accounts too); the cron run decrypts.

type ScheduleRow = typeof schedules.$inferSelect;

export function createScheduleRepo(
  db: DbOrTx,
  provider: EncryptionKeyProvider = defaultProvider(),
) {
  function rowToSchedule(row: ScheduleRow): Schedule {
    const s: Schedule = {
      id: row.id,
      phone: row.phone,
      amountUsd: Number(row.amountUsd),
      recipientName: row.recipientName,
      recipientPhone: row.recipientPhone,
      payoutMethod: row.payoutMethod as PayoutMethod,
      payoutDestination: openOptional(row.payoutDestinationEnc, provider) ?? '',
      fundingMethod: row.fundingMethod as FundingMethod,
      frequency: row.frequency as ScheduleFrequency,
      status: row.status as ScheduleStatus,
      createdAt: row.createdAt.toISOString(),
      partnerId: row.partnerId,
      sourceCurrency: row.sourceCurrency as CurrencyCode,
      amountSource: Number(row.amountSource),
    };
    if (row.dayOfMonth !== null) s.dayOfMonth = row.dayOfMonth;
    if (row.dayOfWeek !== null) s.dayOfWeek = row.dayOfWeek;
    if (row.lastRunAt) s.lastRunAt = row.lastRunAt.toISOString();
    if (row.endDate) s.endDate = row.endDate;
    return s;
  }

  function scheduleToRow(s: Schedule): typeof schedules.$inferInsert {
    return {
      id: s.id,
      partnerId: s.partnerId,
      phone: s.phone,
      amountUsd: s.amountUsd.toFixed(2),
      amountSource: s.amountSource.toFixed(2),
      sourceCurrency: s.sourceCurrency,
      recipientName: s.recipientName,
      recipientPhone: s.recipientPhone,
      payoutMethod: s.payoutMethod,
      payoutDestinationEnc: s.payoutDestination ? encryptField(s.payoutDestination, provider) : '',
      payoutDestinationLast4: last4(s.payoutDestination ?? ''),
      fundingMethod: s.fundingMethod,
      frequency: s.frequency,
      dayOfMonth: s.dayOfMonth ?? null,
      dayOfWeek: s.dayOfWeek ?? null,
      status: s.status,
      endDate: s.endDate ?? null,
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
      createdAt: new Date(s.createdAt),
    };
  }

  return {
    async getSchedule(id: string): Promise<Schedule | null> {
      const rows = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
      return rows[0] ? rowToSchedule(rows[0]) : null;
    },

    async saveSchedule(schedule: Schedule): Promise<void> {
      const row = scheduleToRow(schedule);
      await db.insert(schedules).values(row).onConflictDoUpdate({ target: schedules.id, set: row });
    },

    async listSchedules(): Promise<Schedule[]> {
      const rows = await db.select().from(schedules).orderBy(asc(schedules.createdAt));
      return rows.map(rowToSchedule);
    },

    async listActiveSchedules(): Promise<Schedule[]> {
      const rows = await db
        .select()
        .from(schedules)
        .where(eq(schedules.status, 'active'))
        .orderBy(asc(schedules.createdAt));
      return rows.map(rowToSchedule);
    },
  };
}

export type ScheduleRepo = ReturnType<typeof createScheduleRepo>;
