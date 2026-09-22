import type { CapEvaluation, PartnerSendLimits, SendLimits } from './types';

export type { SendLimits, PartnerSendLimits, SendLimitOverride } from './types';

// send-limits (Program fix 16 / Task 10) — the platform send ladder and the
// per-partner resolver. PURE and types-only in its imports on purpose: the
// landing calculator ('use client', src/app/landing/RateCalculator.tsx) reads
// PLATFORM_SEND_LIMITS.maxUsd from here, so this module must never pull in
// fx.ts (→ rate.ts → log.ts) or anything server-side.
//
// The ladder is the one before #234: T0 $500/day for the 3-day observation
// window, T1 $2,999/day, $2,999 per transfer, MAX_USD 2999. There is NO env
// override — large-amount testing is fix 16b's audited platform-admin raise.
// In this fix a partner row can only TIGHTEN the ladder (min(partner, platform));
// fix 16b replaces resolveSendLimits with resolveEffectiveSendLimits (raises up
// to a hard ceiling, per customer, audited). Keep one call per site so that
// swap stays mechanical.

export const PLATFORM_SEND_LIMITS: Readonly<SendLimits> = Object.freeze({
  t0DailyCapCents: 50_000,      // $500.00/day during the 3-day observation window
  t1DailyCapCents: 299_900,     // $2,999.00/day once verified and past the window
  perTransferCapCents: 299_900, // $2,999.00 per transfer
  maxUsd: 2999,                 // the quote ceiling (fx.ts MAX_USD is pinned to this)
});

/** A stored override value counts only when it is a positive integer number of cents. */
function validCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/** min(stored, platform) — a partner row can only tighten; garbage ⇒ platform. */
function tighten(stored: unknown, platform: number): number {
  const v = validCents(stored);
  return v === null ? platform : Math.min(v, platform);
}

/**
 * Resolve the send limits that apply to a partner's customers. Absent row,
 * absent/garbage override, or an override past its `expiresAt` ⇒ the platform
 * ladder. Every field is clamped to be <= the platform value. `maxUsd` follows
 * the resolved per-transfer cap (a $1,000 per-transfer partner quotes at most
 * $1,000), never above the platform ceiling.
 */
export function resolveSendLimits(
  partner: { sendLimits?: PartnerSendLimits } | null | undefined,
  now: Date = new Date(),
): SendLimits {
  const raw = partner?.sendLimits;
  const override: PartnerSendLimits =
    raw && typeof raw === 'object' && !isExpired(raw.expiresAt, now) ? raw : {};
  const perTransferCapCents = tighten(override.perTransferCapCents, PLATFORM_SEND_LIMITS.perTransferCapCents);
  return {
    t0DailyCapCents: tighten(override.t0DailyCapCents, PLATFORM_SEND_LIMITS.t0DailyCapCents),
    t1DailyCapCents: tighten(override.t1DailyCapCents, PLATFORM_SEND_LIMITS.t1DailyCapCents),
    perTransferCapCents,
    maxUsd: Math.min(PLATFORM_SEND_LIMITS.maxUsd, Math.floor(perTransferCapCents / 100)),
  };
}

/** True when a RESOLVED ladder differs from the platform (an expired or garbage override does not count). */
export function isTightened(limits: SendLimits): boolean {
  return (
    limits.t0DailyCapCents !== PLATFORM_SEND_LIMITS.t0DailyCapCents ||
    limits.t1DailyCapCents !== PLATFORM_SEND_LIMITS.t1DailyCapCents ||
    limits.perTransferCapCents !== PLATFORM_SEND_LIMITS.perTransferCapCents ||
    limits.maxUsd !== PLATFORM_SEND_LIMITS.maxUsd
  );
}

function isExpired(expiresAt: unknown, now: Date): boolean {
  if (typeof expiresAt !== 'string') return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

/**
 * Thrown by createTransfer (inside the sender lock, before the insert) when
 * evaluateCap refuses. NOTHING has been written — the transaction rolled back.
 * The message is a constant; the figures live on `evaluation` for callers that
 * present them (the chat tools' cap_eval), never in logs or partner responses.
 */
export class SendCapError extends Error {
  readonly evaluation: CapEvaluation;
  constructor(evaluation: CapEvaluation) {
    super('send_cap_exceeded');
    this.name = 'SendCapError';
    this.evaluation = evaluation;
  }
}

/**
 * Thrown by store.mintUnderSenderLock when the per-sender advisory lock could
 * not be taken within lock_timeout (SQLSTATE 55P03): another mint for the same
 * (partner, phone) is in flight. Retryable — nothing was written, and a
 * claim-first caller's bound id is still unminted, so a retry replays it.
 */
export class SendBusyError extends Error {
  readonly retryable = true as const;
  constructor() {
    super('send_busy');
    this.name = 'SendBusyError';
  }
}
