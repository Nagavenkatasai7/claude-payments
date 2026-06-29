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
  // Parse today's Eastern calendar components and use local (wall-clock) arithmetic
  // to decrement by integer days.  Subtracting multiples of DAY_MS (86 400 000 ms)
  // in UTC-epoch land is wrong across DST transitions: the spring-forward day is only
  // 23 hours long, so "now − 1 × DAY_MS" can land on the previous date instead of
  // the spring-forward date itself, silently skipping it.
  const todayStr = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const [m, d, y] = todayStr.split('/').map(Number);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(y, m - 1, d - i); // local wall-clock arithmetic; Date normalises month/year rollovers
    dates.push(`${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`);
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
