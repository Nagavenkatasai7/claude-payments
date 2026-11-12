import type { Tx } from '@/db/client';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { AML_HOLD_RULES, amlHoldRulesEntry, hasAmlHoldEntry, type AmlHoldRule } from '@/lib/aml-hold';
import { resolveAmlHoldRules } from '@/lib/compliance-config';
import type { LiveActor } from '@/lib/live-controls-write';
import type { CountryCode, PartnerId } from '@/lib/types';

// Fix pack 6 T20 (P17, P21, owner Q-R47.3) and review round 1 RD2: the AML
// hold default for a certified partner's corridors, shared by the certify
// action (reason 'go_live_default', go-live-actions.ts) and by a corridor
// added to a certified partner later (reason 'corridor_added_default',
// updatePartnerAction). A plain server module: the two callers are "use server"
// files, which may export only server actions.

/** Why the default ran (the aml.hold_rules_set row's `reason`, a closed enum). */
export type AmlHoldDefaultReason = 'go_live_default' | 'corridor_added_default';

/**
 * On the caller's transaction handle. Every listed corridor except IN (corridor
 * rules never apply to an India source: resolveCorridorRules) that has NO AML
 * entry (hasAmlHoldEntry: neither amlHolds nor amlHoldRules stored) gets holds
 * ON with all three rules, other keys kept; explicit entries (an explicit off
 * or an empty partner list included) are never touched. One
 * aml.hold_rules_set row per defaulted corridor (from/to are RESOLVED lists;
 * meta: ids, the country code, rule names, actorScope and the reason only).
 * Always runs one updateCorridorCompliance (FOR UPDATE; the previous value is
 * written back unchanged when nothing is defaulted). A throw rolls the
 * caller's transaction back. Returns the defaulted corridors.
 */
export async function writeAmlHoldDefaults(
  tx: Tx,
  id: PartnerId,
  countries: readonly CountryCode[],
  actor: LiveActor,
  reason: AmlHoldDefaultReason,
): Promise<CountryCode[]> {
  const defaulted: { country: CountryCode; from: AmlHoldRule[] }[] = [];
  const { found } = await createPartnerRepo(tx).updateCorridorCompliance(id, (prev) => {
    const next = { ...prev };
    for (const c of countries) {
      if (c === 'IN' || hasAmlHoldEntry(prev[c]) || defaulted.some((d) => d.country === c)) continue;
      next[c] = amlHoldRulesEntry(prev[c], AML_HOLD_RULES);
      defaulted.push({ country: c, from: [...resolveAmlHoldRules(prev[c]?.amlHolds === true, prev[c]?.amlHoldRules)] });
    }
    return defaulted.length > 0 ? next : prev;
  });
  if (!found) throw new Error('partner row vanished under the lock');
  const audit = createAuditRepo(tx);
  for (const d of defaulted) {
    await audit.record({
      partnerId: id,
      actor: actor.username,
      actorType: 'staff',
      action: 'aml.hold_rules_set',
      subjectId: id,
      meta: { country: d.country, from: d.from, to: [...AML_HOLD_RULES], actorScope: actor.scope, reason },
    });
  }
  return defaulted.map((d) => d.country);
}
