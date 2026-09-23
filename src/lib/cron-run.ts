import { isScheduleDueToday } from './schedule';
import { createTransfer } from './transfer-create';
import { SendBusyError, SendCapError } from './send-limits';
import { isSendVerified, sendGateActive } from './kyc-gate';
import { env } from './env';
import { logError } from './log';
import { RateUnavailableError } from './rate';
import { newTransferId } from './id';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { createIdempotencyRepo } from '@/db/repos/aux-repos';
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
        // Program-Fix 36: a CONDITIONAL single-column cancel (from 'active'
        // only) — never a whole-row upsert from this run's stale read, which
        // would write a staff pause landing mid-run back over.
        await deps.scheduleStore.setStatusIf(schedule.id, schedule.partnerId, ['active'], 'cancelled');
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
    // Program-Fix 36: FAIL CLOSED on the partner. A missing row or a partner
    // that is not 'active' (every other surface refuses a suspended partner)
    // mints nothing and does NOT bump lastRunAt — the schedule stays active,
    // so reactivating the partner resumes it with no data change. Ops is paged
    // ONCE per partner per Eastern day (not per schedule); not counted as
    // failed, because the refusal is the intended state of the tenant.
    const partner = await deps.partnerStore.getPartner(schedule.partnerId);
    if (!partner || partner.status !== 'active') {
      await alertSuspendedPartner(deps, schedule.partnerId, partner ? partner.status : 'missing');
      continue;
    }
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
    // Program-Fix 36: re-read the status just before the mint. A staff pause
    // (or a customer cancel) landing after listActiveSchedules must win: the
    // list copy in hand is stale, and a mint on a paused schedule would be a
    // pay link the customer was told would not come.
    const current = await deps.scheduleStore.getSchedule(schedule.id);
    if (!current || current.status !== 'active') continue;
    try {
      // Program-Fix 32 (neon-08): CLAIM-FIRST, the pay-finalize.ts pattern.
      // Bind sched:<scheduleId>:<YYYY-MM-DD Eastern day — the day
      // isScheduleDueToday matches> (under the schedule's partner;
      // PK (partner_id, key)) to a pre-generated id BEFORE the mint, so a
      // same-day replay — a failed link send, or a crash between the mint and
      // markRun — re-mints the SAME row or finds it: at most one transfer per
      // schedule per Eastern day. A refused mint leaves the key bound but
      // unminted; the re-run mints THAT id. The claim sits outside the sender
      // lock (as in pay-finalize), and inside this try so a failing claim is
      // counted and alerted like any other refusal.
      const candidateId = newTransferId();
      const reservedId = await createIdempotencyRepo(deps.db).claim(
        schedule.partnerId,
        `sched:${schedule.id}:${easternDay(deps.now)}`,
        candidateId,
      );
      if (reservedId !== candidateId) {
        const existing = await deps.store.getTransfer(reservedId);
        if (existing) {
          // Already minted today: re-send the SAME link only while it is
          // still payable (never for a blocked, cancelled, paid or already-
          // charged row), record the run, and count it — no second mint.
          if (existing.status === 'awaiting_payment' && !existing.fundingRef) {
            await deps.sendScheduledLink(schedule, existing, `${env.appBaseUrl}/pay/${existing.id}`);
          }
          await deps.scheduleStore.markRun(schedule.id, new Date(deps.now));
          fired++;
          continue;
        }
      }
      const mint = () => createTransfer(deps.store, deps.partnerStore, deps.monthlyVolumeStore, {
        id: reservedId,
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
      // Program fix 16: a busy per-sender lock wrote nothing, and /api/cron runs
      // ONCE a day (no same-day re-run) — so retry the mint once in-process
      // before counting the schedule as failed.
      let transfer: Awaited<ReturnType<typeof mint>>;
      try {
        transfer = await mint();
      } catch (first) {
        if (!(first instanceof SendBusyError)) throw first;
        transfer = await mint();
      }
      if (transfer.status === 'awaiting_payment') {
        const url = `${env.appBaseUrl}/pay/${transfer.id}`;
        await deps.sendScheduledLink(schedule, transfer, url);
      }
      // Program-Fix 36: touch ONLY last_run_at (never a whole-row save, which
      // would resurrect a pause that landed during the mint).
      await deps.scheduleStore.markRun(schedule.id, new Date(deps.now));
      fired++;
    } catch (err) {
      // A refused mint (Task 9: FX unavailable; or any other refusal) is LOUD:
      // a scrubbed error line, counted in the result (the /api/cron JSON), and
      // ONE deduped ops alert per schedule per Eastern day. lastRunAt is NOT
      // advanced, so a MANUAL same-day re-run of /api/cron would fire it — the
      // scheduled cron itself runs once a day with no next-day catch-up
      // (isScheduleDueToday matches the day), so without the alert this
      // cycle's send would silently disappear.
      failed++;
      const reason =
        err instanceof RateUnavailableError ? err.reason
        : err instanceof SendCapError ? 'send_cap'   // Program fix 16: the schedule owner is at their cap today
        : err instanceof SendBusyError ? 'busy'      // the per-sender mint lock timed out twice (once retried above)
        : 'error';
      logError('cron.schedule-run', err, { scheduleId: schedule.id, reason });
      const day = easternDay(deps.now);
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

/** YYYY-MM-DD for the same Eastern day isScheduleDueToday matches. */
function easternDay(now: number): string {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Program-Fix 36: one deduped ops alert per partner per Eastern day when its
 * due schedules are being held back. The message names the partner and the
 * reason only — never a schedule owner's phone or destination.
 */
async function alertSuspendedPartner(
  deps: Pick<CronDeps, 'db' | 'now'>,
  partnerId: string,
  reason: string,
): Promise<void> {
  const day = easternDay(deps.now);
  try {
    await createOutboxRepo(deps.db).enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: partner ${partnerId} is ${reason} — its due recurring schedules were NOT run on ${day}. ` +
          `No pay links were sent. They resume automatically once the partner is active again (nothing to re-run).`,
      },
      { dedupeKey: `schedule-suspended:${partnerId}:${day}` },
    );
  } catch (alertErr) {
    logError('cron.schedule-suspended-alert', alertErr, { partnerId });
  }
}
