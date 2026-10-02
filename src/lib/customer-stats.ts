// customer-stats — the customer home's "Sent this month" maths, shared by the legacy /account home
// and the customer portal home (one customer portal, Oct 2). Moved unchanged from
// src/app/account/page.tsx so both homes show the same number. Pure: no I/O.
import { easternMonth } from '@/lib/dates';
import type { Transfer } from '@/lib/types';

/**
 * USD-equivalent amount of a transfer, for the cross-currency monthly trend.
 * Only money that actually left the customer counts toward "sent" — pending,
 * cancelled, blocked, and awaiting-payment transfers are excluded so the
 * "Sent this month" total never inflates beyond what was really sent.
 */
export function sentUsd(t: Transfer): number {
  if (t.status !== 'paid' && t.status !== 'delivered') return 0;
  return t.amountUsd ?? t.amountSource ?? 0;
}

/**
 * Last 6 calendar months of send volume (USD-equiv), oldest → newest. Buckets
 * by EASTERN month (easternMonth) — the same basis as the admin analytics — so
 * a late-evening send near a month boundary lands in the same month everywhere.
 */
export function monthlyBuckets(
  transfers: Transfer[],
  now: Date,
): { key: string; month: string; volumeUsd: number }[] {
  // The keys are Eastern months counted back from NOW's Eastern month, by integer arithmetic. (The
  // version moved from /account built them from the server's local month start, which on a UTC
  // server is still the PREVIOUS month in Eastern time: every bucket was one month behind its label,
  // so "Sent this month" showed last month's total.)
  const [y, m] = easternMonth(now.getTime()).split('-').map(Number);
  const buckets: { key: string; month: string; volumeUsd: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const mid = new Date(Date.UTC(y, m - 1 - i, 15)); // mid-month: safely inside that month in any zone
    buckets.push({
      key: `${mid.getUTCFullYear()}-${String(mid.getUTCMonth() + 1).padStart(2, '0')}`,
      month: mid.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }),
      volumeUsd: 0,
    });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const t of transfers) {
    const bucket = byKey.get(easternMonth(Date.parse(t.createdAt)));
    if (bucket) bucket.volumeUsd += sentUsd(t);
  }
  return buckets.map((b) => ({ ...b, volumeUsd: Math.round(b.volumeUsd * 100) / 100 }));
}

/** The current month's sent total: the newest bucket (no second scan). */
export function sentThisMonthUsd(transfers: Transfer[], now: Date): number {
  const buckets = monthlyBuckets(transfers, now);
  return buckets[buckets.length - 1].volumeUsd;
}
