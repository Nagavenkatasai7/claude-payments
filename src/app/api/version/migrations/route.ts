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
// Bearer CRON_SECRET or Bearer MIGRATIONS_READ_TOKEN (Release safety part C: a
// read-only token for callers that must not hold CRON_SECRET; CI's migration
// safety job no longer calls this route). FAIL-CLOSED: 401 when neither is set too (unlike
// /api/cron), so it is never an anonymous DB hit. An empty token never matches. A database error answers
// 503 { error: 'unreadable' } without the driver's message.

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req: Request): Promise<Response> {
  const authorization = req.headers.get('authorization');
  const accepted = [env.cronSecret, env.migrationsReadToken].filter((s) => s !== '');
  if (!accepted.some((s) => bearerMatches(authorization, s))) {
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
