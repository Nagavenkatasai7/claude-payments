'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { liveTickAction } from '@/lib/live-refresh-policy';
import { LIVE_POLL_MS, liveAutoRefreshAllowed, livePathActive } from '@/lib/partner-live';

/** Any of these counts as the viewer being present. */
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;

/**
 * Lost-features A15: /partner list pages refresh by themselves. Every 30 s a visible tab on a list
 * page (partner-live.ts) asks GET /partner/live for an opaque stamp and re-renders when it moves;
 * every 12th tick is a full refresh, the safety net for changes the stamp cannot see. Hidden tabs do
 * nothing (one catch-up render on return), and polling pauses after 15 minutes without input until
 * the viewer resumes (live-refresh-policy.ts, shared with the legacy dashboard).
 *
 * Idle sign-out (review 2.13): the poll never refreshes the session, and a re-render (which does)
 * runs only while the viewer was active in the last minute. A change seen while they are away waits
 * for their next input. A 401 (signed out, or no longer allowed) pauses; resuming re-renders, which
 * sends a signed-out viewer to sign in.
 */
export function PartnerLiveRefresh() {
  const router = useRouter();
  const pathname = usePathname();
  const active = livePathActive(pathname);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!active || paused) return;
    let last: string | null = null;
    let ticks = 0;
    let inFlight = false;
    let waiting = false; // a change arrived while the viewer was away
    let lastInputAt = Date.now();
    const refresh = () => {
      waiting = false;
      router.refresh();
    };
    const onInput = () => {
      lastInputAt = Date.now();
      if (waiting) refresh();
    };
    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true });
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      lastInputAt = Date.now(); // returning to the tab is activity
      last = null; // re-baseline after the catch-up render
      refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const timer = setInterval(async () => {
      const now = Date.now();
      const action = liveTickAction({ hidden: document.visibilityState === 'hidden', now, lastInputAt, tick: ticks + 1 });
      if (action === 'skip') return;
      if (action === 'pause') {
        setPaused(true);
        return;
      }
      ticks++;
      if (action === 'refresh' && liveAutoRefreshAllowed(now, lastInputAt)) {
        refresh();
        return;
      }
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch('/partner/live', { cache: 'no-store', redirect: 'manual' });
        if (res.status === 401) {
          setPaused(true);
          return;
        }
        if (!res.ok) return;
        const { stamp } = (await res.json()) as { stamp?: unknown };
        if (typeof stamp !== 'string') return;
        if (last !== null && stamp !== last) {
          if (liveAutoRefreshAllowed(Date.now(), lastInputAt)) refresh();
          else waiting = true;
        }
        last = stamp;
      } catch {
        /* offline tick: the next one retries */
      } finally {
        inFlight = false;
      }
    }, LIVE_POLL_MS);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
    };
  }, [router, active, paused]);

  if (!active) return null;
  if (paused) {
    return (
      <button
        type="button"
        onClick={() => {
          setPaused(false);
          router.refresh();
        }}
        title={t('partner.live.pausedTitle')}
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-ds-inner px-2 text-[12.5px] font-semibold text-ds-ink-muted hover:text-ds-ink"
      >
        <span aria-hidden="true" className="size-[7px] rounded-full bg-ds-ink-subtle" />
        <span>{t('partner.live.paused')}</span>
        <span className="sr-only">{t('partner.live.resume')}</span>
      </button>
    );
  }
  return (
    <span title={t('partner.live.title')} data-live="on" className="inline-flex shrink-0 items-center gap-1.5 px-2 text-[12.5px] font-semibold text-ds-success-ink">
      <span aria-hidden="true" className="size-[7px] rounded-full bg-ds-success-ink motion-safe:animate-pulse" />
      {t('partner.live.on')}
    </span>
  );
}
