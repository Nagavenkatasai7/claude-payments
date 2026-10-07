import type { DbOrTx } from '@/db/client';
import { createAuditRepo, type AuditRow } from '@/db/repos/aux-repos';
import { createPartnerRepo } from '@/db/repos/partner-repo';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { resolveCorridorRules } from '@/lib/compliance-config';
import { amlHoldHit } from '@/lib/aml-hold';
import { logWarn } from '@/lib/log';
import type { AmlHit, AmlRuleConfig } from '@/lib/aml-rules';
import type { PartnerId, Transfer } from '@/lib/types';

// A4: the READS behind the AML explain copilot, shared by the platform route
// (/api/copilot/aml-explain) and the partner action. Read-only: the transfer's
// aml.alert rows (tenant-pinned), its corridor's AML thresholds, and, for a
// held row with no alert yet (the sweep writes alerts >= 2 min after the
// mint), the in-mint rules re-run on the sender's ledger.

const DAY_MS = 86_400_000;

export interface AmlExplainContext {
  alerts: AuditRow[];
  cfg: AmlRuleConfig;
  recomputed: AmlHit | null;
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

  const rules = resolveCorridorRules(await createPartnerRepo(db).getPartner(t.partnerId), t.sourceCountry);
  const cfg: AmlRuleConfig = { ...rules.aml, largeAmountUsd: rules.largeAmountUsd };

  let recomputed: AmlHit | null = null;
  if (eligible && alerts.length === 0) {
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
  return { alerts, cfg, recomputed, eligible };
}
