import { PLATFORM_SEND_LIMITS } from './send-limits';
import type { Customer, Tier, CapEvaluation, SendLimits } from './types';

// Program fix 16: the platform ladder lives in send-limits.ts (one source of
// truth, no env override). These two constants are kept for the display sites
// and tests that read the PLATFORM figures; a mint is evaluated against the
// RESOLVED limits passed to evaluateCap (min(partner, platform) in fix 16).
export const T0_DAILY_CAP_CENTS = PLATFORM_SEND_LIMITS.t0DailyCapCents;  // $500.00
export const T1_DAILY_CAP_CENTS = PLATFORM_SEND_LIMITS.t1DailyCapCents;  // $2,999.00
export const OBSERVATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * @param kycGateActive whether the owning partner enforces verify-before-send
 * (resolveKycMode). When the gate is OFF, an unverified customer past the
 * 3-day window graduates to T1 instead of being suspended — suspension for
 * "never verified" only makes sense where verification is required at all.
 * A REJECTED verification stays Suspended in both cases (it's a compliance
 * outcome, not a missing step).
 */
export function deriveTier(customer: CapSubject, now: Date, kycGateActive = true): Tier {
  if (customer.kycStatus === 'rejected') return 'Suspended';
  const ageMs = now.getTime() - new Date(customer.firstSeenAt).getTime();
  const inWindow = ageMs < OBSERVATION_WINDOW_MS;
  if (inWindow) return 'T0';
  if (customer.kycStatus === 'verified' || customer.kycStatus === 'grandfathered') return 'T1';
  return kycGateActive ? 'Suspended' : 'T1';
}

/**
 * The two customer fields the tier ladder reads. createTransfer's in-lock cap
 * check evaluates a `store.capSubject(...)` (firstSeenAt from the customers row,
 * else the first transfer, else now; kycStatus = the caller's attestation), so
 * the parameter is the projection rather than a full Customer.
 */
export type CapSubject = Pick<Customer, 'firstSeenAt' | 'kycStatus'>;

/**
 * @param kycGateActive whether the owning partner enforces verify-before-send.
 * @param limits the RESOLVED send limits for this sender (send-limits.ts
 *   resolveSendLimits(partner)). Required (fix 16) so every caller states which
 *   ladder it evaluates against; the per-transfer cap is a SEPARATE ceiling,
 *   min(limits.perTransferCapCents, the tier's daily cap).
 */
export function evaluateCap(
  customer: CapSubject,
  now: Date,
  todayUsedCents: number,
  requestedCents: number,
  kycGateActive: boolean,
  limits: SendLimits,
): CapEvaluation {
  const tier = deriveTier(customer, now, kycGateActive);
  const dailyCapCents =
    tier === 'T0' ? limits.t0DailyCapCents :
    tier === 'T1' ? limits.t1DailyCapCents :
    0;
  const perTransferCapCents = Math.min(limits.perTransferCapCents, dailyCapCents);
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

export const EDD_THRESHOLD_CENTS = 300_000;   // $3,000 USD-equivalent

export interface EddEvaluation {
  eddRequired: boolean;          // cumulative-month + requested >= $3,000
  monthUsedCents: number;
  requestedCents: number;
  thresholdCents: number;        // EDD_THRESHOLD_CENTS (surfaced for messaging)
}

// Cumulative trigger: does this send push the rolling-month total to/over $3k?
// `>=` so a send landing exactly on $3,000 trips EDD (regulatory threshold is inclusive).
export function evaluateEdd(
  monthUsedCents: number,
  requestedCents: number,
): EddEvaluation {
  const month = Number(monthUsedCents) || 0;      // defensive (untrusted/coerced)
  const requested = Number(requestedCents) || 0;
  const eddRequired = month + requested >= EDD_THRESHOLD_CENTS;
  return { eddRequired, monthUsedCents: month, requestedCents: requested, thresholdCents: EDD_THRESHOLD_CENTS };
}

// At create time: if EDD is required AND the EDD profile fields are absent,
// the transfer is FLAGGED (never blocked). Returns the reason to merge.
export function evaluateEddForTransfer(input: {
  monthUsedCents: number;
  requestedCents: number;
  eddFieldsPresent: boolean;     // sourceOfFunds && occupation both set
}): { eddRequired: boolean; flagReason?: 'edd_required' } {
  const { eddRequired } = evaluateEdd(input.monthUsedCents, input.requestedCents);
  if (eddRequired && !input.eddFieldsPresent) return { eddRequired, flagReason: 'edd_required' };
  return { eddRequired };
}
