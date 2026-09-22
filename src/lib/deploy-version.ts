/**
 * Deploy identity for GET /api/version — the probe the post-deploy smoke polls
 * to know a Vercel Rolling Release has reached 100% (every response served by
 * the new build) before it tests production.
 *
 * Contract: the ONLY datum exposed is the short commit SHA the running build
 * came from. No env names, deployment id, region, or anything else. Input that
 * is not a hex commit SHA collapses to 'unknown', so this can never echo
 * arbitrary environment content.
 */

export const UNKNOWN_SHA = 'unknown';

/** Length of the short SHA; the smoke workflow cuts the event SHA the same way. */
export const SHORT_SHA_LENGTH = 7;

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

export function shortCommitSha(raw: string | undefined): string {
  const sha = (raw ?? '').trim().toLowerCase();
  if (!COMMIT_SHA.test(sha)) return UNKNOWN_SHA;
  return sha.slice(0, SHORT_SHA_LENGTH);
}

export function versionBody(raw: string | undefined): { sha: string } {
  return { sha: shortCommitSha(raw) };
}
