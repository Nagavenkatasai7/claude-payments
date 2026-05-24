import type { Customer, Tier, CapEvaluation } from './types';

export const T0_DAILY_CAP_CENTS = 50_000;   // $500.00
export const T1_DAILY_CAP_CENTS = 299_900;  // $2,999.00
export const OBSERVATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export function deriveTier(customer: Customer, now: Date): Tier {
  if (customer.kycStatus === 'rejected') return 'Suspended';
  const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
  const inWindow = ageMs < OBSERVATION_WINDOW_MS;
  if (inWindow) return 'T0';
  if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'T1';
  return 'Suspended';
}

export function evaluateCap(
  customer: Customer,
  now: Date,
  todayUsedCents: number,
  requestedCents: number,
): CapEvaluation {
  const tier = deriveTier(customer, now);
  const dailyCapCents =
    tier === 'T0' ? T0_DAILY_CAP_CENTS :
    tier === 'T1' ? T1_DAILY_CAP_CENTS :
    0;
  const perTransferCapCents = dailyCapCents;
  const todayRemainingCents = Math.max(0, dailyCapCents - todayUsedCents);

  let dayOfWindow: number | undefined;
  if (tier === 'T0') {
    const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
    dayOfWindow = Math.min(3, Math.floor(ageMs / (24 * 60 * 60 * 1000)) + 1);
  }

  const base = {
    tier,
    dailyCapCents,
    perTransferCapCents,
    todayUsedCents,
    todayRemainingCents,
    dayOfWindow,
  };

  if (tier === 'Suspended') {
    const reason = customer.kycStatus === 'rejected'
      ? 'verification_rejected' as const
      : 'verification_required_after_window' as const;
    return { ...base, withinCap: false, reason };
  }
  if (requestedCents > perTransferCapCents) {
    return { ...base, withinCap: false, reason: 'over_per_transfer_cap' };
  }
  if (requestedCents > todayRemainingCents) {
    return { ...base, withinCap: false, reason: 'over_daily_cap' };
  }
  return { ...base, withinCap: true };
}
