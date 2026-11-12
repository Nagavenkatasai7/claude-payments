import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createOutboxRepo, type OutboxRow } from '@/db/repos/outbox-repo';
import { createIntegrationsRepo } from '@/db/repos/integrations-repo';
import { isSandbox, settleOrHold } from '@/lib/settlement';
import { settleFundedTransfer } from '@/lib/stripe-funded-settle';
import { createTicketRepo } from '@/db/repos/ticket-repo';
import { FIRST_RESPONSE_DUE_HOURS, slaDigestKey } from '@/lib/ticket-sla';
import { logWarn } from '@/lib/log';
import { readFlag } from '@/lib/flags';
import { LIST_UNAVAILABLE_REASON, ORIGINATOR_INFO_MISSING_REASON, RECIPIENT_IDENTITY_MISSING_REASON } from '@/lib/compliance-config';
import { liveRefusalFor, realMoneyFor, realMoneyRail } from '@/lib/live-gate';
import { alertStuckLivegate } from '@/lib/livegate-alerts';
import { alertStuckHeld, instructHeldOnPurpose } from '@/lib/instruct-gates';
import { rescreenOnFile } from '@/lib/pay-rescreen';
import { healPaidRowScreen, paidRowNeedsHeal, sweepListUnavailableHolds } from '@/lib/list-hold-rescreen';
import { listScreenEvidence, liveFresh } from '@/lib/sanctions/evidence-read';
import { SANCTIONS_FUNDS_RULE, SANCTIONS_NO_PAYOUT_SENTENCE } from '@/lib/sanctions/notices';
import type { Transfer } from '@/lib/types';

// reconcile — the safety-net sweep (Stage 2d). Runs in every FULL /api/worker
// invocation (a poke; a cron tick with work marked due or on the :17/:47
// backstop; a heartbeat while the cron is quiet — partner-demo R4 gates the
// rest before they touch Neon), BEFORE the outbox drain so its effects drain
// in the same call. Worst case between sweeps on an idle system: 30 min. It catches the
// states the happy path can't lose silently anymore but an external party can
// still strand:
//   • a webhook-driven transfer stuck in 'paid' too long (the partner's rail
//     never called back, or the instruction died) → re-instruct ONCE + alert,
//     (on a real-money rail, first re-screened on a live list when the
//     instruct gate refuses its newest screen: pack 2 review F1),
//   • a compliance hold ('in_review') nobody has touched in 24h → alert,
//   • a CHARGED transfer still awaiting_payment (fundingRef set; the process
//     died between capture and settleOrHold) → resume settlement (cleared) or
//     HOLD for review (flagged) + alert,
//   • cancelled + charged + unrefunded → alert (`cancelcharged:`),
//   • a refund in flight for over an hour → alert (ops decides; no auto-retry),
//   • a 'processing' lease expired >15m and still unreclaimed (the drain is down) → alert,
//   • customer tickets past their first-response target (fix 49C) → ONE digest a day,
//   • an in_review hold waiting on a fresh sanctions list (LIST_UNAVAILABLE) →
//     re-screened and released automatically when clean (fix pack 2 T4).
// Every enqueue is dedupe-keyed per transfer, so the sweep firing on every
// full run can never spam: one re-instruction and one alert per stuck transfer, ever.

export const STUCK_PAID_MINUTES = 15;
export const STALE_REVIEW_HOURS = 24;
export const FUNDING_RESUME_MINUTES = 10;
export const STUCK_REFUND_MINUTES = 60;
/** Program-Fix 7 (review M1): a bound Stripe debit still pending/failed after this many days is alerted once. */
export const STALE_FUNDING_INTENT_DAYS = 7;
/**
 * A 'processing' row whose lease expired this long ago and is STILL unreclaimed.
 * claimBatch reclaims expired leases on every drain, so a survivor means the
 * drain is not running (cron / heartbeat / poke down) — alert per row, deduped.
 */
export const STALE_LOCK_MINUTES = 15;

/**
 * Fix pack 2 T3 (R02): the ops copy for a hold that is waiting on the
 * sanctions list (LIST_UNAVAILABLE): no person can release it; an automatic
 * re-screen on a fresh list does.
 */
const LIST_WAIT_COPY =
  'it is waiting for a fresh sanctions list (LIST_UNAVAILABLE) and is released automatically after a re-screen against a fresh list. ' +
  'Check the sanctions list loader if the list is not refreshing.';

