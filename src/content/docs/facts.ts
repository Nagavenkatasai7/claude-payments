// M4 PR-2: every number a guide states, sourced here once. Guides render these
// through <Fact name="…" /> (PR-3), never as literals, and
// tests/docs-facts.test.ts pins each value to the code constant cited beside it.

export const FACTS = {
  /** src/lib/partner-rate-limit.ts DEFAULT_LIMIT_PER_MIN (per partner AND per key). */
  partnerRateLimitPerMin: 120,
  /** src/lib/partner-api.ts guardPartner: the 429 Retry-After header. */
  rateLimitRetryAfterSec: 60,
  /** src/lib/providers/rail-signature.ts RAIL_SIG_TOLERANCE_SEC. */
  signatureToleranceSec: 300,
  /** src/lib/providers/rail-signature.ts RAIL_SIG_HEADER. */
  signatureHeader: 'x-smartremit-signature',
  /** src/db/repos/outbox-repo.ts MAX_ATTEMPTS (then dead-lettered with an ops alert). */
  outboxMaxAttempts: 8,
  /** src/db/repos/outbox-repo.ts BACKOFF_CAP_SEC: 2^attempts seconds, capped at this. */
  outboxBackoffCapSec: 3600,
  /** src/db/repos/outbox-repo.ts INSTRUCT_MAX_ATTEMPTS (settlement instructions; then dead-lettered with an ops alert). */
  instructMaxAttempts: 56,
  /** src/db/repos/outbox-repo.ts INSTRUCT_BACKOFF_CAP_SEC (settlement instructions: about a day in total). */
  instructBackoffCapSec: 1800,
  /** src/lib/providers/http-payment-provider.ts RAIL_TIMEOUT_MS / 1000. */
  railAckTimeoutSec: 15,
  /** src/lib/safe-fetch.ts MAX_ACK_BYTES / 1024 (the settlement acknowledgement cap). */
  ackMaxKb: 64,
  /** src/lib/safe-fetch.ts MAX_REDIRECTS (same-origin 307/308 only). */
  maxRedirects: 2,
  /** src/lib/settlement-url.ts safeProviderRef: the providerRef length cap. */
  providerRefMaxChars: 128,
  /** src/lib/providers/http-payment-provider.ts RAIL_FAILURE_REASON_MAX (longer is cut). */
  failureReasonMaxChars: 200,
  /** src/lib/tier-rules.ts OBSERVATION_WINDOW_MS in days (new-sender window). */
  newSenderObservationDays: 3,
  /** src/lib/partner-integrations.ts RAIL_SECRET_GRACE_MS in days. */
  secretRotationOverlapDays: 7,
  /** src/lib/stale-money.ts UNPAID_LINK_EXPIRY_DAYS. */
  unpaidExpiryDays: 7,
  /** src/lib/partner-api-service.ts: the reserved-prefix 400 message, in order. */
  reservedIdempotencyPrefixes: ['draft:', 'b2binvoice:', 'sched:', 'test:', 'paylink:'],
  /** src/lib/tools.ts RATE_LOCK_MINUTES (the quote lock once a send starts). */
  rateLockMinutes: 30,
  /** src/lib/mcp/guard.ts MCP_GRANT_LIMITS 'mcp-grant-min'. */
  mcpGrantCallsPerMin: 60,
  /** src/lib/mcp/guard.ts MCP_GRANT_LIMITS 'mcp-grant-hour'. */
  mcpGrantCallsPerHour: 600,
  /** src/lib/mcp/http.ts MCP_MAX_BODY_BYTES / 1024. */
  mcpMaxBodyKb: 64,
  /** src/lib/mcp/tools.ts MCP_RECIPIENTS_MAX. */
  mcpRecipientsMax: 50,
  /** src/lib/mcp/tools.ts listRecentTransfersInput limit max. */
  mcpRecentTransfersMax: 10,
  /** src/lib/portal-session-cookie.ts PORTAL_SESSION_POLICY.stepUpFreshMs in minutes (AI-app consent step-up). */
  agentStepUpMinutes: 15,
  /** src/lib/agent-auth/config.ts AGENT_GRANT_TTL_MS in days (sliding on each refresh). */
  agentGrantDays: 30,
  /** src/lib/agent-auth/config.ts AGENT_CODE_TTL_SEC (single use). */
  agentCodeTtlSec: 300,
  /** src/lib/agent-auth/config.ts AGENT_ACCESS_TTL_SEC / 60. */
  agentAccessTokenMinutes: 60,
  /** src/lib/mcp/prepare.ts PREPARE_REPLAY_TTL_S (a repeated prepare_transfer returns the same draft). */
  mcpPrepareReplaySec: 120,
  /** src/lib/portal-send.ts PORTAL_SEND_LIMIT.limit (portal Send + AI-app prepares, per customer per hour). */
  portalSendPerHour: 20,
} as const;

export type FactName = keyof typeof FACTS;
