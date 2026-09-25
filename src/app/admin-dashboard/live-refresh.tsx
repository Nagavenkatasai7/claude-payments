'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { liveTickAction } from '@/lib/live-refresh-policy';

/** Any of these counts as the viewer being present (resets the idle clock). */
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;

/**
 * Live updates (Stage 4: stamp-polling). Each tick fetches the cheap
 * /api/dashboard/summary aggregate and re-renders the page ONLY when its
 * change-stamp moves — a full server re-render per viewer per 5s became one
 * SQL aggregate per viewer per 5s. A slow full refresh every 60s remains as
 * the safety net for changes the stamp can't see (schedules, customers, team).
 *
 * partner-demo R4 (Neon compute): both the poll and the refresh hit Neon, so
 * a forgotten tab kept the database awake. Ticks are SKIPPED while the tab is
 * hidden (Page Visibility API: document.visibilityState and the document's
 * `visibilitychange` event — MDN, Page_Visibility_API) with one refresh on
 * becoming visible again, and polling PAUSES after 15 min without input until
 * the viewer clicks resume. The decision is src/lib/live-refresh-policy.ts.
 */
export function LiveRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return; // nothing runs while paused — no poll, no refresh
    let last: string | null = null;
    let ticks = 0;
    let inFlight = false;
    let lastInputAt = Date.now();
    const onInput = () => {
      lastInputAt = Date.now();
    };
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true });

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      // Coming back to the tab IS activity (a presenter returning from another
      // window must not land on "Paused"); idle pause still catches a visible,
      // untouched tab.
      lastInputAt = Date.now();
      last = null; // re-baseline the stamp after the catch-up render
      router.refresh(); // one catch-up render for everything missed while hidden
    };
    document.addEventListener('visibilitychange', onVisibility);

    const t = setInterval(async () => {
      const action = liveTickAction({
        hidden: document.visibilityState === 'hidden',
        now: Date.now(),
        lastInputAt,
        tick: ticks + 1,
      });
      if (action === 'skip') return;
      if (action === 'pause') {
        setPaused(true);
        return;
      }
      ticks++;
      if (action === 'refresh') {
        router.refresh(); // 60s safety net
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch('/api/dashboard/summary', { cache: 'no-store' });
        if (res.ok) {
          const { stamp } = (await res.json()) as { stamp?: string };
          if (typeof stamp === 'string') {
            if (last !== null && stamp !== last) router.refresh();
            last = stamp;
          }
        }
      } catch {
        /* offline tick — the next one retries */
      } finally {
        inFlight = false;
      }
    }, intervalMs);

    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
    };
  }, [router, intervalMs, paused]);

  if (paused) {
    return (
      <button
        type="button"
        onClick={() => {
          setPaused(false);
          router.refresh();
        }}
        title="Live updates paused after 15 minutes without activity"
        className="inline-flex items-center gap-1.5 rounded text-[11px] font-semibold text-muted-foreground hover:text-foreground"
      >
        <span className="h-[7px] w-[7px] rounded-full bg-muted-foreground/60"></span>Paused · click to resume
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-success">
      <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-[#30a46c] shadow-[0_0_0_3px_rgba(48,164,108,0.16)]"></span>Live
    </span>
  );
}