const waitsForList = (t: Pick<Transfer, 'complianceReasons'> | null | undefined): boolean =>
  Array.isArray(t?.complianceReasons) && t.complianceReasons.includes(LIST_UNAVAILABLE_REASON);

export interface SweepResult {
  stuckPaid: number;
  reinstructed: number;
  staleReviews: number;
  // Optional ONLY so pre-existing zero-literals (the worker route's fallback)
  // stay assignable; reconcileSweep itself always returns all of them.
  fundingResumed?: number;
  stuckRefunds?: number;
  staleLocks?: number;
  /** Fix pack 2 T4: LIST_UNAVAILABLE holds released by the automatic re-screen (0 when none). */
  listHoldsReleased?: number;
}

/**
 * Program-Fix 15 PR C: the ONE recovery re-instruction, serialized with a
 * sender cancel (sender-cancel.ts). A short transaction takes the transfer
 * `FOR UPDATE` (transfer → outbox, the lock order every writer uses) and
 * re-checks paid + refund none on the LOCKED row before enqueueing
 * `reinstruct:<id>`: findStuckPaid's read may predate a cancel or a refund
 * request that has since committed. True when a new row was created.
 */
export async function enqueueReinstructLocked(db: Db, transferId: string): Promise<boolean> {
  return (await reinstructLocked(db, transferId)) === 'enqueued';
}

/**
 * enqueueReinstructLocked with the reason. M3-15b review MEDIUM-1: under the SAME transfer lock the
 * partner Replay takes (partner-webhook-replay.ts), a transfer that already has a LIVE
 * settlement.instruct row (pending / processing / failed: queued, running or backing off) gets NO
 * recovery re-instruction now: the worker route sweeps before it drains, so both rows would POST back
 * to back. The one `reinstruct:` stays available for a later sweep once that row is done or dead.
 */
export async function reinstructLocked(db: Db, transferId: string): Promise<'enqueued' | 'not_payable' | 'in_flight' | 'exists'> {
  return db.transaction(async (tx) => {
    const cur = await createTransferRepo(tx).getTransferForUpdate(transferId);
    // Pack 2 review R1 (E2): a sanctions-blocked paid row is never re-instructed.
    if (!cur || cur.status !== 'paid' || (cur.refundStatus ?? 'none') !== 'none' || cur.complianceStatus === 'blocked') return 'not_payable';
    const outbox = createOutboxRepo(tx);
    if (await outbox.hasLiveInstruction(transferId)) return 'in_flight';
    return (await outbox.enqueue('settlement.instruct', { transferId }, { dedupeKey: `reinstruct:${transferId}` })) ? 'enqueued' : 'exists';
  });
}

/**
 * Pack 2 review F3 (C2): the wall-clock budget shared by this sweep's
 * re-screens (the stuck-paid heal and the crash-resume re-screen). The sweep
 * runs before the worker drain on every full run, so once the budget is spent
 * no further re-screen STARTS; that row is left as it is for the next sweep.
 * Review R2 (E4): only the time spent INSIDE healPaidRowScreen and
 * rescreenOnFile is charged, so the stuck-paid bookkeeping (any size of
 * backlog) never uses it up. A sweep that defers a re-screen logs the counts.
 * Review round 3 (K3): a blocked paid row is not healed at all, and the
 * heal's "needs a heal?" reads (paidRowNeedsHeal) are not charged either.
 * The list-hold sweep has its own budget (LIST_RESCREEN_BUDGET_MS).
 */
export const RESCREEN_BUDGET_MS = 5_000;

export interface ReconcileSweepOptions {
  /** Re-screen budget (default RESCREEN_BUDGET_MS). */
  rescreenBudgetMs?: number;
  /** Injectable wall clock (default Date.now), also handed to the list-hold sweep. */
  clock?: () => number;
}

