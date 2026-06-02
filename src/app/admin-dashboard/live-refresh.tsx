'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function LiveRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return (
    <span className="sh-live">
      <span className="sh-live-dot"></span>Live
    </span>
  );
}
