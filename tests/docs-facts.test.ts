// M4 PR-2: every number a guide states is sourced once in facts.ts and pinned
// here to the code constant it describes, so the docs cannot silently drift.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

function extract(file: string, re: RegExp): string {
  const m = readFileSync(file, 'utf8').match(re);
  if (!m) throw new Error(`pattern ${re} not found in ${file}`);
  return m[1];
}
const num = (s: string) => Number(s.replace(/_/g, ''));

describe('docs FACTS equal the source constants', () => {
  it('rate limit per minute (per partner and per key) and Retry-After', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    expect(FACTS.partnerRateLimitPerMin).toBe(num(extract('src/lib/partner-rate-limit.ts', /DEFAULT_LIMIT_PER_MIN = ([\d_]+)/)));
    expect(FACTS.rateLimitRetryAfterSec).toBe(num(extract('src/lib/partner-api.ts', /'Retry-After': '(\d+)'/)));
  });

  it('signature header and tolerance', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const sig = await import('@/lib/providers/rail-signature');
    expect(FACTS.signatureToleranceSec).toBe(sig.RAIL_SIG_TOLERANCE_SEC);
    expect(FACTS.signatureHeader).toBe(sig.RAIL_SIG_HEADER);
  });

  it('outbox retry budget and backoff cap', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    expect(FACTS.outboxMaxAttempts).toBe(num(extract('src/db/repos/outbox-repo.ts', /export const MAX_ATTEMPTS = ([\d_]+)/)));
    expect(FACTS.outboxBackoffCapSec).toBe(num(extract('src/db/repos/outbox-repo.ts', /Math\.min\(2 \*\* attempts, ([\d_]+)\)/)));
  });

  it('rail ack deadline (seconds) equals RAIL_TIMEOUT_MS / 1000', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const ms = num(extract('src/lib/providers/http-payment-provider.ts', /RAIL_TIMEOUT_MS = ([\d_]+)/));
    expect(FACTS.railAckTimeoutSec).toBe(ms / 1000);
  });

  it('secret rotation overlap (days) equals RAIL_SECRET_GRACE_MS', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const { RAIL_SECRET_GRACE_MS } = await import('@/lib/partner-integrations');
    expect(FACTS.secretRotationOverlapDays).toBe(RAIL_SECRET_GRACE_MS / (24 * 60 * 60 * 1000));
  });

  it('unpaid expiry (days) equals UNPAID_LINK_EXPIRY_DAYS', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    expect(FACTS.unpaidExpiryDays).toBe(num(extract('src/lib/stale-money.ts', /export const UNPAID_LINK_EXPIRY_DAYS = ([\d_]+)/)));
  });

  it('reserved Idempotency-Key prefixes equal the refusal message', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const msg = extract('src/lib/partner-api-service.ts', /"(Idempotency-Key may not begin with [^"]+)"/);
    const inMsg = [...msg.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...FACTS.reservedIdempotencyPrefixes]).toEqual(inMsg);
  });
});
