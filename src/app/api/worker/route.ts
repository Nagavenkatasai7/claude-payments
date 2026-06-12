import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import { reconcileSweep, type SweepResult } from '@/lib/reconcile';
import { sweepStaleRates } from '@/lib/rate-staleness';
import { logError } from '@/lib/log';
import {
  sendText,
  sendTemplate,
  RECIPIENT_TEMPLATE_NAME,
  RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';
import { newTransferId } from '@/lib/id';
import { chat } from '@/lib/ollama';
import { createAgent } from '@/lib/agent';
import { getCustomerStore } from '@/lib/customer-store';
import { getScheduleStore } from '@/lib/schedule-store';
import { getDraftStore } from '@/lib/draft-store';
import { getDailyVolumeStore } from '@/lib/daily-volume-store';
import { getMonthlyVolumeStore } from '@/lib/monthly-volume-store';
import { getKycProvider } from '@/lib/providers/kyc-provider';
import { getPartnerStore } from '@/lib/partner-store';

export const maxDuration = 60;

// /api/worker — drains the durability outbox (Stage 2b) and runs the
// reconciliation sweep (Stage 2d). Invoked two ways:
//   • the after() POKE from any enqueue site (fast path, best effort),
//   • the GitHub Actions 5-minute heartbeat (the delivery guarantee).
// Claiming uses FOR UPDATE SKIP LOCKED, so overlapping invocations are safe by
// construction. Auth mirrors /api/cron: Bearer CRON_SECRET when configured.

const TIME_BUDGET_MS = 45_000;

async function run(req: NextRequest): Promise<NextResponse> {
  if (env.cronSecret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${env.cronSecret}`) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const store = getStore();
  const deps: WorkerDeps = {
    db: getDb(),
    store,
    sendText,
    sendTemplate,
    fetchFn: fetch,
    recipientTemplateName: RECIPIENT_TEMPLATE_NAME,
    recipientTemplateLang: RECIPIENT_TEMPLATE_LANG,
    runAgentTurn: async (phone, message, turn, waCreds) => {
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
      });
      return agent.runAgentTurn(phone, message, turn);
    },
  };

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

  const workerId = `w_${newTransferId()}`;
  const started = Date.now();
  let processed = 0;
  let failed = 0;
  let dead = 0;
  // Keep draining until the queue is empty or the time budget is spent.
  for (;;) {
    const r = await drainOnce(deps, workerId, 10);
    processed += r.processed;
    failed += r.failed;
    dead += r.dead;
    const drainedNothing = r.processed + r.failed + r.dead === 0;
    if (drainedNothing || Date.now() - started > TIME_BUDGET_MS) break;
  }

  return NextResponse.json({ ok: true, processed, failed, dead, sweep, staleRates });
}

export async function POST(req: NextRequest) {
  return run(req);
}

// The heartbeat (GitHub Actions cron) calls GET for simplicity; same handler.
export async function GET(req: NextRequest) {
  return run(req);
}
