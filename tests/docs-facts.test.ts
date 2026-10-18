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
    expect(FACTS.outboxBackoffCapSec).toBe(num(extract('src/db/repos/outbox-repo.ts', /export const BACKOFF_CAP_SEC = ([\d_]+)/)));
  });

  it('settlement instruction retry budget and backoff cap (about a day)', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    expect(FACTS.instructMaxAttempts).toBe(num(extract('src/db/repos/outbox-repo.ts', /export const INSTRUCT_MAX_ATTEMPTS = ([\d_]+)/)));
    expect(FACTS.instructBackoffCapSec).toBe(num(extract('src/db/repos/outbox-repo.ts', /export const INSTRUCT_BACKOFF_CAP_SEC = ([\d_]+)/)));
  });

  it('rail ack deadline (seconds) equals RAIL_TIMEOUT_MS / 1000', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const ms = num(extract('src/lib/providers/http-payment-provider.ts', /RAIL_TIMEOUT_MS = ([\d_]+)/));
    expect(FACTS.railAckTimeoutSec).toBe(ms / 1000);
  });

  it('settlement endpoint limits: ack size, redirects, providerRef length, failure reason length', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const sf = await import('@/lib/safe-fetch');
    const hp = await import('@/lib/providers/http-payment-provider');
    expect(FACTS.ackMaxKb).toBe(sf.MAX_ACK_BYTES / 1024);
    expect(FACTS.maxRedirects).toBe(sf.MAX_REDIRECTS);
    expect(FACTS.providerRefMaxChars).toBe(num(extract('src/lib/settlement-url.ts', /\/\^\[A-Za-z0-9\._:-\]\{1,(\d+)\}\$\//)));
    expect(FACTS.failureReasonMaxChars).toBe(hp.RAIL_FAILURE_REASON_MAX);
  });

  it('new-sender observation window (days) equals OBSERVATION_WINDOW_MS', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const { OBSERVATION_WINDOW_MS } = await import('@/lib/tier-rules');
    expect(FACTS.newSenderObservationDays).toBe(OBSERVATION_WINDOW_MS / (24 * 60 * 60 * 1000));
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

  it('AI apps (MCP): quote lock, per-connection limits, body cap, list sizes', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const { RATE_LOCK_MINUTES } = await import('@/lib/tools');
    const { MCP_GRANT_LIMITS } = await import('@/lib/mcp/guard');
    const { MCP_MAX_BODY_BYTES } = await import('@/lib/mcp/http');
    const { MCP_RECIPIENTS_MAX } = await import('@/lib/mcp/tools');
    expect(FACTS.rateLockMinutes).toBe(RATE_LOCK_MINUTES);
    expect(FACTS.mcpGrantCallsPerMin).toBe(MCP_GRANT_LIMITS.find((w) => w.scope === 'mcp-grant-min')?.limit);
    expect(FACTS.mcpGrantCallsPerHour).toBe(MCP_GRANT_LIMITS.find((w) => w.scope === 'mcp-grant-hour')?.limit);
    expect(FACTS.mcpMaxBodyKb).toBe(MCP_MAX_BODY_BYTES / 1024);
    expect(FACTS.mcpRecipientsMax).toBe(MCP_RECIPIENTS_MAX);
    expect(FACTS.mcpRecentTransfersMax).toBe(num(extract('src/lib/mcp/tools.ts', /limit: z\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/)));
  });

  it('AI apps (MCP) sign-in: step-up window, connection lifetime, code and access-token lifetimes', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const { PORTAL_SESSION_POLICY } = await import('@/lib/portal-session-cookie');
    const cfg = await import('@/lib/agent-auth/config');
    expect(FACTS.agentStepUpMinutes).toBe(PORTAL_SESSION_POLICY.stepUpFreshMs / 60_000);
    expect(FACTS.agentGrantDays).toBe(cfg.AGENT_GRANT_TTL_MS / 86_400_000);
    expect(FACTS.agentCodeTtlSec).toBe(cfg.AGENT_CODE_TTL_SEC);
    expect(FACTS.agentAccessTokenMinutes).toBe(cfg.AGENT_ACCESS_TTL_SEC / 60);
  });

  it('AI apps (MCP) prepare: the retry window and the hourly prepare budget', async () => {
    const { FACTS } = await import('@/content/docs/facts');
    const { MCP_PREPARE_LIMIT, PREPARE_REPLAY_TTL_S } = await import('@/lib/mcp/prepare');
    expect(FACTS.mcpPrepareReplaySec).toBe(PREPARE_REPLAY_TTL_S);
    expect(FACTS.mcpPreparePerHour).toBe(MCP_PREPARE_LIMIT.limit);
    expect(MCP_PREPARE_LIMIT.windowSec).toBe(3600);
  });
});
