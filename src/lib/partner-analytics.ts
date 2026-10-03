import {
  WINDOW_DAYS,
  complianceDistribution,
  dailyCommission,
  dailyCounts,
  dailyVolume,
  fundingMethodMix,
  statusDistribution,
  topRecipientsByCount,
  transfersInWindow,
  type WindowDays,
} from './analytics';
import { maskRecipientName } from './partner-transfers';
import type { ComplianceStatus, FundingMethod, Transfer, TransferStatus } from './types';

// partner-analytics (merge plan 2d): the PURE view model behind /partner/analytics. It reuses the
// tested @/lib/analytics functions over ONE tenant's live rows (the page reads them with the session
// tenant only). Counts, USD amounts and enums only: no phone or payout destination ever enters it.
// Lost-features p3 B8: the top-recipients chart groups on the FULL name here, on the server, and
// only the shortened name ("Testname S.", the transfer list's mask) leaves this function, with its
// rank so two people with the same short name stay apart. The chart is a client component, so a
// full name in the model would reach the browser.

export const DEFAULT_ANALYTICS_WINDOW: WindowDays = 30;
/** The most rows one page view reads; a busier window is shown as a partial view with a note. */
export const ANALYTICS_ROW_CAP = 5000;

/** The page's ?window=: exactly '7', '30' or '90', else the default. */
export function parseAnalyticsWindow(raw: unknown): WindowDays {
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return DEFAULT_ANALYTICS_WINDOW;
  const n = Number(raw);
  return (WINDOW_DAYS as readonly number[]).includes(n) ? (n as WindowDays) : DEFAULT_ANALYTICS_WINDOW;
}

const HREF = '/partner/analytics';

export function analyticsHref(days: WindowDays): string {
  return days === DEFAULT_ANALYTICS_WINDOW ? HREF : `${HREF}?window=${days}`;
}

export interface PartnerAnalytics {
  windowDays: WindowDays;
  truncated: boolean;
  totals: { count: number; volumeUsd: number; commissionUsd: number };
  daily: {
    counts: { date: string; count: number }[];
    volume: { date: string; volumeUsd: number }[];
    commission: { date: string; commissionUsd: number }[];
  };
  status: { status: TransferStatus; count: number }[];
  compliance: { status: ComplianceStatus; count: number }[];
  funding: { method: FundingMethod; count: number }[];
  topRecipients: { label: string; count: number }[];
}

/** How many recipients the chart ranks (as the legacy chart). */
export const TOP_RECIPIENTS = 10;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildPartnerAnalytics(rows: readonly Transfer[], now: number, days: WindowDays, truncated: boolean): PartnerAnalytics {
  const all = [...rows];
  const inWindow = transfersInWindow(all, now, days);
  return {
    windowDays: days,
    truncated,
    totals: {
      count: inWindow.length,
      volumeUsd: round2(inWindow.reduce((s, t) => s + t.amountUsd, 0)),
      commissionUsd: round2(inWindow.filter((t) => t.status === 'paid' || t.status === 'delivered').reduce((s, t) => s + t.feeUsd, 0)),
    },
    daily: {
      counts: dailyCounts(all, now, days),
      volume: dailyVolume(all, now, days),
      commission: dailyCommission(all, now, days),
    },
    status: statusDistribution(inWindow),
    compliance: complianceDistribution(inWindow),
    funding: fundingMethodMix(inWindow),
    topRecipients: topRecipientsByCount(inWindow, TOP_RECIPIENTS).map(({ name, count }, i) => ({
      label: `${i + 1}. ${maskRecipientName(name)}`,
      count,
    })),
  };
}
