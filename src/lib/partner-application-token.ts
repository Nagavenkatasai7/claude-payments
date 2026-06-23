import { createHash, randomBytes } from 'node:crypto';

// partner-application-token — a long-lived (30-day), single-use capability token
// for the emailed "complete your detailed application" link. Mirrors the
// onboarding-token security model (256-bit CSPRNG token; only its SHA-256 HASH is
// persisted, here on the partner_requests row, so a DB dump leaks nothing usable),
// but the link is long-lived and 1:1 with a partner_request, so the hash + expiry
// live on the DB row (not Redis). Single-use is enforced by flipping
// application_status to 'completed' on submit — a completed/expired link is dead.

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function hashApplicationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a fresh URL token + its hash (to store) + a 30-day expiry. The raw token
 * lives ONLY in the emailed link; only `hash` is persisted.
 */
export function issueApplicationToken(now: Date = new Date()): {
  token: string;
  hash: string;
  expiresAt: string;
} {
  const token = randomBytes(32).toString('hex');
  return {
    token,
    hash: hashApplicationToken(token),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };
}

/** True when the token is missing or past its expiry (treat unparseable as expired). */
export function isApplicationTokenExpired(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return true;
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) || t <= now.getTime();
}
