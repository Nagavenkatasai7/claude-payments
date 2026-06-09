import { isScheduleDueToday } from './schedule';
import { createTransfer } from './transfer-create';
import { isSendVerified, sendGateActive } from './kyc-gate';
import { env } from './env';
import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type { CustomerStore } from './customer-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { ScheduleStore } from './schedule-store';
import type { KycProvider } from './providers/kyc-provider';
import type { Customer, Schedule, Transfer } from './types';

export interface CronDeps {
  store: Store;
  partnerStore: PartnerStore;           // NEW (P5): for corridor-aware compliance
  customerStore: CustomerStore;         // NEW (Item 4): skip opted-out customers
  monthlyVolumeStore: MonthlyVolumeStore;   // NEW (KYC) — cumulative-month accrual + EDD trigger
  scheduleStore: ScheduleStore;
  kycProvider: KycProvider;             // NEW (Phase 3) — verify-before-send hand-off url
  now: number;
  sendScheduledLink: (
    schedule: Schedule,
    transfer: Transfer,
    url: string,
  ) => Promise<void>;
  // NEW (Phase 3) — notify the owner their scheduled send was skipped pending KYC.
  sendScheduledSkipped?: (
    schedule: Schedule,
    owner: Customer | null,
    kycUrl: string,
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
    // Item 4: a business-initiated send to an opted-out customer is not allowed.
    // Skip silently — do NOT count as fired, do NOT touch lastRunAt (the schedule
    // stays active so it resumes if the customer re-subscribes with START).
    const owner = await deps.customerStore.getCustomer(schedule.phone);
    if (owner?.optedOutAt) continue;
    // WL1: resolve the schedule's partner — drives the gate toggle + requiresKyc.
    const partner =
      (await deps.partnerStore.getPartner(schedule.partnerId)) ??
      (await deps.partnerStore.ensureDefaultPartner());
    // Phase 3 verify-before-send gate — skip an unverified owner's scheduled send
    // and notify them. Do NOT createTransfer and do NOT bump lastRunAt, so the
    // schedule stays active and resumes automatically once they verify.
    // WL1: skipped for a 'delegated' partner (they run KYC); sanctions still run.
    if (sendGateActive(partner) && !isSendVerified(owner)) {
      if (deps.sendScheduledSkipped) {
        const start = await deps.kycProvider.startVerification({
          customerId: schedule.phone,
          senderPhone: schedule.phone,
        });
        await deps.sendScheduledSkipped(schedule, owner ?? null, start.url);
      }
      continue;
    }
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
        senderKycStatus: owner?.kycStatus ?? 'not_started',
        requiresKyc: sendGateActive(partner), // WL1: delegated ⇒ false; sanctions still run
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
