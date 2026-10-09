'use server';

import { requirePartnerStaff } from '@/lib/auth';
import { refuseOnSiteHost } from '@/lib/site-host-guard';
import { PARTNER_ADMIN } from '@/lib/partner-access';
import { getDb } from '@/db/client';
import { createTransferRepo } from '@/db/repos/transfer-repo';
import { createAuditRepo } from '@/db/repos/aux-repos';
import { getRedis } from '@/lib/redis';
import { checkCopilotRateLimit } from '@/lib/ticket-ai';
import {
  amlExplainFallback,
  buildAmlExplainBundle,
  explainAml,
  type AmlExplainFacts,
  type AmlExplanation,
} from '@/lib/aml-explain-ai';
import { loadAmlExplainContext } from '@/lib/aml-explain-load';
import { isTransferId } from '@/lib/partner-transfers';
import { t } from '@/lib/i18n';
import { logWarn } from '@/lib/log';
import type { ActionResult } from '../../../action-result';

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'error');

/** ActionResult's refusal arm, or the explanation (facts are the D5 partner bundle). */
export type AmlExplainActionResult =
  | { ok: true; source: 'ai' | 'fallback'; facts: AmlExplainFacts; explanation: AmlExplanation }
  | Extract<ActionResult, { ok: false }>;

/**
 * Explain why one of THIS tenant's transfers raised an AML alert or sits in review (A4). READ-ONLY.
 *  1. the partner-site host guard, then the PARTNER_ADMIN gate (owner D5: AML is admin only),
 *     outside any try;
 *  2. the id (untrusted form field) is shape-checked and resolved INSIDE the session tenant
 *     (getOwnedTransfer, the masked read): a missing id, another tenant's id and a transfer with
 *     neither a hold nor an alert are the SAME not-found result, and nothing is written;
 *  3. the D5 PARTNER facts: the rule label only, never the alert's count, amount sum or window, nor
 *     the corridor thresholds;
 *  4. the shared copilot budget (fails open; over budget ⇒ the deterministic explanation);
 *  5. ONE `copilot.aml_explain` audit row under the SESSION tenant before anything is returned.
 * It never changes the transfer or the alert and writes no outbox row. The action is not on the
 * partner timeline (TIMELINE_AUDIT_ACTIONS is an allow-list).
 */
export async function explainAmlAction(formData: FormData): Promise<AmlExplainActionResult> {
  await refuseOnSiteHost();
  const ctx = await requirePartnerStaff(PARTNER_ADMIN);
  const notFound = { ok: false as const, error: t('partner.common.notFound') };

  const id = formData.get('id');
  if (!isTransferId(id)) return notFound;
  try {
    const db = getDb();
    const transfer = await createTransferRepo(db).getOwnedTransfer(ctx.partnerId, id);
    if (!transfer || transfer.partnerId !== ctx.partnerId) return notFound;
    const now = new Date();
    const loaded = await loadAmlExplainContext(db, transfer, ctx.partnerId, now);
    if (!loaded.eligible) return notFound;

    let withinBudget = true;
    try {
      withinBudget = await checkCopilotRateLimit(getRedis(), ctx.username);
    } catch {
      /* fail-open */
    }
    const facts = buildAmlExplainBundle(transfer, loaded.alerts, loaded.cfg, 'partner', now.getTime(), loaded.recomputed, loaded.purposeHold);
    let source: 'ai' | 'fallback' = 'fallback';
    let explanation = amlExplainFallback(facts);
    if (withinBudget) {
      try {
        explanation = await explainAml(facts);
        source = 'ai';
      } catch (err) {
        logWarn('partner.aml.explain', errName(err), { partnerId: ctx.partnerId });
      }
    }
    await createAuditRepo(db).record({
      partnerId: ctx.partnerId,
      actor: ctx.username,
      actorType: 'staff',
      action: 'copilot.aml_explain',
      subjectId: transfer.id,
      meta: { source, rules: facts.rules.map((r) => r.rule), audience: 'partner' },
    });
    return { ok: true, source, facts, explanation };
  } catch (err) {
    logWarn('partner.aml.explain', errName(err), { partnerId: ctx.partnerId });
    return { ok: false, error: t('partner.common.failed') };
  }
}