export async function reconcileSweep(db: Db, now: Date = new Date(), opts: ReconcileSweepOptions = {}): Promise<SweepResult> {
  const clock = opts.clock ?? Date.now;
  const rescreenBudgetMs = opts.rescreenBudgetMs ?? RESCREEN_BUDGET_MS;
  // Review R2 (E4): time charged to the budget (re-screens only, see above).
  let rescreenSpentMs = 0;
  const rescreenTimeLeft = (): boolean => rescreenSpentMs < rescreenBudgetMs;
  const timedRescreen = async <T>(run: () => Promise<T>): Promise<T> => {
    const started = clock();
    try {
      return await run();
    } finally {
      rescreenSpentMs += Math.max(0, clock() - started);
    }
  };
  let healDeferred = 0;
  let resumeDeferred = 0;
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  const integrationsRepo = createIntegrationsRepo(db);

  const stuck = await transfers.findStuckPaid(STUCK_PAID_MINUTES);
  let reinstructed = 0;
  // fix 8: a transfer whose rail reported `failed` / `returned` is NOT here —
  // handleRailFailure leaves `paid` (→ cancelled) and, when refundable, flips
  // refund_status to pending in the SAME transaction, and findStuckPaid is
  // `status = 'paid' AND refund_status = 'none'`. A `reinstruct:` row queued
  // BEFORE the failure landed is skipped by the instruct handler's own guard
  // (outbox-worker: cancelled / refund pending ⇒ done without a POST).
  for (const t of stuck) {
    // Release safety part A: while settlement.paused matches this transfer, its
    // instruction is held ON PURPOSE (outbox-worker defers it), so it is neither
    // re-instructed nor alerted as stuck. The `recon:` alert stays available
    // for a later sweep once the pause is off and the transfer is still stuck.
    // Fix pack 3 T7: partner-set (`tenant:`) rows of the owner or the rail
    // tenant match too, and an unreadable switch on a real-money rail skips
    // the row as the instruct defers it (owner answer Q5).
    const pause = await readFlag(db, 'settlement.paused', {
      partnerId: [t.partnerId, t.settlementPartnerId],
      tenants: [t.partnerId, t.settlementPartnerId],
      corridor: t.destinationCountry,
    });
    if (pause === 'on') continue;
    if (pause === 'unknown' && (await realMoneyFor(db, t))) continue;
    // Fix pack 3 T6 (R15, contract 7): a real-money row whose rail partner is
    // not certified for live money (or whose owner is the default tenant) is
    // owned by the worker: it defers the instruct uncharged and raised
    // `livegate:<id>`. A re-instruct would only defer again, a heal re-screen
    // would be wasted, and a `recon:` alert would be noise. liveRefusalFor makes
    // no read for a 'test' row and never throws (a failed read is real money).
    // Pack 3 review I1: the worker owns it only while an instruct row is live;
    // with none (the instruct already finished) one `livegate:stuck:<id>` alert
    // is raised instead, and the row is still not re-instructed.
    const refusal = await liveRefusalFor(db, t);
    if (refusal !== null) {
      await alertStuckLivegate(db, t, refusal);
      continue;
    }
    // Fix pack 5 (P9): a row a later instruct gate holds on purpose. While its
    // instruct row is live the worker's own alert (mockfund:/fundmode:/
    // travelrule:) owns it; with none (a mockfund row's instruct is done) one
    // <reason>:stuck:<id> alert is the escalation (pack 3 I1 rule). No
    // reinstruct, no recon alert, no rung, no audit row.
    const heldOnPurpose = await instructHeldOnPurpose(db, t);
    if (heldOnPurpose !== null) {
      await alertStuckHeld(db, t, heldOnPurpose);
      continue;
    }
    // Best-rate routing: the rail that owes the callback is the SETTLEMENT
    // partner's when routed — classify (webhook-driven vs mock) by THEIR
    // config, or a routed stuck transfer reads the owner's (often mock)
    // config and is never re-instructed. The instruct handler re-resolves
    // the same routed id, so the re-instruction also goes to the right rail.
    const integrations = await integrationsRepo.getIntegrations(
      t.settlementPartnerId ?? t.partnerId,
    );
    const providerType = integrations.payment.providerType;
    // Program-Fix 44 P2: a sandbox transfer settles on the mock rail only, so
    // it is never re-instructed, whatever the rail config says.
    const webhookDriven = !isSandbox(t) && (providerType === 'http' || providerType === 'simulator');
    // fix 29 (money-09): the rail reported a DIFFERENT amount for this row — it
    // is held for staff (cancel/refund), never re-instructed. It keeps showing
    // here every sweep; the recon: alert below is still deduped (fires once).
    const held = await outbox.hasDedupeKey(`railamount:${t.id}`);
    let reinstructedNow = false;
    let inFlight = false;
    if (webhookDriven && !held) {
      // Pack 2 review F1 (A1): a real-money row whose instruct the worker's
      // live-list gate refuses (its newest screen is too old or not live) is
      // re-screened on a live list first, so the retrying instruct (or the
      // re-instruction below) can pass. Isolated: an error costs nothing else.
      // F3 (C2): not started once the re-screen budget is spent (the next sweep heals it).
      // Review round 3 (K3): a sanctions-blocked paid row (the heal's own match)
      // is never healed: skipped here with no read. The heal's cheap "needs a
      // heal?" checks run OUTSIDE the budget (paidRowNeedsHeal), so only a row
      // that really re-screens spends it; the re-instruct and the recon alert
      // below run for every row as before.
      if (t.complianceStatus !== 'blocked' && realMoneyRail({ environment: t.environment, railProviderType: providerType ?? null })) {
        try {
          if (await paidRowNeedsHeal(db, t, now)) {
            if (!rescreenTimeLeft()) {
              healDeferred++;
            } else {
              await timedRescreen(() => healPaidRowScreen(db, t, now, { prechecked: true }));
            }
          }
        } catch (err) {
          logWarn('reconcile.paid-rescreen', err, { transferId: t.id });
        }
      }
      // Exactly ONE recovery re-instruction per transfer (`reinstruct:` is a
      // different key from the original `instruct:` row, which is done/dead by
      // now). The instruct handler itself is idempotent on the partner side —
      // the reference is the transfer id, so their rail dedupes a replay.
      const outcome = await reinstructLocked(db, t.id);
      reinstructedNow = outcome === 'enqueued';
      inFlight = outcome === 'in_flight';
      if (reinstructedNow) reinstructed++;
    }
    // Mock-rail transfers land here too if their delayed settle died — the
    // dead-letter alert already fired for that row; this is the money-state view.
    // Routed transfers name the SETTLEMENT partner too — that's whose rail owes
    // the callback; pointing ops at only the owner would chase the wrong tenant.
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}` +
          (t.settlementPartnerId ? `, settles via ${t.settlementPartnerId}` : '') +
          `) has been ` +
          `'paid' for >${STUCK_PAID_MINUTES}min with no delivery confirmation.` +
          // Review S5 (inventory): a held row that is also sanctions-blocked
          // is never told to be cancelled or refunded: the compliance officer
          // decides about its funds first.
          (held
            ? t.complianceStatus === 'blocked'
              ? ` The rail reported a different amount — held, not re-instructed. It is blocked by sanctions screening: investigate with the rail, and ${SANCTIONS_FUNDS_RULE}.`
              : ' The rail reported a different amount — held, not re-instructed. Investigate with the rail, then cancel/refund it.'
            : webhookDriven
              ? reinstructedNow
                ? ' Re-instructed the partner rail once.'
                : inFlight
                  ? ' Not re-instructed: an instruction for it is still queued or retrying. A later sweep re-instructs once if that instruction fails for good.'
                  : ' Not re-instructed: on the locked re-check the transfer was no longer payable (cancelled, sanctions-blocked, or a refund requested/in flight).'
              : ''),
      },
      { dedupeKey: `recon:${t.id}` },
    );
  }

  const stale = await transfers.findInReviewOlderThan(STALE_REVIEW_HOURS);
  for (const t of stale) {
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) has been ` +
          `in compliance review for >${STALE_REVIEW_HOURS}h — ` +
          // Review S5 (W2b): a row blocked by sanctions screening (the list-hold
          // sweep or the release re-screen matched it; it stays in review) can
          // never be released, and its funds wait for the compliance officer.
          (t.complianceStatus === 'blocked'
            ? `it is blocked by sanctions screening, so it can never be released. ${SANCTIONS_NO_PAYOUT_SENTENCE}; evidence on the compliance page.`
            : waitsForList(t)
              ? LIST_WAIT_COPY
              : 'release or refund it.'),
      },
      { dedupeKey: `review:${t.id}` },
    );
  }

  // CRASH-RESUME: the customer was CHARGED (fundingRef is write-once, set
  // before settlement) but the process died before settlement/hold committed —
  // the one state the funds-capture seam can strand. Resume it through
  // settleOrHold, the same atomic claims the pay route uses, so the sweep
  // firing every minute moves each victim EXACTLY once and a victim racing its
  // own resurrected pay request is still a clean no-op. COMPLIANCE: a charged
  // FLAGGED victim is HELD (in_review + held stage-1 message, one transaction)
  // and never instructed; a charged BLOCKED victim (a resume re-screen match,
  // or a row already blocked) is left untouched with its own alert, which
  // never says to refund (review S5). Both count as "resumed": the charged row reached its correct next
  // state. NEVER add a compliance predicate to listAwaitingWithFunding — that
  // would abandon charged flagged rows instead of holding them.
  const victims = await transfers.listAwaitingWithFunding(FUNDING_RESUME_MINUTES * 60_000);
  let fundingResumed = 0;
  for (const t of victims) {
    // Rail-side config is the SETTLEMENT partner's when routed (same rule as
    // the re-instruct above); the customer-facing stage-1 message rides the
    // OWNING partner's WhatsApp number — settleOrHold persists t.partnerId and
    // the worker resolves the brand creds at drain time (fix 11), never here.
    const railIntegrations = await integrationsRepo.getIntegrations(
      t.settlementPartnerId ?? t.partnerId,
    );
    // Program-Fix 7 (review M2): a Stripe-funded row is RE-SCREENED before it
    // settles (its debit may have confirmed days after the pay-time screen).
    // blocked / moved / a re-screen error ⇒ nothing settles here (a blocked
    // row's fundblocked alert is raised inside); the next sweep retries.
    let kind: 'started' | 'held' | 'refused' | 'already' | undefined;
    if (t.fundingProvider === 'stripe') {
      let funded: Awaited<ReturnType<typeof settleFundedTransfer>>;
      try {
        funded = await settleFundedTransfer(db, t);
      } catch (err) {
        logWarn('reconcile.stripe-resume', err, { transferId: t.id });
        continue;
      }
      if (funded === 'blocked' || funded === 'moved') continue;
      kind = funded;
    } else {
      // Fix pack 2 T3 (R02): a real-money row (the RAIL partner is http, env
      // not 'test') settles only on a LIVE, fresh screen. When the newest
      // evidence is not one, re-screen first with the names on file. An error
      // (evidence read, list, names) moves nothing; the next sweep retries.
      let resumable: Transfer = t;
      if (realMoneyRail({ environment: t.environment, railProviderType: railIntegrations.payment.providerType ?? null })) {
        let outcome: Awaited<ReturnType<typeof rescreenOnFile>> | null = null;
        try {
          if (!liveFresh((await listScreenEvidence(db, t, now)).at(-1), now)) {
            // F3 (C2): the budget is spent: leave this victim untouched (the next sweep resumes it).
            if (!rescreenTimeLeft()) {
              resumeDeferred++;
              continue;
            }
            outcome = await timedRescreen(() => rescreenOnFile(db, t, { realMoney: true, stage: 'resume' }));
          }
        } catch (err) {
          logWarn('reconcile.resume-rescreen', err, { transferId: t.id });
          continue;
        }
        if (outcome?.kind === 'moved') continue;
        if (outcome?.kind === 'blocked') {
          kind = 'refused';
        } else if (outcome) {
          resumable = outcome.transfer;
        }
      }
      kind ??= (await settleOrHold(db, resumable, railIntegrations)).kind;
    }
    const prefix = `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) was charged (${t.fundingRef}) but never settled — `;
    switch (kind) {
      case 'started':
        fundingResumed++;
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'resumed settlement from the sweep.' },
          { dedupeKey: `fundresume:${t.id}` },
        );
        break;
      case 'held':
        // Correct ONLY because a staff release actually instructs the rail
        // (settlement.releaseHold, Step 2) — otherwise "held" would be a
        // charged row the rail is never told about.
        fundingResumed++;
        // Fix pack 2 T3: the LEDGER row's reasons (re-read after the hold)
        // decide the copy: a hold waiting on the list is not a staff release.
        // Fix pack 4 (C19, critic M6): a row with no account-holder name cannot
        // be released at all (checked first). Fix pack 5 (P22): nor can a row
        // whose sender's travel-rule data is missing (checked second).
        const held = await transfers.getTransfer(t.id);
        await outbox.enqueue(
          'ops.alert',
          {
            message:
              prefix +
              (held?.complianceReasons?.includes(RECIPIENT_IDENTITY_MISSING_REASON)
                ? 'HELD for compliance review (in_review), not instructed: the account holder name is missing, so it cannot be released. Reject or refund it in the dashboard.'
                : held?.complianceReasons?.includes(ORIGINATOR_INFO_MISSING_REASON)
                  ? "HELD for compliance review (in_review), not instructed: the sender's address or date of birth is missing, so it cannot be released. Reject or refund it in the dashboard."
                  : waitsForList(held)
                    ? 'HELD for compliance review (in_review), not instructed: ' + LIST_WAIT_COPY
                    : 'flagged by compliance, so it was HELD for compliance review (in_review), not instructed. Release or reject it in the dashboard.'),
          },
          { dedupeKey: `fundhold:${t.id}` },
        );
        break;
      case 'refused':
        // Charged AND blocked: nothing may move. Reached by a resume re-screen
        // that matches (fix pack 2 T3) or a row already compliance-blocked
        // (settleOrHold refuses it); 'blocked' is set only by a sanctions
        // match. There is NO in-app remedy for a charged blocked row (fix 5's
        // Cancel refuses a charged row, Refund accepts only paid|delivered), so
        // the outcome is a change-ticket ledger edit. Review S5 (inventory): it
        // never says to refund: the funds can have to be blocked (frozen) and
        // the licensed partner's compliance officer decides first.
        await outbox.enqueue(
          'ops.alert',
          {
            message:
              prefix +
              `it is BLOCKED by sanctions screening and was CHARGED. NOT settled. ${SANCTIONS_NO_PAYOUT_SENTENCE}. ` +
              'No dashboard action applies: once the compliance officer has decided, record the outcome with a direct ledger edit under a change ticket.',
          },
          { dedupeKey: `fundblocked:${t.id}` },
        );
        break;
      case 'already':
        // Lost the race to a resurrected pay request / a concurrent sweep —
        // the row already moved; keep today's alert (deduped) for the record.
        await outbox.enqueue(
          'ops.alert',
          { message: prefix + 'resumed settlement from the sweep.' },
          { dedupeKey: `fundresume:${t.id}` },
        );
        break;
    }
  }

  // Review R2 (E4): a re-screen left for the next sweep (budget spent) is
  // logged, counts only (no id, no name); the rows are untouched.
  if (healDeferred > 0 || resumeDeferred > 0) {
    logWarn('reconcile.rescreen-deferred', 'the re-screen budget was spent; the next sweep takes these rows', { resumeDeferred, healDeferred });
  }

  // Program-Fix 7 (review M1): STALE STRIPE INTENTS — bound, still pending /
  // failed after STALE_FUNDING_INTENT_DAYS. Such a row cannot be voided (the
  // sender may still confirm the intent) or settled; ops cancels the
  // PaymentIntent in the partner's Stripe dashboard. One alert per row, ever.
  for (const t of await transfers.listStaleFundingIntents(new Date(now.getTime() - STALE_FUNDING_INTENT_DAYS * 86_400_000))) {
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) has a Stripe debit (${t.fundingIntentRef}) still '${t.fundingState}' after ` +
          `${STALE_FUNDING_INTENT_DAYS} days. Cancel the PaymentIntent in the partner's Stripe dashboard, then close the transfer with a ledger edit under a change ticket (in-app cancel refuses intent-bound rows until the server-side cancel follow-up lands).`,
      },
      { dedupeKey: `fundstale:${t.id}` },
    );
  }

  // CHARGED-BUT-CANCELLED (the capture↔cancel race): captureFunding is
  // provider.capture THEN setFundingRef, and the staff cancel guard (Task 5,
  // cancelIfCancellable) is `funding_ref IS NULL`, so a cancel landing between
  // those two calls leaves a cancelled row the customer paid for and nothing
  // refunds. No sweep watched that state. Alert once per row; ops refund it by
  // hand (issueRefund accepts paid|delivered only — by design, the remedy is a
  // human decision). Rows already refunding are Task 5's reject path at work.
  // Review S6 (Y3): a sanctions-blocked row (e.g. the change-ticket ledger
  // edit after a fundblocked:<id> freeze) is never told to refund: the
  // compliance officer decides about the funds. Same key, alert only.
  // Fix pack 7 T16 (P14, C1, M3): a reject that kept the funds under a sanctions hold (D7) is
  // marked by its rejectfunds:<id> outbox row (ONE read for the batch); it is never told to refund.
  const cancelledCharged = await transfers.findCancelledCharged();
  const kept = await outbox.existingDedupeKeys(cancelledCharged.map((t) => `rejectfunds:${t.id}`));
  for (const t of cancelledCharged) {
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          t.complianceStatus === 'blocked'
            ? `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) is CANCELLED, was CHARGED (${t.fundingRef}) and is blocked by sanctions screening; ${SANCTIONS_FUNDS_RULE}.`
            : kept.has(`rejectfunds:${t.id}`)
            ? `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) is CANCELLED, was CHARGED (${t.fundingRef}) and was rejected while a sanctions screening hold was on it; ${SANCTIONS_FUNDS_RULE}.`
            : `⚠️ SmartRemit ops: transfer ${t.id} (partner ${t.partnerId}) is CANCELLED but was CHARGED (${t.fundingRef}) and has no refund in flight — refund it by hand.`,
      },
      { dedupeKey: `cancelcharged:${t.id}` },
    );
  }

  // STUCK REFUND: in flight (refundStatus 'pending') for over an hour. The
  // pending flip and the funding.refund effect commit together, so the OLDEST
  // funding.refund row's age IS the time the refund has been in flight (there
  // is no refund-pending timestamp on the ledger row). A pending refund with
  // NO effect row is a lost effect — equally stuck. Alert only, deduped: no
  // auto-retry, ops decides (the provider may be mid-incident).
  const pendingRefunds = await transfers.listByRefundStatus('pending', 50);
  let stuckRefunds = 0;
  for (const t of pendingRefunds) {
    const res = await db.execute(sql`
      SELECT count(*)::int AS recent FROM outbox
      WHERE kind = 'funding.refund'
        AND payload->>'transferId' = ${t.id}
        AND created_at > now() - make_interval(mins => ${STUCK_REFUND_MINUTES})
    `);
    const recent = Number((res as unknown as { rows: Array<{ recent: number }> }).rows[0]?.recent ?? 0);
    if (recent > 0) continue; // a fresh effect row exists — give it time
    stuckRefunds++;
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: refund for transfer ${t.id} (partner ${t.partnerId}) has been ` +
          `pending for >${STUCK_REFUND_MINUTES}min — check the funding provider and the outbox.`,
      },
      { dedupeKey: `refundstuck:${t.id}` },
    );
  }

  // STALE LOCKS (fix 7): leases the drain should have reclaimed but has not.
  // The alert is itself an outbox row — if the drain is dead it will not send,
  // which is why the ops page and scripts/outbox-status.ts read this out of
  // band. Ids/kinds only — never print a payload.
  const staleLocks = await outbox.listStaleProcessing(STALE_LOCK_MINUTES);
  for (const row of staleLocks) {
    await outbox.enqueue(
      'ops.alert',
      {
        message:
          `⚠️ SmartRemit ops: outbox #${row.id} (${row.kind}) has sat in 'processing' for ` +
          `>${STALE_LOCK_MINUTES}m past its lease and was not reclaimed — the worker drain is not running; ` +
          `check the Vercel cron (Settings → Cron Jobs) and the GitHub heartbeat.`,
      },
      { dedupeKey: `stalelock:${row.id}` },
    );
  }

  // LIST-OUTAGE HOLDS (fix pack 2 T4): re-screen the in_review rows held
  // because the sanctions list was not live, and release the clean ones
  // (list-hold-rescreen.ts, the only release path for them). Isolated: it
  // never throws, and a failure here never costs the sweeps above.
  let listHoldsReleased = 0;
  try {
    listHoldsReleased = (await sweepListUnavailableHolds(db, now, opts.clock ? { clock: opts.clock } : {})).released;
  } catch (e) {
    logWarn('reconcile', 'list-hold re-screen skipped', { error: e instanceof Error ? e.message : String(e) });
  }

  // TICKET SLA DIGEST (Program-Fix 49C): staff-facing, never customer-facing.
  // Last, and isolated: a failed ticket read must never cost the money sweeps
  // above their result. SweepResult is deliberately unchanged.
  try {
    await sweepTicketSlaDigest(db, now);
  } catch (e) {
    logWarn('reconcile', 'ticket SLA digest skipped', { error: e instanceof Error ? e.message : String(e) });
  }

  // REG E CLOCK DIGEST (fix pack 8 P15): staff-facing; isolated like the SLA digest.
  try {
    await sweepRegClockDigest(db, now);
  } catch (e) {
    logWarn('reconcile', 'reg clock digest skipped', { error: e instanceof Error ? e.name : 'unknown' });
  }

  return {
    stuckPaid: stuck.length,
    reinstructed,
    staleReviews: stale.length,
    fundingResumed,
    stuckRefunds,
    staleLocks: staleLocks.length,
    listHoldsReleased,
  };
}

