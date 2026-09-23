// aml-rules — Program-Fix 43 (PR A): the behavioural AML rules as PURE
// functions (no I/O, no clock). The worker's amlSweep (aml-sweep.ts) feeds
// them ledger aggregates and Redis set sizes and turns each hit into an ops
// alert + an `aml.alert` audit row.
//
// Owner decision (binding): these rules raise ALERTS and REVIEW ITEMS only.
// A hit never touches complianceStatus / complianceReasons (a 'flagged' row is
// a hard hold at pay: settlement.ts settleOrHold), and never reaches the
// customer, the bot or the partner API.
//
// Structuring is RISING-EDGE: it fires on the transfer that turns the pattern
// true (evaluated on the sender's rows strictly BEFORE this one, then with this
// one added), not on every later transfer of the same run — one episode, one
// alert. The windows are anchored on the transfer's own createdAt, so a
// re-scan evaluates the same inputs and the per-transfer dedupe key absorbs it.

/** Tunables. Overridable per partner × corridor in partners.corridor_compliance (jsonb). */
export interface AmlConfig {
  band: number;     // structuring band lower edge as a fraction of largeAmountUsd
  count: number;    // in-band sends within 7 days that count as structuring
  aggUsd: number;   // 30-day sum of sub-threshold sends that counts as structuring
  firstUsd: number; // first-ever / first-to-this-destination amount that alerts
  senders: number;  // distinct senders to one destination within 30 days
}

export const AML_DEFAULTS: AmlConfig = {
  band: 0.8,
  count: 3,
  aggUsd: 3000,
  firstUsd: 500,
  senders: 3,
};

/** The rules also need the corridor's large-amount threshold (T). */
export type AmlRuleConfig = AmlConfig & { largeAmountUsd: number };

/**
 * One sender's ledger aggregates over rows STRICTLY BEFORE the transfer under
 * test (tuple order (created_at, id)), excluding blocked and cancelled rows.
 */
export interface SenderAmlStats {
  bandCount7d: number;      // sends in [band·T, T) within the 7 days before
  subTSumCents30d: number;  // Σ amount_usd (cents) of sends < T within the 30 days before
  priorCount: number;       // all-time earlier sends
}

export type AmlRule = 'structuring' | 'first_transfer' | 'new_beneficiary' | 'cluster';

export interface AmlHit {
  rule: AmlRule;
  window: '7d' | '30d' | 'first' | 'destination';
  count: number;
  sumUsd: number;
}

const cents = (usd: number) => Math.round(usd * 100);

function inBand(amountUsd: number, cfg: AmlRuleConfig): boolean {
  const T = cfg.largeAmountUsd;
  return amountUsd >= cfg.band * T && amountUsd < T;
}

/** R1 — structuring. Rising edge of (7-day band count ≥ count) OR (30-day sub-T Σ ≥ aggUsd). */
export function structuring(prior: SenderAmlStats, amountUsd: number, cfg: AmlRuleConfig): AmlHit | null {
  if (amountUsd >= cfg.largeAmountUsd) return null; // the existing large-amount flag owns these
  const aggCents = cents(cfg.aggUsd);
  const wasBand = prior.bandCount7d >= cfg.count;
  const wasAgg = prior.subTSumCents30d >= aggCents;
  if (wasBand || wasAgg) return null;

  const bandAfter = prior.bandCount7d + (inBand(amountUsd, cfg) ? 1 : 0);
  const sumAfter = prior.subTSumCents30d + cents(amountUsd);
  if (bandAfter >= cfg.count) {
    return { rule: 'structuring', window: '7d', count: bandAfter, sumUsd: sumAfter / 100 };
  }
  if (sumAfter >= aggCents) {
    return { rule: 'structuring', window: '30d', count: prior.priorCount + 1, sumUsd: sumAfter / 100 };
  }
  return null;
}

/**
 * R2 — first-transfer checks. First-ever send ≥ firstUsd, else a send ≥
 * firstUsd to a destination this sender never used. `newDestination` null =
 * unknown (Redis down, or the per-sender set was being seeded) → no
 * new_beneficiary verdict.
 */
export function firstTransfer(
  prior: SenderAmlStats,
  amountUsd: number,
  newDestination: boolean | null,
  cfg: AmlRuleConfig,
): AmlHit | null {
  if (amountUsd < cfg.firstUsd) return null;
  if (prior.priorCount === 0) {
    return { rule: 'first_transfer', window: 'first', count: 1, sumUsd: amountUsd };
  }
  if (newDestination === true) {
    return { rule: 'new_beneficiary', window: 'destination', count: prior.priorCount + 1, sumUsd: amountUsd };
  }
  return null;
}

/** R3 — beneficiary clustering: ≥ senders distinct senders to one destination in 30 days. */
export function cluster(distinctSenders: number, cfg: AmlConfig): AmlHit | null {
  if (distinctSenders < cfg.senders) return null;
  return { rule: 'cluster', window: '30d', count: distinctSenders, sumUsd: 0 };
}
