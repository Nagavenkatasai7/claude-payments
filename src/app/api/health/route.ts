import type { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { bearerMatches } from '@/lib/cron-auth';
import { getDb } from '@/db/client';
import { gateRedis, LAST_FULL_KEY } from '@/lib/worker-gate';
import { currentBuildErrors } from '@/lib/deploy-error-watch';
import { evaluateHealth, withTimeout, HEALTH_DB_TIMEOUT_MS, HEALTH_MEMO_MS, type LastFullRead } from '@/lib/health';

// GET /api/health — the PULL half of the external dead-man's switch
// (src/lib/health.ts has the decision table). 200 when `worker:lastFullAt` is
// at most 40 min old, else 503; the body is enum strings only.
//
// Two tiers:
//   • anonymous — Redis only: one bounded GET through the gate's client
//     (retry: false, 2 s abort), memoised per warm instance for 15 s. It NEVER
//     touches Neon: an open endpoint that woke the database would let anyone
//     keep it from scaling to zero (partner-demo R4).
//   • Bearer CRON_SECRET — adds a bounded Neon `select 1`. Fail-closed: any
//     Authorization header that does not match (or an unset secret) is 401,
//     never a silent downgrade to the anonymous tier.
//
// Poke full runs also refresh lastFullAt, so this endpoint can stay 200 while
// the Vercel cron is dead as long as traffic keeps poking. Only the push ping
// (src/lib/dead-man-ping.ts, cron runs only) catches a dead cron: set up BOTH.
//
// Not under the proxy matcher on the apex host and not rate-limited; on a
// partner subdomain the site proxy answers instead, so monitors must use
// https://smartremit.ai/api/health. HEAD is served by GET: Next auto-implements
// HEAD from GET (node_modules/next/dist/server/route-modules/app-route/helpers/
// auto-implement-methods.js:36-43; methods list in
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:24).

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'no-store' };

let memo: { atMs: number; status: number; body: unknown } | null = null;

async function readLastFull(): Promise<LastFullRead> {
  try {
    return { ok: true, raw: await gateRedis().get(LAST_FULL_KEY) };
  } catch {
    return { ok: false }; // a Redis error or a missing KV env (constructor throw)
  }
}

async function readBuildErrors(): Promise<number | null> {
  try {
    return await currentBuildErrors(gateRedis());
  } catch {
    return null; // a missing KV env (constructor throw)
  }
}

async function probeDb(): Promise<'ok' | 'fail'> {
  try {
    await withTimeout(getDb().execute(sql`select 1`), HEALTH_DB_TIMEOUT_MS);
    return 'ok';
  } catch {
    return 'fail';
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  const authorization = req.headers.get('authorization');
  if (authorization !== null) {
    if (!env.cronSecret || !bearerMatches(authorization, env.cronSecret)) {
      return new Response('Unauthorized', { status: 401, headers: HEADERS });
    }
    const [lastFull, db, buildErrors] = await Promise.all([readLastFull(), probeDb(), readBuildErrors()]);
    const r = evaluateHealth({ nowMs: Date.now(), lastFull, db });
    // Release safety part D: this build's server error count (a number, or null).
    return Response.json({ ...r.body, buildErrors }, { status: r.status, headers: HEADERS });
  }

  const nowMs = Date.now();
  if (!memo || nowMs - memo.atMs >= HEALTH_MEMO_MS) {
    const r = evaluateHealth({ nowMs, lastFull: await readLastFull() });
    memo = { atMs: nowMs, status: r.status, body: r.body };
  }
  return Response.json(memo.body, { status: memo.status, headers: HEADERS });
}
