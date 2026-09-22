import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { getAuthStore } from '@/lib/auth-store';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep, type SweepResult } from '@/lib/reconcile';
import { sweepFxHealth, sweepStaleRates } from '@/lib/rate-staleness';
import {
  cadenceRedis,
  checkCronQuiet,
  invocationSource,
  recordCronRun,
  shouldProbeFx,
  sweepDrainGap,
  type CronQuietResult,
  type DrainGapResult,
} from '@/lib/worker-cadence';
import { logError } from '@/lib/log';
import {
  sendText,
  sendTemplate,
  RECIPIENT_TEMPLATE_NAME,
  RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';
import { newTransferId } from '@/lib/id';
import { RAIL_TIMEOUT_MS } from '@/lib/providers/http-payment-provider';
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

async function run(req: NextRequest): Promise<NextResponse> {
  // The platform's kill clock starts at invocation, not after the sweeps —
  // hardStopAt below must be derived from THIS instant.
  const invocationStart = Date.now();
  if (env.cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  // Cadence (Program-Fix 12). ONE clock instant for every gate and dedupe
  // bucket below. The source label is read AFTER the Bearer check: an
  // unauthenticated request never touches the marker. The marker is written
  // BEFORE the drain so a saturated drain the platform kills at maxDuration
  // still leaves proof the cron reached us (else cronquiet false-alarms);
  // the client has no retries and a 2 s abort, so it can only shorten a drain.
  const now = new Date(invocationStart);
  const source = invocationSource(req.method, req.headers);
  if (source === 'cron') await recordCronRun(cadenceRedis(), now);

  const store = getStore();
  const deps: WorkerDeps = {
    db: getDb(),
    store,
    sendText,
    sendTemplate,
    fetchFn: fetch,
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

  // Pricing staleness sweep (same heartbeat): each expired pushed partner rate
  // raises exactly one deduped ops alert. Failures never block the drain.
  let staleRates = 0;
  try {
    staleRates = await sweepStaleRates(deps.db);
  } catch (err) {
    logError('worker.rate-sweep', err);
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

  // Platform FX health (Task 9): one deduped ops alert per degraded/refusing
  // currency per hour. shouldProbeFx (src/lib/worker-cadence.ts): the hourly
  // heartbeat GET always, the per-minute cron only on a :x0 minute, never a
  // POST poke (src/lib/outbox.ts) — during an outage every poke (or every
  // cron tick, 1,440 a day) would otherwise re-dial Frankfurter for 9
  // currencies. The probes run in parallel, each bounded by
  // FX_FETCH_TIMEOUT_MS; a throw never blocks the drain.
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
  // Keep draining until the queue is empty or the start cutoff passes. A batch
  // is only CLAIMED while a row could still be started — a claim we cannot
  // start would sit under its lease until the next drain reclaimed it.
  for (;;) {
    const r = await drainOnce(deps, workerId, 10, { stopAfter, hardStopAt });
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
    if (drainedNothing || Date.now() >= stopAfter) break;
  }

  // Nothing parses this body (the heartbeat curls to /dev/null; the poke ignores
  // it), so adding fields is safe across a rolling release.
  return NextResponse.json({
    ok: true, source, processed, failed, dead, released, sweep, staleRates, fxHealth, drainGap, cronQuiet,
  });
}

export async function POST(req: NextRequest) {
  return run(req);
}

// The Vercel cron and the GitHub heartbeat call GET (Vercel always GETs the
// production deployment: vercel.com/docs/cron-jobs, "How cron jobs work").
export async function GET(req: NextRequest) {
  return run(req);
}