/** Oldest ticket ids named in the digest. */
const TICKET_SLA_DIGEST_IDS = 5;

/**
 * ONE ops.alert per UTC day (`ticketsla:<yyyy-mm-dd>`) when any customer ticket
 * is past its first-response target with no staff reply — never one alert per
 * ticket (an old backlog would otherwise fire N alerts at deploy). The day's
 * key is checked FIRST so the breach query runs at most until the digest is
 * queued. Ids, priorities and counts only: never a subject or a phone.
 * Returns whether a new digest row was queued.
 */
export async function sweepTicketSlaDigest(db: Db, now: Date): Promise<boolean> {
  const outbox = createOutboxRepo(db);
  const key = slaDigestKey(now);
  if (await outbox.hasDedupeKey(key)) return false;
  const breaches = await createTicketRepo(db).listSlaBreaches({ now, limit: TICKET_SLA_DIGEST_IDS });
  if (breaches.total === 0) return false;
  const h = FIRST_RESPONSE_DUE_HOURS;
  const b = breaches.byPriority;
  return outbox.enqueue(
    'ops.alert',
    {
      message:
        `⚠️ SmartRemit ops: ${breaches.total} customer ticket(s) have no staff reply past the internal ` +
        `first-response target (urgent ${h.urgent}h / normal ${h.normal}h / low ${h.low}h): ` +
        `${b.urgent} urgent, ${b.normal} normal, ${b.low} low. ` +
        `Oldest: ${breaches.oldest.map((t) => `${t.id} (${t.priority}, partner ${t.partnerId})`).join(', ')}. ` +
        `Work them from Tickets.`,
    },
    { dedupeKey: key },
  );
}

