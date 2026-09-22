import { versionBody } from '@/lib/deploy-version';

// GET /api/version → { sha: '<7-char commit sha>' | 'unknown' }
//
// Anonymous by design: the post-deploy smoke (.github/workflows/smoke.yml)
// polls it until the Rolling Release serves the new build on every request.
// Not under the middleware matcher (/account, /admin-dashboard only) and not
// behind a per-IP limiter. It exposes the short SHA and nothing else.
//
// Forced dynamic + no-store: the SHA is read per request from the running
// deployment's environment, so neither a build-time prerender nor any cache
// can answer with another deployment's value.

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json(versionBody(process.env.VERCEL_GIT_COMMIT_SHA), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
