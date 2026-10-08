import { and, desc, eq, inArray } from 'drizzle-orm';
import { schedules } from '@/db/schema';
import type { DbOrTx } from '@/db/client';
import { defaultProvider, type EncryptionKeyProvider } from '@/lib/field-crypto';
import { last4, openOptional } from './mappers';
import { encryptField } from '@/lib/field-crypto';
import { ctx } from '@/lib/crypto-context';
import { parsePurpose } from '@/lib/purpose-codes';
import type {
  CurrencyCode,
  FundingMethod,
  PartnerId,
  PayoutMethod,
  Schedule,
  ScheduleFrequency,
  ScheduleStatus,
} from '@/lib/types';

// schedule-repo — mirrors schedule-store (getSchedule / saveSchedule /
// listSchedules / listActiveSchedules / setStatusIf / markRun). Payout destinations encrypted at rest
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
      payoutDestination: openOptional(row.payoutDestinationEnc, provider, ctx.schedule(row.id)) ?? '',
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
    // Required purpose: an unknown stored value reads as absent ("Not stated"), never cast.
    const purpose = parsePurpose(row.purpose);
    if (purpose) s.purpose = purpose;
    // Batch B follow-up A2: decrypted like the payout destination (the cron run and the owner's form need it).
    const detail = openOptional(row.purposeDetailEnc, provider, ctx.schedule(row.id, 'purpose_detail_enc'));
    if (detail) s.purposeDetail = detail;
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
      payoutDestinationEnc: s.payoutDestination
        ? encryptField(s.payoutDestination, provider, ctx.schedule(s.id))
        : '',
      payoutDestinationLast4: last4(s.payoutDestination ?? ''),
      fundingMethod: s.fundingMethod,
      frequency: s.frequency,
      dayOfMonth: s.dayOfMonth ?? null,
      dayOfWeek: s.dayOfWeek ?? null,
      status: s.status,
      endDate: s.endDate ?? null,
      purpose: s.purpose ?? null,
      purposeDetailEnc: s.purposeDetail ? encryptField(s.purposeDetail, provider, ctx.schedule(s.id, 'purpose_detail_enc')) : null,
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt) : null,
      createdAt: new Date(s.createdAt),
    };
  }

  return {
    async getSchedule(id: string): Promise<Schedule | null> {
      const rows = await db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
      return rows[0] ? rowToSchedule(rows[0]) : null;
    },

    /**
     * UI redesign M2-10 (plan X14 / review round 1 L1): one schedule of ONE customer. The tenant AND
     * the phone are in the WHERE, so another partner's or another customer's id reads as null
     * (the portal's single "not found"). The unscoped getSchedule above stays for staff and cron.
     */
    async getOwnedSchedule(partnerId: PartnerId, phone: string, id: string): Promise<Schedule | null> {
      const rows = await db
        .select()
        .from(schedules)
        .where(and(eq(schedules.id, id), eq(schedules.partnerId, partnerId), eq(schedules.phone, phone)))
        .limit(1);
      return rows[0] ? rowToSchedule(rows[0]) : null;
    },

    async saveSchedule(schedule: Schedule): Promise<void> {
      const row = scheduleToRow(schedule);
      await db.insert(schedules).values(row).onConflictDoUpdate({ target: schedules.id, set: row });
    },

    /**
     * Program-Fix 36: the ONE writer of a status transition — a single-column,
     * CONDITIONAL update: `SET status = to WHERE id AND partner_id AND status IN
     * (from)`. The tenant is in the WHERE, so an out-of-scope id writes nothing;
     * a lost race (the row already left `from`) returns null and writes nothing.
     * `inArray`: drizzle-orm/sql/expressions/conditions.d.ts:170.
     */
    async setStatusIf(
      id: string,
      partnerId: PartnerId,
      from: ScheduleStatus[],
      to: ScheduleStatus,
    ): Promise<Schedule | null> {
      if (from.length === 0) return null;
      const rows = await db
        .update(schedules)
        .set({ status: to })
        .where(and(eq(schedules.id, id), eq(schedules.partnerId, partnerId), inArray(schedules.status, from)))
        .returning();
      return rows[0] ? rowToSchedule(rows[0]) : null;
    },

    /**
     * UI redesign M2-10 (#398 review L2): the scheduled mint's in-transaction re-check. Reads the
     * schedule of THIS (tenant, owner) with `FOR SHARE` (drizzle-orm/pg-core/query-builders/
     * select.d.ts:586, LockStrength select.types.d.ts:60), so a concurrent status write (a delete's
     * or a customer's cancel via setStatusIf) either committed first and is seen here, or waits for
     * the mint transaction to commit. Only meaningful on a transaction handle. null = no such row.
     */
    async lockForMint(
      id: string,
      partnerId: PartnerId,
      phone: string,
    ): Promise<{ status: ScheduleStatus; hasDestination: boolean } | null> {
      const rows = await db
        .select({ status: schedules.status, enc: schedules.payoutDestinationEnc })
        .from(schedules)
        .where(and(eq(schedules.id, id), eq(schedules.partnerId, partnerId), eq(schedules.phone, phone)))
        .limit(1)
        .for('share');
      const r = rows[0];
      return r ? { status: r.status as ScheduleStatus, hasDestination: r.enc !== '' } : null;
    },

    /**
     * Program-Fix 36: the cron's "fired" mark touches ONLY last_run_at, so a
     * staff pause landing mid-run is never written back to `active` by a stale
     * whole-row save (and the encrypted destination is not re-encrypted).
     */
    async markRun(id: string, at: Date): Promise<void> {
      await db.update(schedules).set({ lastRunAt: at }).where(eq(schedules.id, id));
    },

    async listSchedules(): Promise<Schedule[]> {
      const rows = await db.select().from(schedules).orderBy(desc(schedules.createdAt));
      return rows.map(rowToSchedule);
    },

    /**
     * UI redesign M2-8 (M2-10 reuses it): one customer's schedules, newest first. The tenant AND
     * the phone are both in the WHERE, so another partner's schedules for the same phone never appear.
     */
    async listForCustomer(partnerId: PartnerId, phone: string): Promise<Schedule[]> {
      const rows = await db
        .select()
        .from(schedules)
        .where(and(eq(schedules.partnerId, partnerId), eq(schedules.phone, phone)))
        .orderBy(desc(schedules.createdAt));
      return rows.map(rowToSchedule);
    },

    async listActiveSchedules(): Promise<Schedule[]> {
      const rows = await db
        .select()
        .from(schedules)
        .where(eq(schedules.status, 'active'))
        .orderBy(desc(schedules.createdAt));
      return rows.map(rowToSchedule);
    },
  };
}

export type ScheduleRepo = ReturnType<typeof createScheduleRepo>;
