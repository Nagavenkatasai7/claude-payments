import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { bearerMatches } from '@/lib/cron-auth';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep, type SweepResult } from '@/lib/reconcile';
import { amlSweep, amlRedis, type AmlSweepResult } from '@/lib/aml-sweep';
import { sweepFxHealth, sweepStaleRates } from '@/lib/rate-staleness';
import { escalateStuckPaid } from '@/lib/stale-money';
import {
  cadenceRedis,
  checkCronQuiet,
  cronMarkerFresh,
  invocationSource,
  readLastCronAt,
  recordCronRun,
  shouldProbeFx,
  sweepDrainGap,
  type CronQuietResult,
  type DrainGapResult,
} from '@/lib/worker-cadence';
import {
  clearLease,
  gateDecision,
  gateRedis,
  isBackstopMinute,
  isLastFullFresh,
  isWorkDue,
  markDue,
  markLease,
  recordFullRun,
  trimDue,
  type GateRedis,
} from '@/lib/worker-gate';
import { createOutboxRepo, LEASE_MS } from '@/db/repos/outbox-repo';
import { logError } from '@/lib/log';
import {
  sendText,
  sendTemplate,
  RECIPIENT_TEMPLATE_NAME,
  RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';
import { newTransferId } from '@/lib/id';
import { RAIL_TIMEOUT_MS } from '@/lib/providers/http-payment-provider';
import { safeFetch } from '@/lib/safe-fetch';
import { chat } from '@/lib/ollama';
import { createAgent } from '@/lib/agent';
import { getCustomerStore } from '@/lib/customer-store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getDraftStore } from '@/lib/draft-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getKycProvider } from '@/lib/providers/kyc-provider';
import { getPartnerStore } from '@/lib/partner-store';
import { DEFAULT_PARTNER_ID } from '@/lib/defaults';

export const maxDuration = 60;

// /api/worker — drains the durability outbox (Stage 2b) and runs the
// reconciliation sweep (Stage 2d). Invoked three ways (src/lib/worker-cadence):
//   • the Vercel per-minute cron (vercel.json `* * * * *`; a GET carrying
//     x-vercel-cron-schedule) — the clock,
//   • the hourly GitHub Actions heartbeat (a plain GET) — the backup, and the
//     call that can notice a quiet cron,
//   • the after() POKE from any enqueue site (a POST) — the fast path.
// partner-demo R4 (Neon compute): a cron tick with no outbox work due in the
// Redis due set (src/lib/worker-gate.ts), off the :17/:47 backstop minute,
// returns BEFORE getDb()/getStore() — Neon is not woken. The heartbeat is
// gated the same way while the cron marker is fresh. A poke always runs full.
// Either one also runs full when `worker:lastFullAt` (written after every
// completed full run) is missing, unreadable or older than 30 min.
// The gate only skips INVOCATIONS, never rows, and fails open.
// Claiming uses FOR UPDATE SKIP LOCKED and a 5-minute LEASE, so overlapping
// invocations are safe and a killed invocation's rows are reclaimed. Auth
// mirrors /api/cron: Bearer CRON_SECRET when configured — Vercel sends exactly
// that header (manage-cron-jobs, "Securing cron jobs").

const TIME_BUDGET_MS = 45_000;
// No row STARTS after this point in the invocation: a money row (bounded by the
// 15s rail deadline + two DB round trips) started at the cutoff still finishes
// inside TIME_BUDGET_MS and well inside maxDuration. Fix 8 owns cadence and
// may retune this.
const START_CUTOFF_MS = TIME_BUDGET_MS - RAIL_TIMEOUT_MS;
// The platform kills the invocation at maxDuration (60s). START_CUTOFF_MS (30s)
// + ROW_DEADLINE_MS (40s) exceeds it, so an agent.turn started at 29s would be
// killed mid-turn, reclaimed after LEASE_MS and RE-RUN — the non-idempotent
// re-run invariant 5 forbids. drainOnce therefore refuses to START a
// TERMINAL_ON_DEADLINE row that could still be running at hardStopAt and
// releases it (attempt refunded) for the next invocation instead.
const HARD_STOP_MARGIN_MS = 2_000;
// partner-demo R4: the lease member's score. Every claim this invocation makes
// happens before the platform kill (invocationStart + maxDuration), so every
// lease it takes expires by that instant + LEASE_MS. The slack absorbs clock
// skew between this function and Postgres now(), which stamps lease_until.
const LEASE_MARK_SLACK_MS = 5_000;
// Marks at least this old are trimmed after a full run: rows committed during
// the last minute (a poke racing this drain) keep one re-check.
const TRIM_LAG_MS = 60_000;

