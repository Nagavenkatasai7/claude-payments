// live-refresh-policy — what one LiveRefresh tick does (partner-demo R4, Neon
// compute). Pure, so it is unit-tested; the component (src/app/admin-dashboard/
// live-refresh.tsx) only wires timers and DOM events to it.
//
// Each stamp poll is two Neon aggregates (/api/dashboard/summary) and each
// full refresh is a server render, so one tab left open kept the free-tier
// compute awake around the clock. Per the Page Visibility API
// (https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API, "Use
// cases": "An application showing a dashboard of information doesn't want to
// poll the server for updates when the page isn't visible"), a hidden tab does
// nothing; an idle visible tab pauses after LIVE_IDLE_PAUSE_MS.

/** No pointer/keyboard/scroll/touch input for this long ⇒ stop polling until the user resumes. */
export const LIVE_IDLE_PAUSE_MS = 15 * 60_000;
/** Every Nth tick is a full router.refresh() (12 × 5 s = the 60 s safety net). */
export const LIVE_REFRESH_EVERY_TICKS = 12;

export type LiveTickAction = 'skip' | 'pause' | 'refresh' | 'poll';

export interface LiveTickInput {
  /** document.visibilityState === 'hidden'. */
  hidden: boolean;
  now: number;
  /** Epoch ms of the last user input on the page. */
  lastInputAt: number;
  /** 1-based count of VISIBLE, active ticks (skipped ticks do not advance it). */
  tick: number;
}

export function liveTickAction({ hidden, now, lastInputAt, tick }: LiveTickInput): LiveTickAction {
  if (hidden) return 'skip';
  if (now - lastInputAt >= LIVE_IDLE_PAUSE_MS) return 'pause';
  return tick % LIVE_REFRESH_EVERY_TICKS === 0 ? 'refresh' : 'poll';
}
