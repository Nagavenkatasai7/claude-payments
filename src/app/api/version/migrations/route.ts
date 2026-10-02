import { getDb } from '@/db/client';
import { compareMigrations, JOURNAL_ENTRIES, readAppliedMigrations } from '@/db/migration-status';
import { bearerMatches } from '@/lib/cron-auth';
import { shortCommitSha } from '@/lib/deploy-version';
import { env } from '@/lib/env';
import { logError } from '@/lib/log';

// GET /api/version/migrations → { sha, ok, expected, applied, pending[], unknownApplied[] }
//
// Has production Neon applied every migration THIS build's bundled journal
// expects? The post-deploy smoke and the nightly prod smoke read it after the
// rolling release reaches 100% (.github/workflows/smoke.yml, nightly.yml).
// Kept off /api/version on purpose: the rollout wait polls that route hundreds
// of times per deploy and pins its body to { sha }.
//
// Bearer CRON_SECRET, FAIL-CLOSED: 401 when the secret is unset too (unlike
// /api/cron), so it is never an anonymous DB hit. A database error answers
// 503 { error: 'unreadable' } without the driver's message.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request): Promise<Response> {
  const secret = env.cronSecret;
  if (!secret || !bearerMatches(req.headers.get('authorization'), secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  }
  const sha = shortCommitSha(process.env.VERCEL_GIT_COMMIT_SHA);
  try {
    const applied = await readAppliedMigrations(getDb());
    return Response.json({ sha, ...compareMigrations(JOURNAL_ENTRIES, applied) }, { headers: NO_STORE });
  } catch (e) {
    logError('migration-status', e);
    return Response.json({ sha, ok: false, error: 'unreadable' }, { status: 503, headers: NO_STORE });
  }
}
