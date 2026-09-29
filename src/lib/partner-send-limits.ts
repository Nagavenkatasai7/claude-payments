import {
  PLATFORM_SEND_LIMITS,
  livePartnerLevel,
  partnerSetBound,
  validateSendLimitInput,
  type SendLimitForm,
} from './send-limits';
import type { PartnerSendLimits, SendLimitOverride } from './types';

// partner-send-limits (UI redesign M3-12, SPEC §3.4): the PURE rules for a partner admin's
// per-customer send limit. A partner may set a customer's per-transfer / daily cap only AT OR
// BELOW the platform ladder and any live SmartRemit partner-level limit (the customer override
// wins over the partner level at resolve time, so clamping to the platform alone would let a
// partner escape a SmartRemit tightening). A partner never overwrites or clears a live SmartRemit
// override. The resolver re-applies the same bound at read (send-limits.ts partnerSetBound).

type Caps = { perTransferCapCents?: number; t1DailyCapCents?: number };

/** Clamp each named field DOWN to the platform ladder and any live SmartRemit partner-level value. */
export function clampToPlatform(v: Caps, partner: { sendLimits?: PartnerSendLimits } | null, now: Date): Caps {
  const p = livePartnerLevel(partner, now);
  const out: Caps = {};
  if (v.perTransferCapCents !== undefined) {
    out.perTransferCapCents = Math.min(
      v.perTransferCapCents,
      partnerSetBound(p?.perTransferCapCents, PLATFORM_SEND_LIMITS.perTransferCapCents).value,
    );
  }
  if (v.t1DailyCapCents !== undefined) {
    out.t1DailyCapCents = Math.min(v.t1DailyCapCents, partnerSetBound(p?.t1DailyCapCents, PLATFORM_SEND_LIMITS.t1DailyCapCents).value);
  }
  return out;
}

/**
 * A LIVE override not marked 'partner' is a SmartRemit decision (every pre-M3-12 override is a
 * platform raise): the partner may not overwrite or clear it. An expired one lapses at read, so
 * it may be replaced. An unparseable expiry counts as live (fails closed).
 */
export function partnerMayWriteOverride(current: SendLimitOverride | null | undefined, now: Date): boolean {
  if (!current || typeof current !== 'object') return true;
  const t = typeof current.expiresAt === 'string' ? Date.parse(current.expiresAt) : NaN;
  const live = !(Number.isFinite(t) && t <= now.getTime());
  return !live || current.setScope === 'partner';
}

export interface ValidatedPartnerCustomerLimit {
  /** The clamped caps + expiry to store (the action adds setBy/setAt/setScope), or null on clear. */
  value: (Caps & { expiresAt?: string }) | null;
  reason: string;
  expiresAt?: string;
  /** True when any posted figure was lowered to a platform / partner-level bound. */
  clamped: boolean;
}

/**
 * The partner form's edge check: validateSendLimitInput (reason required FIRST, whole USD in
 * [1, $10,000], a future expiry only; send-limits.ts) then clampToPlatform. T0 is never accepted:
 * a customer override never carries it (the tier gate is never changed per customer), so a posted
 * T0 figure is dropped before validation. Throws on invalid input, before any read or write.
 */
export function validatePartnerCustomerLimit(
  form: SendLimitForm,
  partner: { sendLimits?: PartnerSendLimits } | null,
  now: Date,
): ValidatedPartnerCustomerLimit {
  const v = validateSendLimitInput({ ...form, t0DailyUsd: '' }, now);
  if (v.value === null) return { value: null, reason: v.reason, clamped: false };
  const posted: Caps = {};
  if (v.value.perTransferCapCents !== undefined) posted.perTransferCapCents = v.value.perTransferCapCents;
  if (v.value.t1DailyCapCents !== undefined) posted.t1DailyCapCents = v.value.t1DailyCapCents;
  const caps = clampToPlatform(posted, partner, now);
  const clamped = caps.perTransferCapCents !== posted.perTransferCapCents || caps.t1DailyCapCents !== posted.t1DailyCapCents;
  const value: Caps & { expiresAt?: string } = { ...caps };
  if (v.expiresAt) value.expiresAt = v.expiresAt;
  return { value, reason: v.reason, expiresAt: v.expiresAt, clamped };
}
