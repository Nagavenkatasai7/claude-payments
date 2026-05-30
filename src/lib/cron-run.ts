import { isScheduleDueToday } from './schedule';
import { createTransfer } from './transfer-create';
import { env } from './env';
import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { ScheduleStore } from './schedule-store';
import type { Schedule, Transfer } from './types';

export interface CronDeps {
  store: Store;
  partnerStore: PartnerStore;           // NEW (P5): for corridor-aware compliance
  monthlyVolumeStore: MonthlyVolumeStore;   // NEW (KYC) — cumulative-month accrual + EDD trigger
  scheduleStore: ScheduleStore;
  now: number;
  sendScheduledLink: (
    schedule: Schedule,
    transfer: Transfer,
    url: string,
  ) => Promise<void>;
}

export async function runDueSchedules(
  deps: CronDeps,
): Promise<{ fired: number }> {
  const schedules = await deps.scheduleStore.listActiveSchedules();
  let fired = 0;
  for (const schedule of schedules) {
    // QA #7: if the schedule has an endDate and the current run time is AFTER it,
    // mark it cancelled and skip firing — it will no longer appear in active schedules.
    if (schedule.endDate) {
      const endTs = Date.parse(schedule.endDate);
      if (!isNaN(endTs) && deps.now > endTs) {
        schedule.status = 'cancelled';
        await deps.scheduleStore.saveSchedule(schedule);
        continue;
      }
    }
    if (!isScheduleDueToday(schedule, deps.now)) continue;
    try {
      const transfer = await createTransfer(deps.store, deps.partnerStore, deps.monthlyVolumeStore, {
        phone: schedule.phone,
        amountSource: schedule.amountSource,
        sourceCurrency: schedule.sourceCurrency,
        partnerId: schedule.partnerId,
        recipientName: schedule.recipientName,
        recipientPhone: schedule.recipientPhone,
        payoutMethod: schedule.payoutMethod,
        payoutDestination: schedule.payoutDestination,
        fundingMethod: schedule.fundingMethod,
      });
      if (transfer.status !== 'blocked') {
        const url = `${env.appBaseUrl}/pay/${transfer.id}`;
        await deps.sendScheduledLink(schedule, transfer, url);
      }
      schedule.lastRunAt = new Date(deps.now).toISOString();
      await deps.scheduleStore.saveSchedule(schedule);
      fired++;
    } catch (err) {
      console.error('Schedule run failed:', schedule.id, err);
    }
  }
  return { fired };
}
