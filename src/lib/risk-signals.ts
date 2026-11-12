import { DEFAULT_PARTNER_ID } from './defaults';
import type { PriorSends } from '@/db/repos/transfer-repo';
import type { PartnerId, TransferEnvironment } from './types';

// Fix pack 6 (R48, P18) — deterministic risk signals on a customer send.
//
// Pure: no I/O and no clock read (`now` is a fact the caller passes). It never
// logs or stores a matched word (P0 rule 5): the chat cue arrives here as a
// boolean, computed by the SERVER-only src/lib/risk-chat-cue.ts.
//
// CLIENT-SAFE (P0 rule 13): no runtime import except DEFAULT_PARTNER_ID from
// ./defaults (itself type-only), so compliance-config may import it (T22) and
// the admin risk-signals form may read RISK_SIGNALS (T23). Keep it that way:
// tests/client-import-chain.test.ts and tests/risk-signals.test.ts fail on a
// new runtime import.
//
// Off by default everywhere (RISK_SIGNALS_OFF); never applies to the default
// tenant, sandbox ('test') rows or b2b (riskSignalsApply).

export const RISK_SIGNALS = Object.freeze([
  'first_to_recipient',
  'first_transfer',
  'new_account',
  'amount_over_threshold',
  'chat_cue',
] as const);
export type RiskSignal = (typeof RISK_SIGNALS)[number];

export function isRiskSignal(v: unknown): v is RiskSignal {
  return typeof v === 'string' && (RISK_SIGNALS as readonly string[]).includes(v);
}

/** One corridor's risk-signal setting (resolved shape; T22 resolves the stored jsonb into it). */
export interface RiskSignalConfig {
  enabled: boolean;
  /** amount_over_threshold fires at or above this many USD. */
  amountUsd: number;
  /** new_account fires while the customer was first seen less than this many hours ago. */
  newAccountHours: number;
  /** The signals that hold the transfer for review at the mint (T25). */
  hold: readonly RiskSignal[];
}

export const RISK_SIGNALS_OFF: RiskSignalConfig = Object.freeze({
  enabled: false,
  amountUsd: 500,
  newAccountHours: 72,
  hold: Object.freeze([]) as readonly RiskSignal[],
});

export interface RiskSignalFacts {
  amountUsd: number;
  /** Paid or delivered prior sends (P14); null when the read failed (neither sends signal fires). */
  sends: PriorSends | null;
  /** ISO time the customer was first seen; null when unknown. */
  firstSeenAt: string | null;
  now: Date;
  chatCue: boolean;
}

/** Risk signals run only when the corridor turned them on, never for the default tenant, 'test' rows or b2b. */
export function riskSignalsApply(i: {
  cfg: RiskSignalConfig;
  partnerId: PartnerId;
  environment?: TransferEnvironment;
  transferType?: 'b2c' | 'b2b';
}): boolean {
  return (
    i.cfg.enabled === true &&
    i.partnerId !== DEFAULT_PARTNER_ID &&
    i.environment !== 'test' &&
    i.transferType !== 'b2b'
  );
}

/** The signals the facts raise under `cfg`, in RISK_SIGNALS order; [] when the config is off. */
export function evaluateRiskSignals(f: RiskSignalFacts, cfg: RiskSignalConfig): RiskSignal[] {
  if (!cfg.enabled) return [];
  const set = new Set<RiskSignal>();
  if (f.sends?.toRecipient === 0) set.add('first_to_recipient');
  if (f.sends?.total === 0) set.add('first_transfer');
  if (f.firstSeenAt !== null) {
    const t = Date.parse(f.firstSeenAt);
    if (Number.isFinite(t) && f.now.getTime() - t < cfg.newAccountHours * 3_600_000) set.add('new_account');
  }
  if (f.amountUsd >= cfg.amountUsd) set.add('amount_over_threshold');
  if (f.chatCue === true) set.add('chat_cue');
  return RISK_SIGNALS.filter((s) => set.has(s));
}

/** True when a warning was shown and the customer's tick is not a literal true. */
export function riskAckMissing(shown: readonly RiskSignal[], acked: unknown): boolean {
  return shown.length > 0 && acked !== true;
}
