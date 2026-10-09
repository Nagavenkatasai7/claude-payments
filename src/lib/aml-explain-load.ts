import type { DbOrTx } from '@/db/client';
import { createAuditRepo, type AuditRow } from '@/db/repos/aux-repos';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { AML_HOLD_REASON, amlHoldHit } from '@/lib/aml-hold';
import { logWarn } from '@/lib/log';
import type { AmlHit, AmlRuleConfig } from '@/lib/aml-rules';
import type { PurposeHoldFact } from '@/lib/aml-explain-ai';
import { PURPOSE_RISK_CATEGORIES, type PurposeRiskCategory } from '@/lib/purpose-detail';
import type { PartnerId, Transfer } from '@/lib/types';

// A4: the READS behind the AML explain copilot, shared by the platform route
// (/api/copilot/aml-explain) and the partner action. Read-only: the transfer's
// aml.alert rows (tenant-pinned), its corridor's AML thresholds, and, for a
// row the AML hold held with no alert yet (the sweep writes alerts >= 2 min
// after the mint), the in-mint rules re-run on the sender's ledger. A row the
// purpose check held (a purpose.flag row) is NOT re-run: that hold reuses the
// generic AML reason, and the AML rules never held it (security review L1).

const DAY_MS = 86_400_000;

export interface AmlExplainContext {
  alerts: AuditRow[];
  cfg: AmlRuleConfig;
  recomputed: AmlHit | null;
  /** The transfer has a purpose.flag row (the scam-pattern purpose check flagged it), else null. */
  purposeHold: PurposeHoldFact | null;
  /** In review, or at least one aml.alert row. */
  eligible: boolean;
}

export async function loadAmlExplainContext(
  db: DbOrTx,
  t: Transfer,
  tenant: PartnerId,
  now: Date = new Date(),
): Promise<AmlExplainContext> {
  const created = Date.parse(t.createdAt);
  const from = new Date((Number.isFinite(created) ? created : 0) - DAY_MS);
  const history = await createAuditRepo(db).listBySubject(tenant, t.id, from, new Date(now.getTime() + 60_000));
  const alerts = history.filter((a) => a.action === 'aml.alert' && a.partnerId === tenant);
  const eligible = t.status === 'in_review' || alerts.length > 0;
  const flag = history.find((a) => a.action === 'purpose.flag' && a.partnerId === tenant);
  const flagged = flag?.meta.category;
  const purposeHold: PurposeHoldFact | null = flag
    ? { category: (PURPOSE_RISK_CATEGORIES as readonly unknown[]).includes(flagged) ? (flagged as PurposeRiskCategory) : null }
    : null;

  const rules = resolveCorridorRules(await createPartnerRepo(db).getPartner(t.partnerId), t.sourceCountry);
  const cfg: AmlRuleConfig = { ...rules.aml, largeAmountUsd: rules.largeAmountUsd };

  let recomputed: AmlHit | null = null;
  // Only a row the in-mint AML hold actually held: re-running the rules on a
  // sanctions or identity hold would name a rule that never held it.
  if (eligible && alerts.length === 0 && !purposeHold && t.complianceReasons.includes(AML_HOLD_REASON)) {
    try {
      const prior = await createTransferRepo(db).senderAmlStats(
        t.partnerId, t.phone, { at: new Date(t.createdAt), id: t.id }, cfg.largeAmountUsd, cfg.band,
      );
      recomputed = amlHoldHit(prior, t.amountUsd, cfg);
    } catch (err) {
      // No recomputed facts; the explanation still covers the hold reasons.
      logWarn('aml.explain.recompute', err instanceof Error ? err.name : 'error', { transferId: t.id });
    }
  }
  return { alerts, cfg, recomputed, eligible, purposeHold };
}