/** Due window of the regulatory clock digest: cases due within 3 days (P15). */
export const REG_CLOCK_DIGEST_WITHIN_MS = 3 * 86_400_000;
/** Oldest regulatory case ids named in the digest. */
export const REG_CLOCK_DIGEST_IDS = 5;

/** `regclock:<yyyy-mm-dd>` (UTC day, like `slaDigestKey`; no partner part). */
export function regClockDigestKey(now: Date): string {
  return `regclock:${now.toISOString().slice(0, 10)}`;
}

/**
 * Regulatory clock digest (fix pack 8 P15): staff-facing, platform-wide, one
 * per UTC day; ids and counts only (never a subject, a phone, a class or a
 * partner name). ONE ops.alert (`regclock:<day>`) when any open classed case
 * (Reg E error notice, complaint, cancellation, fraud report) is due within 3
 * days or overdue. The day's key is checked FIRST so the due query runs at most
 * until the digest is queued. Returns whether a new digest row was queued.
 */
export async function sweepRegClockDigest(db: Db, now: Date): Promise<boolean> {
  const outbox = createOutboxRepo(db);
  const key = regClockDigestKey(now);
  if (await outbox.hasDedupeKey(key)) return false;
  const due = await createTicketRepo(db).listRegClockDue({
    now,
    withinMs: REG_CLOCK_DIGEST_WITHIN_MS,
    limit: REG_CLOCK_DIGEST_IDS,
  });
  if (due.total === 0) return false;
  return outbox.enqueue(
    'ops.alert',
    {
      message:
        `⏰ SmartRemit ops: ${due.total} regulatory case(s) are due within 3 days (${due.overdue} overdue). ` +
        `Oldest: ${due.ids.join(', ')}. Open them in the Tickets queue.`,
    },
    { dedupeKey: key },
  );
}

