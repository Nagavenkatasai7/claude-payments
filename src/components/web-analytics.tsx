'use client';

// Vercel Web Analytics (page views, no cookies) for every host the root layout
// serves: smartremit.ai, send.smartremit.ai and the partner subdomains. A client
// wrapper because beforeSend is a function, and a server layout cannot pass a
// function to a client component. Same-origin only (/_vercel/insights/script.js,
// node_modules/@vercel/analytics/dist/next/index.mjs:94), so the enforced
// CSP's 'self' covers it; `next dev` loads a debug script from
// va.vercel-scripts.com instead, which the CSP blocks (dev only). Nothing is
// sent until Web Analytics is enabled on the Vercel project.
import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next';
import { redactAnalyticsUrl } from '@/lib/web-analytics-url';

function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = redactAnalyticsUrl(event.url);
  return url ? { ...event, url } : null;
}

export function WebAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}
