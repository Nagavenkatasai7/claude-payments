import { easternDate } from './dates';
import type {
  ComplianceStatus,
  FundingMethod,
  Transfer,
  TransferStatus,
} from './types';

export const WINDOW_DAYS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOW_DAYS)[number];

const DAY_MS = 86_400_000;

export function transfersInWindow(
  transfers: Transfer[],
  now: number,
  days: number,
): Transfer[] {
  const cutoff = now - days * DAY_MS;
  return transfers.filter((t) => Date.parse(t.createdAt) >= cutoff);
}

function buildDateBuckets(now: number, days: number): string[] {
  // Anchor to today's Eastern calendar date, then walk back by whole calendar days.
  // Using UTC noon (12:00) as the representative instant for each day ensures the
  // Eastern date is unambiguous regardless of DST offset (±4 h / ±5 h from UTC is
  // well inside ±12 h), preventing DST spring-forward from silently dropping a day
  // and DST fall-back from producing a duplicate bucket.
  const todayEt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    .format(new Date(now)); // 'YYYY-MM-DD'
  const [Y, M, D] = todayEt.split('-').map(Number);

  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const noonUtcMs = Date.UTC(Y, M - 1, D - i, 12, 0, 0);
    dates.push(easternDate(noonUtcMs));
  }
  return dates;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function dailyCounts(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; count: number }[] {
  const dates = buildDateBuckets(now, days);
  const counts = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const t of transfersInWindow(transfers, now, days)) {
    const d = easternDate(Date.parse(t.createdAt));
    if (counts.has(d)) counts.set(d, counts.get(d)! + 1);
  }
  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

export function dailyVolume(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; volumeUsd: number }[] {
  const dates = buildDateBuckets(now, days);
  const volume = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const t of transfersInWindow(transfers, now, days)) {
    const d = easternDate(Date.parse(t.createdAt));
    if (volume.has(d)) volume.set(d, volume.get(d)! + t.amountUsd);
  }
  return dates.map((date) => ({
    date,
    volumeUsd: round2(volume.get(date) ?? 0),
  }));
}

export function dailyCommission(
  transfers: Transfer[],
  now: number,
  days: number,
): { date: string; commissionUsd: number }[] {
  const dates = buildDateBuckets(now, days);
  const commission = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const t of transfersInWindow(transfers, now, days)) {
    if (t.status !== 'paid' && t.status !== 'delivered') continue;
    const d = easternDate(Date.parse(t.createdAt));
    if (commission.has(d)) commission.set(d, commission.get(d)! + t.feeUsd);
  }
  return dates.map((date) => ({
    date,
    commissionUsd: round2(commission.get(date) ?? 0),
  }));
}

export function statusDistribution(
  transfers: Transfer[],
): { status: TransferStatus; count: number }[] {
  const counts = new Map<TransferStatus, number>();
  for (const t of transfers) {
    counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}

export function complianceDistribution(
  transfers: Transfer[],
): { status: ComplianceStatus; count: number }[] {
  const counts = new Map<ComplianceStatus, number>();
  for (const t of transfers) {
    counts.set(t.complianceStatus, (counts.get(t.complianceStatus) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([status, count]) => ({ status, count }))
    // `?? ''` defends against legacy transfers whose complianceStatus was never
    // set, which become an undefined map key and then an undefined sort field.
    .sort((a, b) => b.count - a.count || (a.status ?? '').localeCompare(b.status ?? ''));
}

export function fundingMethodMix(
  transfers: Transfer[],
): { method: FundingMethod; count: number }[] {
  const counts = new Map<FundingMethod, number>();
  for (const t of transfers) {
    counts.set(t.fundingMethod, (counts.get(t.fundingMethod) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([method, count]) => ({ method, count }))
    // Same defensive coercion as statusDistribution — legacy transfers may
    // be missing fundingMethod, which would throw under sort.
    .sort((a, b) => b.count - a.count || (a.method ?? '').localeCompare(b.method ?? ''));
}

export function topRecipientsByCount(
  transfers: Transfer[],
  limit: number,
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of transfers) {
    counts.set(t.recipientName, (counts.get(t.recipientName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    // `?? ''` mirrors the defensive coercion in store.listTransfers — legacy
    // transfers may carry an undefined `recipientName`, which becomes the map
    // key here and then the sort `name`. See store-listTransfers-legacy.test.
    .sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''))
    .slice(0, limit);
}
