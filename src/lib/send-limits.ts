import type {
  CapEvaluation,
  EffectiveSendLimits,
  PartnerSendLimits,
  SendLimitOverride,
  SendLimits,
  SendLimitSource,
} from './types';

export type { SendLimits, PartnerSendLimits, SendLimitOverride, EffectiveSendLimits, SendLimitSource } from './types';

// send-limits (Program fix 16 / 16b) — the platform send ladder, the hard
// ceiling, and the per-sender resolver. PURE and types-only in its imports on
// purpose: the landing calculator ('use client', src/app/landing/RateCalculator.tsx)
// reads PLATFORM_SEND_LIMITS.maxUsd from here, and fx.ts reads the ceiling, so
// this module must never pull in fx.ts (→ rate.ts → log.ts) or anything
// server-side.
//
// The ladder is the one before #234: T0 $500/day for the 3-day observation
// window, T1 $2,999/day, $2,999 per transfer, MAX_USD 2999. There is NO env
// override. Above the ladder sits fix 16b's AUDITED platform-admin raise
// (per customer, per partner) — bounded by SEND_LIMIT_HARD_CEILING_CENTS, a
// frozen constant in code, never an env variable.

export const PLATFORM_SEND_LIMITS: Readonly<SendLimits> = Object.freeze({
  t0DailyCapCents: 50_000,      // $500.00/day during the 3-day observation window
  t1DailyCapCents: 299_900,     // $2,999.00/day once verified and past the window
  perTransferCapCents: 299_900, // $2,999.00 per transfer
  maxUsd: 2999,                 // the quote ceiling (fx.ts MAX_USD is pinned to this)
});

/**
 * The hard ceiling (Program fix 16b, owner decision 2026-09-21): no raise, at
 * any level, takes the per-transfer cap or the T1 daily cap above $10,000. A
 * stored value above it is clamped AT READ, so a hand-planted row can never
 * exceed it either. Code, not config — changing it is a one-constant PR.
 */
export const SEND_LIMIT_HARD_CEILING_CENTS = 1_000_000 as const;