// ── Ops data (consumed by the Stage-5 /admin-dashboard/ops page) ─────────────

export interface OpsSnapshot {
  pendingOutbox: number;
  deadLetters: OutboxRow[];
  /** 'processing' rows whose lease expired >STALE_LOCK_MINUTES ago and were not reclaimed. */
  staleLocks: OutboxRow[];
  stuckPaid: Transfer[];
  staleReviews: Transfer[];
  /** Refund queues (masked reads): customer-requested / in flight / failed. */
  refundsRequested: Transfer[];
  refundsPending: Transfer[];
  refundsFailed: Transfer[];
}

export async function getOpsSnapshot(db: Db): Promise<OpsSnapshot> {
  const transfers = createTransferRepo(db);
  const outbox = createOutboxRepo(db);
  return {
    pendingOutbox: await outbox.countPending(),
    deadLetters: await outbox.listDead(),
    staleLocks: await outbox.listStaleProcessing(STALE_LOCK_MINUTES),
    stuckPaid: await transfers.findStuckPaid(STUCK_PAID_MINUTES),
    staleReviews: await transfers.findInReviewOlderThan(STALE_REVIEW_HOURS),
    refundsRequested: await transfers.listByRefundStatus('requested'),
    refundsPending: await transfers.listByRefundStatus('pending'),
    refundsFailed: await transfers.listByRefundStatus('failed'),
  };
}
