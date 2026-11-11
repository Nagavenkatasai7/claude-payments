// aml-hold — Program-Fix 43 (PR B): the OPTIONAL per-partner AML hold, as pure
// decisions. mintLocked (transfer-create.ts) is the only caller.
//
// Owner decision (binding): the behavioural AML rules raise ALERTS and REVIEW
// ITEMS only (aml-sweep.ts). A hard hold comes ONLY from the per-partner ×
// corridor switch partners.corridor_compliance[<country>].amlHolds, which is
// OFF unless it is the literal `true` (compliance-config.ts), and a demo
// transfer is NEVER held. "Demo" is structural, not a default value:
//   • the default tenant (the shared demo bot) — as the owning partner OR as
//     the routed settlement partner — can never pass amlHoldGate, whatever
//     its stored jsonb says (setAmlHoldsAction also refuses to write it);
//   • any rail that is not a real `http` rail (mock, simulator: every demo
//     partner) can never pass amlHoldRailEligible.
// A hold adds ONE generic reason to a cleared or flagged verdict and nothing
// else (addHoldReason, fix pack 6 P15): a cleared row becomes flagged, a
// flagged row keeps its own reasons and gains this one, so the strictest
// release authority wins (a scam-pattern row flagged for amount is no longer
// partner-releasable). Never a downgrade; a blocked verdict is never touched
// (it stays the sanctions path's); the reason never names the rule (no
// tipping off — complianceReasons can reach the customer's status view).

import { AML_HOLD_REASON } from './compliance-config';
import { DEFAULT_PARTNER_ID } from './defaults';
import { firstTransfer, structuring, type AmlHit, type AmlRuleConfig, type SenderAmlStats } from './aml-rules';
import type { ComplianceStatus, PartnerId } from './types';

/** The only reason a hold adds. Deliberately generic (no rule name). Lives in the registry (compliance-config.ts). */
export { AML_HOLD_REASON };
// Fix pack 6 (P13): the closed in-mint hold rule list (defined in the pure aml-rules.ts).
export { AML_HOLD_RULES, isAmlHoldRule, type AmlHoldRule } from './aml-rules';

/**
 * The pre-read gate. False ⇒ mintLocked runs ZERO extra statements (no
 * savepoint, no rail read, no stats read): the setting is OFF, the transfer is
 * demo (default tenant on either side), or the verdict is already not
 * `cleared` (nothing a hold could add).
 */
export function amlHoldGate(p: {
  amlHolds: boolean;
  partnerId: PartnerId;
  railPartnerId: PartnerId;
  complianceStatus: ComplianceStatus;
}): boolean {
  return (
    p.amlHolds === true &&
    p.partnerId !== DEFAULT_PARTNER_ID &&
    p.railPartnerId !== DEFAULT_PARTNER_ID &&
    p.complianceStatus === 'cleared'
  );
}

/** Only a real `http` rail can hold. Mock and simulator rails are demo. */
export function amlHoldRailEligible(railProviderType: string | null | undefined): boolean {
  return railProviderType === 'http';
}

/**
 * The in-mint rules: R1 (structuring) and R2 (first-ever transfer). R2b
 * (new beneficiary) needs the sender's destination history and R3 (clustering)
 * is cross-sender: both stay sweep-only alerts, so `newDestination` is null.
 */
export function amlHoldHit(prior: SenderAmlStats, amountUsd: number, cfg: AmlRuleConfig): AmlHit | null {
  return structuring(prior, amountUsd, cfg) ?? firstTransfer(prior, amountUsd, null, cfg);
}

type Verdict = { complianceStatus: ComplianceStatus; complianceReasons: string[] };

/**
 * Fix pack 6 (P15): the ONE hold verdict. Blocked is returned as the same
 * object; anything else becomes flagged with AML_HOLD_REASON appended once
 * (never duplicated; the other reasons keep their order). Always a new object
 * otherwise. Pure.
 */
export function addHoldReason<V extends Verdict>(v: V): V {
  if (v.complianceStatus === 'blocked') return v;
  const reasons = v.complianceReasons.includes(AML_HOLD_REASON)
    ? [...v.complianceReasons]
    : [...v.complianceReasons, AML_HOLD_REASON];
  return { ...v, complianceStatus: 'flagged', complianceReasons: reasons };
}

/** A hit adds the generic reason (addHoldReason: cleared or flagged → flagged, blocked untouched); no hit ⇒ `v` itself. */
export function applyAmlHold<V extends Verdict>(v: V, hit: AmlHit | null): V {
  return hit ? addHoldReason(v) : v;
}

/**
 * Batch B follow-up A4: the purpose hold. A reason that matches a scam pattern
 * (purpose-detail.ts) takes the SAME verdict path as the AML hold
 * (addHoldReason): a cleared or flagged verdict becomes flagged with the
 * generic AML_HOLD_REASON added once (no tipping off; a flagged row keeps its
 * own reasons, fix pack 6 P15), never a downgrade, never touches blocked.
 * Unlike the AML hold it has no gate: OWNER
 * DECISION 2026-10-08, it applies to EVERY partner, the default (demo) tenant
 * and simulator rails included, so the owner can test it.
 */
export function applyPurposeHold<V extends Verdict>(v: V, risk: string | undefined): V {
  return risk ? addHoldReason(v) : v;
}
