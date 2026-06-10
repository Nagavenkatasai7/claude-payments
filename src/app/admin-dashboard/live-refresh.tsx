'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Live updates (Stage 4: stamp-polling). Each tick fetches the cheap
 * /api/dashboard/summary aggregate and re-renders the page ONLY when its
 * change-stamp moves — a full server re-render per viewer per 5s became one
 * SQL aggregate per viewer per 5s. A slow full refresh every 60s remains as
 * the safety net for changes the stamp can't see (schedules, customers, team).
 */
export function LiveRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    let last: string | null = null;
    let ticks = 0;
    let inFlight = false;
    const t = setInterval(async () => {
      ticks++;
      if (ticks % 12 === 0) {
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
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return (
    <span className="sh-live">
      <span className="sh-live-dot"></span>Live
    </span>
  );
}
