import { easternDate } from './dates';
import type { Transfer, Schedule } from './types';

export const ABANDONED_THRESHOLD_MS = 30 * 60 * 1000;

export function isAbandoned(transfer: Transfer, now: number): boolean {
  return (
    transfer.status === 'awaiting_payment' &&
    now - Date.parse(transfer.createdAt) > ABANDONED_THRESHOLD_MS
  );
}

export function needsAttention(transfer: Transfer, now: number): boolean {
  if (transfer.complianceStatus === 'flagged') return true;
  if (transfer.complianceStatus === 'blocked') return true;
  return isAbandoned(transfer, now);
}

export interface DashboardSummary {
  commissionToday: number;
  volumeToday: number;
  countToday: number;
  needsAttention: number;
  commissionAllTime: number;
  flaggedToday: number;
}

export function summarize(transfers: Transfer[], now: number): DashboardSummary {
  const todayStr = easternDate(now);

  let commissionToday = 0;
  let volumeToday = 0;
  let countToday = 0;
  let needsAttentionCount = 0;
  let commissionAllTime = 0;
  let flaggedToday = 0;

  for (const t of transfers) {
    const isToday = easternDate(Date.parse(t.createdAt)) === todayStr;

    if (isToday) {
      countToday += 1;
      volumeToday += t.amountUsd;
      if (t.status === 'paid' || t.status === 'delivered') {
        commissionToday += t.feeUsd;
      }
      if (t.complianceStatus === 'flagged' || t.complianceStatus === 'blocked') {
        flaggedToday += 1;
      }
    }

    if (t.status === 'paid' || t.status === 'delivered') {
      commissionAllTime += t.feeUsd;
    }

    if (needsAttention(t, now)) {
      needsAttentionCount += 1;
    }
  }

  return {
    commissionToday: Math.round(commissionToday * 100) / 100,
    volumeToday: Math.round(volumeToday * 100) / 100,
    countToday,
    needsAttention: needsAttentionCount,
    commissionAllTime: Math.round(commissionAllTime * 100) / 100,
    flaggedToday,
  };
}

function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function nextDueAt(schedule: Schedule, now: number): number {
  const ref = new Date(now);
  const todayStart = startOfDay(now);

  if (schedule.frequency === 'monthly') {
    const dom = schedule.dayOfMonth ?? 1;
    const d = new Date(ref.getFullYear(), ref.getMonth(), dom);
    if (d.getTime() < todayStart) {
      d.setMonth(d.getMonth() + 1);
    }
    return d.getTime();
  }

  // weekly
  const today = new Date(todayStart);
  const targetDow = schedule.dayOfWeek ?? 0;
  let daysUntil = (targetDow - today.getDay() + 7) % 7;
  if (daysUntil === 0 && schedule.lastRunAt) {
    if (isSameDay(new Date(schedule.lastRunAt), today)) {
      daysUntil = 7;
    }
  }
  const next = new Date(today);
  next.setDate(today.getDate() + daysUntil);
  return next.getTime();
}

export function schedulesDueInRange(
  schedules: Schedule[],
  now: number,
  days: number,
): Schedule[] {
  const cutoff = now + days * 86400000;
  const todayStart = startOfDay(now);
  return schedules
    .filter((s) => s.status === 'active')
    .map((s) => ({ s, due: nextDueAt(s, now) }))
    .filter(({ due }) => due >= todayStart && due <= cutoff)
    .sort((a, b) => a.due - b.due)
    .map(({ s }) => s);
}

export function topVelocityToday(
  transfers: Transfer[],
  now: number,
  limit: number,
): { phone: string; count: number }[] {
  const today = easternDate(now);
  const counts = new Map<string, number>();
  for (const t of transfers) {
    if (easternDate(Date.parse(t.createdAt)) === today) {
      counts.set(t.phone, (counts.get(t.phone) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([phone, count]) => ({ phone, count }))
    .sort((a, b) => b.count - a.count || a.phone.localeCompare(b.phone))
    .slice(0, limit);
}
