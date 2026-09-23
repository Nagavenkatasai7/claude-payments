/**
 * Program-Fix 49B: how long a send draft (its pay link and its locked quote)
 * lives. Dependency-free so both the draft store and the legal drafts (server
 * pages) can read the ONE value; the approve card's rate-lock minutes
 * (tools.ts RATE_LOCK_MINUTES) and the terms draft's "locked for up to N
 * minutes" derive from it.
 */
export const DRAFT_TTL_SECONDS = 1800; // 30 minutes
