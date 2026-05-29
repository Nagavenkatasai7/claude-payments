import { isScheduleDueToday } from './schedule';
import { createTransfer } from './transfer-create';
import { env } from './env';
import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type { ScheduleStore } from './schedule-store';
import type { Schedule, Transfer } from './types';

export interface CronDeps {
  store: Store;
  partnerStore: PartnerStore;           // NEW (P5): for corridor-aware compliance
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
    if (!isScheduleDueToday(schedule, deps.now)) continue;
    try {
      const transfer = await createTransfer(deps.store, deps.partnerStore, {
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
