import { createHash, timingSafeEqual } from 'node:crypto';

// cron-auth — the Bearer CRON_SECRET gate shared by /api/worker and /api/cron.
// Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron invocation
// (vercel.com/docs/cron-jobs/manage-cron-jobs, "Securing cron jobs"); the
// GitHub heartbeat and the after() poke send the same header.
//
// The compare is CONSTANT-TIME over fixed-length SHA-256 digests: a plain
// `!==` short-circuits at the first differing byte, so response timing leaks
// both the secret's length and how many leading bytes an attacker has right.
// Hashing first makes the two operands always 32 bytes, so timingSafeEqual
// never throws on a length mismatch and the length itself is not observable.

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * True only for an exact `Bearer <secret>` header. Fail-closed: a missing
 * header, an empty secret, a bare token, a prefix, a suffix or a case change
 * is refused. Callers gate on `env.cronSecret` being configured first.
 */
export function bearerMatches(authorization: string | null | undefined, secret: string): boolean {
  if (!secret) return false;
  return timingSafeEqual(digest(authorization ?? ''), digest(`Bearer ${secret}`));
}