async function run(req: NextRequest): Promise<NextResponse> {
  // The platform's kill clock starts at invocation, not after the sweeps —
  // hardStopAt below must be derived from THIS instant.
  const invocationStart = Date.now();
  // Constant-time, fail-closed (src/lib/cron-auth.ts).
  if (env.cronSecret && !bearerMatches(req.headers.get('authorization'), env.cronSecret)) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // Cadence (Program-Fix 12). ONE clock instant for every gate and dedupe
  // bucket below. The source label is read AFTER the Bearer check: an
  // unauthenticated request never touches the marker. The marker is written
  // BEFORE the drain so a saturated drain the platform kills at maxDuration
  // still leaves proof the cron reached us (else cronquiet false-alarms);
  // the client has no retries and a 2 s abort, so it can only shorten a drain.
  const now = new Date(invocationStart);
  const source = invocationSource(req.method, req.headers);
  if (source === 'cron') {
    try {
      await recordCronRun(cadenceRedis(), now);
    } catch (err) {
      logError('worker.cron-marker', err); // client construction (missing KV env) — the drain still runs
    }
  }

  // partner-demo R4 — the Neon gate. Runs after the Bearer check and the
  // cron marker, and BEFORE anything touches the database. FAIL-OPEN: a
  // missing client, a Redis error or a marker read error all mean a full run.
  let gate: GateRedis | null = null;
  try {
    gate = gateRedis();
  } catch (err) {
    logError('worker.gate-client', err);
  }
  if (source !== 'poke' && gate && !(source === 'cron' && isBackstopMinute(now))) {
    let gated = false;
    try {
      const due = await isWorkDue(gate, now.getTime());
      const lastFullFresh = !due && (await isLastFullFresh(gate, now.getTime()));
      const cronFresh =
        source === 'heartbeat' && !due && lastFullFresh
          ? cronMarkerFresh(await readLastCronAt(cadenceRedis()), now)
          : false;
      gated = gateDecision({ source, backstop: isBackstopMinute(now), due, cronFresh, lastFullFresh }) === 'gated';
    } catch (err) {
      logError('worker.gate', err);
    }
    if (gated) return NextResponse.json({ ok: true, source, gated: true });
  }

  const store = getStore();
  const deps: WorkerDeps = {
    db: getDb(),
    store,
    sendText,
    sendTemplate,
    // Fix 22: every rail POST (settlement.instruct, funding.refund reverse,
    // rail.callback) goes through safeFetch — https only, connect-time private-
    // address check, ≤2 same-origin 307/308, identity encoding, 64 KB ack cap.
    fetchFn: safeFetch,
    recipientTemplateName: RECIPIENT_TEMPLATE_NAME,
    recipientTemplateLang: RECIPIENT_TEMPLATE_LANG,
    listStaff: () => getAuthStore().listStaff(),
    runAgentTurn: async (phone, message, turn, waCreds, opts) => {
      const routedPartnerId = opts?.routedPartnerId ?? null;
      const customerStore = getCustomerStore(store);
      const agent = createAgent({
        chat,
        store,
        scheduleStore: getScheduleStore(),
        draftStore: getDraftStore(),
        customerStore,
        dailyVolumeStore: getDailyVolumeStore(),
        monthlyVolumeStore: getMonthlyVolumeStore(),
        kycProvider: getKycProvider(customerStore, env.appBaseUrl),
        partnerStore: getPartnerStore(),
        waCreds, // WL2: interactive sends + replies leave from the partner's number
        partnerId: routedPartnerId ?? DEFAULT_PARTNER_ID, // fix 1: the turn runs under the routed tenant
      });
      // Fix 7: the worker's cooperative row deadline stops the turn between tool rounds.
      return agent.runAgentTurn(phone, message, turn, { signal: opts?.signal });
    },
  };

  // Quiet-cron check on NON-cron calls only (a cron call cannot notice its own
  // absence). Its alert row drains in this same invocation. Fail-open.
  let cronQuiet: CronQuietResult | null = null;
  if (source !== 'cron') {
    try {
      cronQuiet = await checkCronQuiet(deps.db, cadenceRedis(), now);
    } catch (err) {
      logError('worker.cron-quiet', err);
    }
  }

  // Safety-net sweep FIRST so its enqueued effects drain in this same
  // invocation. Two indexed queries that normally return zero rows — cheap
  // enough to run on every poke.
  let sweep: SweepResult = { stuckPaid: 0, reinstructed: 0, staleReviews: 0 };
  try {
    sweep = await reconcileSweep(deps.db);
  } catch (err) {
    logError('worker.sweep', err);
  }

  // Behavioural AML monitoring (Program-Fix 43): alerts + review items only —
  // never a hold, never a transfer write. Locked (a concurrent poke skips),
  // cursor-driven and time-boxed (a few seconds) so it never eats the drain's
  // window below; its ops alerts drain in this same invocation. A throw never
  // blocks the drain.
  let aml: AmlSweepResult | null = null;
  try {
    aml = await amlSweep(deps.db, amlRedis(), { now });
  } catch (err) {
    logError('worker.aml-sweep', err);
  }

  // Pricing staleness sweep (same heartbeat): each expired pushed partner rate
  // raises exactly one deduped ops alert. Failures never block the drain.
  let staleRates = 0;
  try {
    staleRates = await sweepStaleRates(deps.db);
  } catch (err) {
    logError('worker.rate-sweep', err);
  }

  // Stuck-paid escalation ladder (Program-Fix 32, neon-10): one deduped ops
  // alert + audit row per rung (1 h / 6 h / 24 h / daily) while a transfer
  // stays 'paid' with no delivery. reconcileSweep's one-shot recon:<id> alert
  // is unchanged. Failures never block the drain.
  let escalated = 0;
  try {
    escalated = await escalateStuckPaid(deps.db, now);
  } catch (err) {
    logError('worker.stuck-escalation', err);
  }

  // Drain-gap SLA (Program-Fix 12): one deduped ops alert per hour while the
  // oldest claimable row (due, or an expired lease) has waited past
  // DRAIN_SLA_MINUTES. Counts and ages only; a throw never blocks the drain.
  let drainGap: DrainGapResult | null = null;
  try {
    drainGap = await sweepDrainGap(deps.db, now);
  } catch (err) {
    logError('worker.drain-gap', err);
  }

  // Platform FX health (Task 9, R9): at most one combined ops alert per
  // severity (UNAVAILABLE / DEGRADED ≥ 15 min) per hour. shouldProbeFx
  // (src/lib/worker-cadence.ts): the heartbeat GET whenever it runs full, the
  // per-minute cron only on the :17/:47 backstop minute (partner-demo R4),
  // never a POST poke (src/lib/outbox.ts) — during an outage every poke (or
  // every cron tick) would otherwise re-dial Frankfurter for 9 currencies. Probe
  // starts are staggered 250 ms and each gets one 7 s retry after its 5 s
  // attempt: worst case ~14 s, absorbed by stopAfter below (hardStopAt-based);
  // a throw never blocks the drain.
  let fxHealth = 0;
  if (shouldProbeFx(source, now)) {
    try {
      fxHealth = await sweepFxHealth(deps.db);
    } catch (err) {
      logError('worker.fx-sweep', err);
    }
  }

  const workerId = `w_${newTransferId()}`;
  const started = Date.now(); // drain-loop budget clock (after the sweeps)
  const hardStopAt = invocationStart + maxDuration * 1000 - HARD_STOP_MARGIN_MS;
  // Slow sweeps must not let a money row START so late that its 15s rail deadline
  // outruns the platform kill: the cutoff is also bounded by hardStopAt.
  const stopAfter = Math.min(started + START_CUTOFF_MS, hardStopAt - RAIL_TIMEOUT_MS);
  let processed = 0;
  let failed = 0;
  let dead = 0;
  let released = 0;
  // partner-demo R4: at the first claim, mark `lease:<workerId>` due when the
  // last lease this invocation can hold expires. Removed on normal completion
  // below; only a KILLED invocation leaves it, waking a reclaim run on time.
  let leaseMarked = false;
  const onClaim = async (): Promise<void> => {
    if (leaseMarked || !gate) return;
    leaseMarked = true;
    await markLease(gate, workerId, invocationStart + maxDuration * 1000 + LEASE_MS + LEASE_MARK_SLACK_MS);
  };
  let completed = false;
  let leftover = false;
  try {
    // Keep draining until the queue is empty or the start cutoff passes. A batch
    // is only CLAIMED while a row could still be started — a claim we cannot
    // start would sit under its lease until the next drain reclaimed it.
    for (;;) {
      const r = await drainOnce(deps, workerId, 10, { stopAfter, hardStopAt, onClaim });
      processed += r.processed;
      failed += r.failed;
      dead += r.dead;
      released += r.released;
      // A release-only pass ends the loop: `released` is deliberately NOT counted.
      // Past (hardStopAt − ROW_DEADLINE_MS) every remaining agent.turn row would
      // otherwise be claimed (attempts+1, lease) and released (attempts−1) on EVERY
      // iteration until stopAfter — ~12s of claim/release churn against Neon that,
      // with ORDER BY id and batch 10, starves higher-id money rows. Released rows
      // are pending again; the next poke/heartbeat picks them up.
      const drainedNothing = r.processed + r.failed + r.dead === 0;
      if (drainedNothing) break;
      if (Date.now() >= stopAfter) {
        leftover = true;
        break;
      }
    }
    completed = true;
  } finally {
    // partner-demo R4 — tell the gate when to wake Neon next. Runs even when
    // the drain threw (then the work stays marked due NOW and the next cron
    // tick retries, rather than waiting for the backstop).
    if (gate) {
      await markAfterDrain(gate, deps, { invocationStart, workerId, completed, leftover, released });
      // R4 follow-up: the time-based backstop's clock. Only a COMPLETED run,
      // only after its marks, and stamped with its START (conservative: work
      // committed during the run is covered by the marks, not by this).
      if (completed) await recordFullRun(gate, invocationStart);
    }
  }

  // Nothing parses this body (the heartbeat curls to /dev/null; the poke ignores
  // it), so adding fields is safe across a rolling release.
  return NextResponse.json({
    ok: true, source, gated: false, processed, failed, dead, released, sweep, aml, staleRates, escalated, fxHealth, drainGap, cronQuiet,
  });
}

