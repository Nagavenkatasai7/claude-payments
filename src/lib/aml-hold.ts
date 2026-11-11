// aml-hold — Program-Fix 43 (PR B) and fix pack 6 (P16): the OPTIONAL
// per-partner × corridor AML hold, as pure decisions. mintLocked
// (transfer-create.ts) is the only caller of the gate and the rules.
//
// Owner decision (binding): the behavioural AML rules raise ALERTS and REVIEW
// ITEMS only (aml-sweep.ts). A hard hold comes ONLY from the per-partner ×
// corridor switch partners.corridor_compliance[<country>].amlHolds (OFF unless
// it is the literal `true`, compliance-config.ts) with at least one rule in
// its amlHoldRules, and only on REAL MONEY (`p.realMoney`, live-gate.ts
// realMoneyRail: a live transfer on an http rail, a failed rail read counting
// as real). A demo transfer is NEVER held. "Demo" is structural:
//   • the default tenant (the shared demo bot) — as the owning partner OR as
//     the routed settlement partner — can never pass amlHoldGate, whatever
//     its stored jsonb says (setAmlHoldsAction also refuses to write it);
//   • a mock or simulator rail, or a sandbox ('test') transfer, is not real
//     money and can never pass amlHoldGate.
// A hold adds ONE generic reason to a cleared or flagged verdict and nothing
// else (addHoldReason, fix pack 6 P15): a cleared row becomes flagged, a
// flagged row keeps its own reasons and gains this one, so the strictest
// release authority wins. Never a downgrade; a blocked verdict is never touched
// (it stays the sanctions path's); the reason never names the rule (no
// tipping off — complianceReasons can reach the customer's status view).
// Fail closed (P16): on real money a check that cannot run HOLDS the row.

import { AML_HOLD_REASON } from './compliance-config';
import { DEFAULT_PARTNER_ID } from './defaults';
import { AML_HOLD_RULES, firstTransfer, structuring, type AmlHit, type AmlHoldRule, type AmlRuleConfig, type SenderAmlStats } from './aml-rules';
import type { PriorSends } from '@/db/repos/transfer-repo';
import type { ComplianceStatus, CorridorComplianceRule, PartnerId } from './types';

/** The only reason a hold adds. Deliberately generic (no rule name). Lives in the registry (compliance-config.ts). */
export { AML_HOLD_REASON };
// Fix pack 6 (P13): the closed in-mint hold rule list (defined in the pure aml-rules.ts).
export { AML_HOLD_RULES, isAmlHoldRule, type AmlHoldRule } from './aml-rules';

/**
 * The pre-read gate. False ⇒ mintLocked runs ZERO extra statements (no
 * savepoint, no ledger read): not real money, the setting is OFF (the mint
 * passes `amlHolds` false also when the corridor has no rule), the transfer
 * is demo (default tenant on either side), or the verdict is already
 * `blocked` (nothing a hold could add). A flagged verdict still runs: it
 * gains the generic reason too (fix pack 6 P16).
 */
export function amlHoldGate(p: {
  realMoney: boolean;
  amlHolds: boolean;
  partnerId: PartnerId;
  railPartnerId: PartnerId;
  complianceStatus: ComplianceStatus;
}): boolean {
  return (
    p.realMoney === true &&
    p.amlHolds === true &&
    p.partnerId !== DEFAULT_PARTNER_ID &&
    p.railPartnerId !== DEFAULT_PARTNER_ID &&
    p.complianceStatus !== 'blocked'
  );
}

/**
 * Fix pack 6 (P16): the in-mint rules, limited to the corridor's `rules`.
 * Structuring runs on the ledger stats; first_transfer and new_beneficiary run
 * on the sender's prior PAID/DELIVERED live sends (`sends`, transfer-repo
 * priorSends), so unpaid rows no longer count as history. A first-ever send is
 * first_transfer only; new_beneficiary needs the recipient phone
 * (`toRecipient` null = unknown ⇒ no verdict). Hits in rule order.
 */
export function amlHoldHits(i: {
  stats: SenderAmlStats;
  sends: PriorSends;
  amountUsd: number;
  cfg: AmlRuleConfig;
  rules: readonly AmlHoldRule[];
}): AmlHit[] {
  const out: AmlHit[] = [];
  const on = (r: string) => (i.rules as readonly string[]).includes(r);
  if (on('structuring')) {
    const s = structuring(i.stats, i.amountUsd, i.cfg);
    if (s) out.push(s);
  }
  const newDestination = i.sends.toRecipient === null ? null : i.sends.toRecipient === 0;
  const f = firstTransfer({ ...i.stats, priorCount: i.sends.total }, i.amountUsd, newDestination, i.cfg);
  if (f && on(f.rule)) out.push(f);
  return out;
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

/**
 * Fix pack 6 (P13 "no entry"): neither `amlHolds` nor `amlHoldRules` is stored
 * for the corridor (whatever their values). The go-live default (T20) writes
 * only such corridors, so a partner's or the platform's choice is never
 * overwritten; the platform switch OFF deletes both keys to return here.
 */
export function hasAmlHoldEntry(e: CorridorComplianceRule | undefined): boolean {
  return e !== undefined && (Object.hasOwn(e, 'amlHolds') || Object.hasOwn(e, 'amlHoldRules'));
}

/**
 * Fix pack 6 (P17): the partner rule writer's next corridor entry. A non-empty
 * list -> `amlHolds: true` + the list; an empty list -> `amlHolds` DELETED and
 * `amlHoldRules: []` stored (never `amlHolds: false`: an older build ignores
 * the list and reads only `amlHolds`, so a deleted key is "off" for every
 * build, while the stored `[]` keeps the corridor out of "no entry" so the
 * go-live default never turns it back on). Every other key is kept; `prev` is
 * not mutated. `rules` are already validated and canonical (the action's parse).
 */
export function amlHoldRulesEntry(
  prev: CorridorComplianceRule | undefined,
  rules: readonly AmlHoldRule[],
): CorridorComplianceRule {
  const entry: CorridorComplianceRule = { ...(prev ?? {}) };
  if (rules.length > 0) {
    entry.amlHolds = true;
  } else {
    delete entry.amlHolds;
  }
  entry.amlHoldRules = [...rules];
  return entry;
}

/**
 * Fix pack 6 (P13): the admin compliance page's label for a corridor's
 * RESOLVED rules (resolveCorridorRules): 'Off', 'On: all rules' or
 * 'On: <rule>, <rule>' (ids with '_' read as spaces). Inline staff English
 * (P20). 'On: no rules' only for a hand-written jsonb: neither writer stores
 * holds on with an empty list.
 */
export function amlHoldRulesSummary(on: boolean, rules: readonly AmlHoldRule[]): string {
  if (!on) return 'Off';
  if (rules.length === 0) return 'On: no rules';
  if (AML_HOLD_RULES.every((r) => rules.includes(r))) return 'On: all rules';
  return `On: ${rules.map((r) => r.replace(/_/g, ' ')).join(', ')}`;
}
