import { etDateKey, ordinal, rewardReceiptLine } from './engine';
import { settingWithinLimits } from './settings';
import type { RedemptionRow } from '@/db/repos/reward-repo';
import type { Catalog, PartnerRewardSettings } from './types';

// B3 rewards v1: the portal "My rewards" card (pure). The customer sees ONLY
// the rewards that are on: available in the admin catalog, turned on by the
// partner, inside the catalog's CURRENT limits and, for a festival, not ended.
// The page shows the card only while rewards are active for the sender
// (resolver.ts rewardsActive: demo mode AND the rewards.enabled switch).

const DAY_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : DAY_LABEL.format(d);
}

/** The offers the customer can still get, festival first (the engine's order). */
export function currentOfferLines(catalog: Catalog, settings: PartnerRewardSettings, now: Date, fmt: (usd: number) => string): string[] {
  const lines: string[] = [];
  const today = etDateKey(now);
  const f = settings.festival;
  const fc = catalog.festival;
  if (f?.enabled && fc.available && settingWithinLimits(f, fc) && f.endsOn && f.endsOn >= today) {
    const min = f.minAmountUsd ?? 0;
    const which = min > 0 ? `transfers of ${fmt(min)} or more` : 'any transfer';
    lines.push(`${f.festivalName} offer, ${dayLabel(f.startsOn ?? '')} to ${dayLabel(f.endsOn)}: no fee on ${which} (up to ${fmt(fc.maxDiscountUsd)} off).`);
  }
  const n = settings.nth_transfer;
  const nc = catalog.nth_transfer;
  if (n?.enabled && nc.available && settingWithinLimits(n, nc) && typeof n.nth === 'number') {
    lines.push(`Every ${ordinal(n.nth)} transfer you send in a month has no fee (up to ${fmt(nc.maxDiscountUsd)} off).`);
  }
  return lines;
}

/** The customer's kept rewards (a cancelled, expired or refunded transfer gave its reward back). */
export function customerRewardLines(
  rows: ReadonlyArray<RedemptionRow & { released: boolean }>,
  fmt: (usd: number) => string,
): Array<{ transferId: string; text: string }> {
  return rows.filter((r) => !r.released).map((r) => ({ transferId: r.transferId, text: rewardReceiptLine(r, fmt) }));
}

/**
 * A USD reward amount in the currency the customer pays in, at the transfer's
 * own source/USD ratio (1 for USD, or when the ratio is unknown), in cents.
 */
export function usdToSource(usd: number, currency: string, amountSource: number | undefined, amountUsd: number): number {
  const ratio = currency !== 'USD' && amountSource && amountUsd > 0 ? amountSource / amountUsd : 1;
  return Math.round(usd * ratio * 100) / 100;
}
