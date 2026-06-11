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
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-success">
      <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-[#30a46c] shadow-[0_0_0_3px_rgba(48,164,108,0.16)]"></span>Live
    </span>
  );
}
