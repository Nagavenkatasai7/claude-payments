'use client';

import { SpeedInsights } from '@vercel/speed-insights/next';
import { scrubVitalsEvent } from '@/lib/vitals-scrub';

// Vercel Speed Insights with the URL scrubber wired in. This file is the client
// boundary on purpose: the root layout is a Server Component, and a function
// prop (beforeSend) cannot be serialized across the RSC boundary
// (node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md:50).
export function SpeedInsightsScrubbed() {
  return <SpeedInsights beforeSend={scrubVitalsEvent} />;
}
