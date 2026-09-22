import { isScheduleDueToday } from './schedule';
import { createTransfer } from './transfer-create';
import { SendBusyError, SendCapError } from './send-limits';
import { isSendVerified, sendGateActive } from './kyc-gate';
import { env } from './env';
import { logError } from './log';
import { RateUnavailableError } from './rate';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import type { DbOrTx } from '@/db/client';
import type { Store } from './store';
import type { PartnerStore } from './partner-store';
import type { CustomerStore } from './customer-store';
import type { MonthlyVolumeStore } from './monthly-volume-store';
import type { ScheduleStore } from './schedule-store';
import type { KycProvider } from './providers/kyc-provider';
import type { Customer, Schedule, Transfer } from './types';

export interface CronDeps {
  // Task 9: the ledger handle a refused run's deduped ops alert is enqueued on.
  db: DbOrTx;
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
): Promise<{ fired: number; failed: number }> {
  const schedules = await deps.scheduleStore.listActiveSchedules();
  let fired = 0;
  let failed = 0;
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
    const owner = await deps.customerStore.getCustomer(schedule.partnerId, schedule.phone);
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
        // Record the inquiry on the schedule's (tenant, phone) row so the Persona
        // completion binds to it even when the phone has sibling tenant rows (fix 1).
        if (start.providerRef) {
          await deps.customerStore.recordKycInquiry(schedule.partnerId, schedule.phone, start.providerRef);
        }
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
      // A refused mint (Task 9: FX unavailable; or any other refusal) is LOUD:
      // a scrubbed error line, counted in the result (the /api/cron JSON), and
      // ONE deduped ops alert per schedule per Eastern day. lastRunAt is NOT
      // advanced, so a same-day re-run of /api/cron fires it — but the daily
      // cron has no next-day catch-up (isScheduleDueToday matches the day), so
      // without the alert this cycle's send would silently disappear.
      failed++;
      const reason =
        err instanceof RateUnavailableError ? err.reason
        : err instanceof SendCapError ? 'send_cap'   // Program fix 16: the schedule owner is at their cap today
        : err instanceof SendBusyError ? 'busy'      // the per-sender mint lock timed out (a same-day re-run retries)
        : 'error';
      logError('cron.schedule-run', err, { scheduleId: schedule.id, reason });
      // YYYY-MM-DD for the same Eastern day isScheduleDueToday matches.
      const day = new Date(deps.now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      try {
        await createOutboxRepo(deps.db).enqueue(
          'ops.alert',
          {
            message:
              `⚠️ SmartRemit ops: scheduled send ${schedule.id} was NOT created on ${day} (${reason}) — ` +
              `the customer got no pay link. Re-run /api/cron today once the cause clears; ` +
              `the daily cron does not retry it tomorrow.`,
          },
          { dedupeKey: `schedule-refused:${schedule.id}:${day}` },
        );
      } catch (alertErr) {
        logError('cron.schedule-alert', alertErr, { scheduleId: schedule.id });
      }
    }
  }
  return { fired, failed };
}