/** A stored value counts only when it is a positive integer number of cents. */
function validCents(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

function isExpired(expiresAt: unknown, now: Date): boolean {
  if (typeof expiresAt !== 'string') return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

/** A stored entry is LIVE when it is an object and not past its expiresAt (an expired entry is skipped whole). */
function liveEntry<T extends SendLimitOverride>(raw: T | null | undefined, now: Date): T | null {
  return raw && typeof raw === 'object' && !isExpired(raw.expiresAt, now) ? raw : null;
}

/**
 * Resolve ONE field: the first valid value in precedence order (customer →
 * partner → platform), clamped to [1, ceiling]. Garbage falls through to the
 * next level; a value above the ceiling is clamped, never dropped.
 */
function pick(
  levels: ReadonlyArray<{ source: SendLimitSource; value: unknown }>,
  platform: number,
  ceiling: number,
): { value: number; source: SendLimitSource } {
  for (const l of levels) {
    const v = validCents(l.value);
    if (v !== null) return { value: Math.min(v, ceiling), source: l.source };
  }
  return { value: platform, source: 'platform' };
}

/**
 * The send limits that apply to ONE sender (Program fix 16b), per field:
 * the customer's override, else the partner's default, else the platform
 * ladder. An expired entry is skipped as a whole.
 *   • perTransferCapCents / t1DailyCapCents: raises up to
 *     SEND_LIMIT_HARD_CEILING_CENTS ($10,000), tightenings below the platform.
 *   • t0DailyCapCents: TIGHTEN-ONLY (the KYC tier gate is never raised): at most
 *     the platform $500, from the partner level only (a customer override never
 *     carries T0).
 *   • maxUsd: floor(perTransferCapCents / 100) — the quote ceiling follows the
 *     effective per-transfer cap.
 * `source` says where each figure came from (the admin card). The result is a
 * plain SendLimits structurally, so evaluateCap and the prompt take it as-is.
 *
 * A raise lifts ONLY these dollar caps: sanctions screening, EDD ($3,000/month)
 * and the tier gates (T0 for 3 days; Suspended at $0) are untouched by design.
 */
export function resolveEffectiveSendLimits(
  partner: { sendLimits?: PartnerSendLimits } | null | undefined,
  customer: { sendLimitOverride?: SendLimitOverride } | null | undefined,
  now: Date = new Date(),
): EffectiveSendLimits {
  const p = liveEntry(partner?.sendLimits, now);
  const c = liveEntry(customer?.sendLimitOverride, now);

  const perTransfer = pick(
    [{ source: 'customer', value: c?.perTransferCapCents }, { source: 'partner', value: p?.perTransferCapCents }],
    PLATFORM_SEND_LIMITS.perTransferCapCents,
    SEND_LIMIT_HARD_CEILING_CENTS,
  );
  const t1 = pick(
    [{ source: 'customer', value: c?.t1DailyCapCents }, { source: 'partner', value: p?.t1DailyCapCents }],
    PLATFORM_SEND_LIMITS.t1DailyCapCents,
    SEND_LIMIT_HARD_CEILING_CENTS,
  );
  const t0 = pick(
    [{ source: 'partner', value: p?.t0DailyCapCents }],
    PLATFORM_SEND_LIMITS.t0DailyCapCents,
    PLATFORM_SEND_LIMITS.t0DailyCapCents,
  );

  return {
    t0DailyCapCents: t0.value,
    t1DailyCapCents: t1.value,
    perTransferCapCents: perTransfer.value,
    maxUsd: Math.floor(perTransfer.value / 100),
    source: {
      perTransferCapCents: perTransfer.source,
      t1DailyCapCents: t1.source,
      t0DailyCapCents: t0.source,
    },
  };
}

/**
 * The ceiling a quote() caller passes for ONE sender (fix 16b, ruling 12
 * amended). It never sits BELOW the platform MAX_USD: a tightening is refused
 * by evaluateCap with the structured cap refusal every caller already maps
 * (422 / 'cap' / cap_eval — fix 16's contract), so the quote must not pre-empt
 * it with a QuoteError. A raise lifts it up to the effective per-transfer cap;
 * quote() clamps it to the $10,000 hard ceiling regardless.
 */
export function quoteCeilingUsd(limits: Pick<SendLimits, 'maxUsd'>): number {
  return Math.max(PLATFORM_SEND_LIMITS.maxUsd, limits.maxUsd);
}

// ── The admin action's edge check (fix 16b) ──────────────────────────────

export interface SendLimitForm {
  perTransferUsd: string;
  t1DailyUsd: string;
  t0DailyUsd: string;
  expiresAt: string;
  reason: string;
  clear: boolean;
}

export interface ValidatedSendLimitInput {
  /** The value to store: a partial override, or null on clear. */
  value: PartnerSendLimits | null;
  reason: string;
  expiresAt?: string;
}

export const SEND_LIMIT_REASON_MAX = 200;

/**
 * Bound a staff-typed reason before it is stored in audit_events: control
 * characters stripped, whitespace collapsed, trimmed. (Fix 5's shared
 * boundUntrustedText is not on this branch; this is the same discipline.)
 */
function boundReason(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole US dollars, > 0, <= maxUsd; '' ⇒ undefined (field not set). */
function wholeUsd(raw: string, label: string, maxUsd: number): number | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > maxUsd) {
    throw new Error(`${label} must be a whole dollar amount between $1 and $${maxUsd.toLocaleString('en-US')}.`);
  }
  return n * 100;
}

/**
 * Validate the raise form (the server action's FIRST step after the gate).
 * Order matters: the reason is required BEFORE anything else is inspected, so
 * a reason-less post never reads or writes. Limits are whole USD in
 * [1, $10,000]; T0 (partner form only) in [1, $500]. An expiry must be in the
 * future — a date-only value (the <input type="date"> shape) means the END of
 * that calendar day, UTC. `clear` stores null and ignores the figures.
 */
export function validateSendLimitInput(
  form: SendLimitForm,
  now: Date = new Date(),
  opts: { allowT0?: boolean } = {},
): ValidatedSendLimitInput {
  const reason = boundReason(form.reason);
  if (!reason) throw new Error('A reason is required.');
  if (reason.length > SEND_LIMIT_REASON_MAX) {
    throw new Error(`Reason must be ${SEND_LIMIT_REASON_MAX} characters or fewer.`);
  }
  if (form.clear) return { value: null, reason };

  const perTransferCapCents = wholeUsd(form.perTransferUsd, 'Per-transfer limit', SEND_LIMIT_HARD_CEILING_CENTS / 100);
  const t1DailyCapCents = wholeUsd(form.t1DailyUsd, 'Daily limit', SEND_LIMIT_HARD_CEILING_CENTS / 100);
  const t0DailyCapCents = opts.allowT0
    ? wholeUsd(form.t0DailyUsd, 'First-3-days daily limit', PLATFORM_SEND_LIMITS.t0DailyCapCents / 100)
    : undefined;
  if (perTransferCapCents === undefined && t1DailyCapCents === undefined && t0DailyCapCents === undefined) {
    throw new Error('Enter at least one limit.');
  }

  let expiresAt: string | undefined;
  const rawExpiry = form.expiresAt.trim();
  if (rawExpiry !== '') {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawExpiry);
    const t = Date.parse(dateOnly ? `${rawExpiry}T23:59:59.999Z` : rawExpiry);
    if (!Number.isFinite(t)) throw new Error('Expiry must be a valid date.');
    if (t <= now.getTime()) throw new Error('Expiry must be in the future.');
    expiresAt = new Date(t).toISOString();
  }

  const value: PartnerSendLimits = {};
  if (perTransferCapCents !== undefined) value.perTransferCapCents = perTransferCapCents;
  if (t1DailyCapCents !== undefined) value.t1DailyCapCents = t1DailyCapCents;
  if (t0DailyCapCents !== undefined) value.t0DailyCapCents = t0DailyCapCents;
  if (expiresAt) value.expiresAt = expiresAt;
  return { value, reason, expiresAt };
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
