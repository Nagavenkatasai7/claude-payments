// partner-live (lost-features A15): the pure rules behind /partner live refresh. The client polls
// GET /partner/live, which answers an opaque stamp; when it moves, the page re-renders.
//   - 30 s polls, visible tabs only, list pages only (a half-typed form never re-renders under the
//     user), and polling stops after 15 min without input (live-refresh-policy.ts).
//   - The poll reads the session WITHOUT refreshing it (auth-store peekSessionUser). A re-render is
//     a full request that does refresh it, so an automatic re-render runs only while the viewer was
//     active in the last minute (the store's own lastSeen granularity). A change seen while the
//     viewer is away waits for their next input. Live refresh therefore never extends the 30-minute
//     idle sign-out.
//   - The stamp covers only what the role may see: support never gets a money part, finance never a
//     ticket part. No figure leaves the server; the client only compares the string.
//
// Client-safe (the refresher imports it). The stamp itself is partner-live-stamp.ts (server only).

export const LIVE_POLL_MS = 30_000;
/** An automatic re-render needs viewer input within this window. */
export const LIVE_ACTIVE_MS = 60_000;

const LIVE_PATHS: ReadonlySet<string> = new Set([
  '/partner',
  '/partner/transfers',
  '/partner/support',
  '/partner/reviews',
  '/partner/refunds',
]);

/** True on the list pages that poll (exact match). */
export function livePathActive(pathname: string | null | undefined): boolean {
  return typeof pathname === 'string' && LIVE_PATHS.has(pathname);
}

/** True when an automatic re-render may run now (the viewer was active within LIVE_ACTIVE_MS). */
export function liveAutoRefreshAllowed(now: number, lastInputAt: number): boolean {
  return now - lastInputAt <= LIVE_ACTIVE_MS;
}
