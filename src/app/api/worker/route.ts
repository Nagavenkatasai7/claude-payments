import { NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { getDb } from '@/db/client';
import { getStore } from '@/lib/store';
import { drainOnce, type WorkerDeps } from '@/lib/outbox-worker';
import {
  sendText,
  sendTemplate,
  RECIPIENT_TEMPLATE_NAME,
  RECIPIENT_TEMPLATE_LANG,
} from '@/lib/whatsapp';
import { newTransferId } from '@/lib/id';

export const maxDuration = 60;

// /api/worker — drains the durability outbox (Stage 2b). Invoked two ways:
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

  const deps: WorkerDeps = {
    db: getDb(),
    store: getStore(),
    sendText,
    sendTemplate,
    fetchFn: fetch,
    recipientTemplateName: RECIPIENT_TEMPLATE_NAME,
    recipientTemplateLang: RECIPIENT_TEMPLATE_LANG,
  };

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

  return NextResponse.json({ ok: true, processed, failed, dead });
}

export async function POST(req: NextRequest) {
  return run(req);
}

// The heartbeat (GitHub Actions cron) calls GET for simplicity; same handler.
export async function GET(req: NextRequest) {
  return run(req);
}
