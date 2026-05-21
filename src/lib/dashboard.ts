import type { Transfer } from './types';

export const ABANDONED_THRESHOLD_MS = 30 * 60 * 1000;

export function isAbandoned(transfer: Transfer, now: number): boolean {
  return (
    transfer.status === 'awaiting_payment' &&
    now - Date.parse(transfer.createdAt) > ABANDONED_THRESHOLD_MS
  );
}

function easternDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
  });
}

export interface DashboardSummary {
  commissionToday: number;
  volumeToday: number;
  countToday: number;
  needsAttention: number;
  commissionAllTime: number;
}

export function summarize(transfers: Transfer[], now: number): DashboardSummary {
  const todayStr = easternDate(now);

  let commissionToday = 0;
  let volumeToday = 0;
  let countToday = 0;
  let needsAttention = 0;
  let commissionAllTime = 0;

  for (const t of transfers) {
    const isToday = easternDate(Date.parse(t.createdAt)) === todayStr;

    if (isToday) {
      countToday += 1;
      volumeToday += t.amountUsd;
      if (t.status === 'paid' || t.status === 'delivered') {
        commissionToday += t.feeUsd;
      }
    }

    if (t.status === 'paid' || t.status === 'delivered') {
      commissionAllTime += t.feeUsd;
    }

    if (isAbandoned(t, now)) {
      needsAttention += 1;
    }
  }

  return {
    commissionToday: Math.round(commissionToday * 100) / 100,
    volumeToday: Math.round(volumeToday * 100) / 100,
    countToday,
    needsAttention,
    commissionAllTime: Math.round(commissionAllTime * 100) / 100,
  };
}