/**
 * partner-demo R4: the post-drain marks, in this order —
 *   1. read the earliest pending/failed next_attempt_at (a DB read error ⇒
 *      mark now: fail-open);
 *   2. mark max(nextDue, now) — clamped to now so a concurrent invocation's
 *      trim can never remove a mark for a row that is still waiting;
 *   3. mark now when the drain threw, stopped at the cutoff with work left, or
 *      released rows;
 *   4. trim marks older than invocationStart − TRIM_LAG_MS (anything committed
 *      before then was visible to this drain's claims, or is still covered by a
 *      future-dated or lease mark). AFTER the marks (R4 follow-up): a crash
 *      between the two then leaves extra marks (a spare full run), never a
 *      trimmed set with the next due instant missing. Every mark above is ≥
 *      markNow > the cutoff, so this trim cannot remove them;
 *   5. on normal completion only, remove this invocation's lease member.
 * Every Redis call is fail-open (worker-gate never throws).
 */
async function markAfterDrain(
  gate: GateRedis,
  deps: WorkerDeps,
  run: { invocationStart: number; workerId: string; completed: boolean; leftover: boolean; released: number },
): Promise<void> {
  let nextDue: Date | null = null;
  let readFailed = false;
  if (run.completed) {
    try {
      nextDue = await createOutboxRepo(deps.db).nextDueAt();
    } catch (err) {
      readFailed = true;
      logError('worker.gate-next-due', err);
    }
  }
  const markNow = Date.now();
  if (nextDue) await markDue(gate, Math.max(nextDue.getTime(), markNow));
  if (!run.completed || readFailed || run.leftover || run.released > 0) await markDue(gate, markNow);
  await trimDue(gate, run.invocationStart - TRIM_LAG_MS);
  if (run.completed) await clearLease(gate, run.workerId);
}

export async function POST(req: NextRequest) {
  return run(req);
}

// The Vercel cron and the GitHub heartbeat call GET (Vercel always GETs the
// production deployment: vercel.com/docs/cron-jobs, "How cron jobs work").
export async function GET(req: NextRequest) {
  return run(req);
}
