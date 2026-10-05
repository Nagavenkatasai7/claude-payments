import { getDb } from '@/db/client';
import { createOutboxRepo } from '@/db/repos/outbox-repo';
import { bearerMatches } from '@/lib/cron-auth';
import { buildDeployAlert } from '@/lib/deploy-alert';
import { env } from '@/lib/env';
import { logError } from '@/lib/log';
import { pokeWorker } from '@/lib/outbox';

// POST /api/ops/deploy-alert — release-check.yml and smoke.yml raise one ops
// alert about a release (Release safety Batch 2 part B). Bearer CRON_SECRET,
// FAIL-CLOSED (401 when the secret is unset). The body names a fixed kind and
// commit SHAs only (src/lib/deploy-alert.ts); the alert is an outbox row with a
// dedupe key, so a re-run sends nothing new. Answers { queued: true|false }.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: Request): Promise<Response> {
  const secret = env.cronSecret;
  if (!secret || !bearerMatches(req.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const alert = buildDeployAlert(body);
  if (!alert) return Response.json({ error: 'invalid' }, { status: 400, headers: NO_STORE });
  try {
    const queued = await createOutboxRepo(getDb()).enqueue('ops.alert', { message: alert.message }, { dedupeKey: alert.dedupeKey });
    pokeWorker();
    return Response.json({ queued }, { headers: NO_STORE });
  } catch (e) {
    logError('deploy-alert', e);
    return Response.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  }
}
